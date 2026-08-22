import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeTestEnv } from './helpers.js';
import { tasks } from '../src/db/schema.js';
import { Scheduler } from '../src/scheduler.js';
import type { Orchestrator } from '../src/orchestrator.js';
import type { PushService } from '../src/push.js';

describe('予約タスク', () => {
  it('tasks.create → list → cancel', async () => {
    const env = makeTestEnv();
    const runAt = new Date(Date.now() + 3600_000).toISOString();
    const created = await env.registry.execute(
      'tasks.create',
      {
        title: '帰宅前の冷房',
        run_at: runAt,
        plan: [{ tool: 'home.execute', input: { entity_id: 'climate.living', service: 'turn_on' } }],
        reevaluate: true,
        intent_text: '19時に帰るから快適にしといて',
      },
      env.ctx,
    );
    expect(created.ok).toBe(true);

    const list = await env.registry.execute('tasks.list', { status: 'scheduled' }, env.ctx);
    expect(list.ok).toBe(true);
    const items = list.data as Array<{ id: string; title: string; reevaluate: boolean }>;
    expect(items).toHaveLength(1);
    expect(items[0].reevaluate).toBe(true);

    const cancel = await env.registry.execute('tasks.cancel', { id: items[0].id }, env.ctx);
    expect(cancel.ok).toBe(true);
    const after = env.db.select().from(tasks).where(eq(tasks.id, items[0].id)).get();
    expect(after?.status).toBe('canceled');
  });

  it('不正な日時は拒否される', async () => {
    const env = makeTestEnv();
    const result = await env.registry.execute(
      'tasks.create',
      { title: 'x', run_at: 'not-a-date', plan: [{ tool: 'home.execute', input: {} }] },
      env.ctx,
    );
    expect(result.ok).toBe(false);
  });

  it('scheduler tick が期限到来タスクを実行し done にする', async () => {
    const env = makeTestEnv();
    const past = new Date(Date.now() - 60_000).toISOString();
    await env.registry.execute(
      'tasks.create',
      { title: '即時実行テスト', run_at: past, plan: [{ tool: 'home.execute', input: { entity_id: 'light.living', service: 'turn_on' } }] },
      env.ctx,
    );
    env.ha.states.set('light.living', { entity_id: 'light.living', state: 'off', attributes: {} });

    // reevaluate=0 なので orchestrator.runScheduledTask はプラン直接実行に相当する動きをスタブ
    const orchestrator = {
      runScheduledTask: async (params: { plan: Array<{ tool: string; input: Record<string, unknown> }> }) => {
        for (const call of params.plan) {
          await env.registry.execute(call.tool, call.input, { ...env.ctx, source: 'scheduled' });
        }
        return { ok: true, summary: 'done' };
      },
    } as unknown as Orchestrator;

    const push = {
      notify: async (_u: string, _s: unknown, level: string, title: string) => {
        env.notifications.push({ level, title });
      },
    } as unknown as PushService;

    const scheduler = new Scheduler({
      db: env.db,
      userId: env.userId,
      orchestrator,
      push,
      settings: env.settings,
      memory: env.memory,
    });
    await scheduler.tick();

    const rows = env.db.select().from(tasks).all();
    expect(rows[0].status).toBe('done');
    expect(env.ha.calls.some((c) => String(c.data.entity_id).includes('light.living'))).toBe(true);
    expect(env.notifications.some((n) => n.title.includes('予約タスク完了'))).toBe(true);
  });

  it('未来のタスクは実行されない', async () => {
    const env = makeTestEnv();
    await env.registry.execute(
      'tasks.create',
      { title: '未来', run_at: new Date(Date.now() + 86400_000).toISOString(), plan: [{ tool: 'home.execute', input: { entity_id: 'x', service: 'turn_on' } }] },
      env.ctx,
    );
    const orchestrator = { runScheduledTask: async () => ({ ok: true, summary: '' }) } as unknown as Orchestrator;
    const push = { notify: async () => undefined } as unknown as PushService;
    const scheduler = new Scheduler({
      db: env.db,
      userId: env.userId,
      orchestrator,
      push,
      settings: env.settings,
      memory: env.memory,
    });
    await scheduler.tick();
    const rows = env.db.select().from(tasks).all();
    expect(rows[0].status).toBe('scheduled');
  });
});

describe('繰り返しタスク (Phase 2)', async () => {
  const { nextOccurrence, isValidRecurrence } = await import('../src/recurrence.js');

  it('daily@HH:MM は当日または翌日のJST時刻を返す', () => {
    // 2026-08-21 12:00 JST = 03:00 UTC
    const after = new Date('2026-08-21T03:00:00Z');
    const next = nextOccurrence('daily@07:00', after)!;
    // 当日7時JSTは過ぎている → 翌日7時JST = 22日 22:00 UTC前日
    expect(next.toISOString()).toBe('2026-08-21T22:00:00.000Z');
    const next2 = nextOccurrence('daily@15:30', after)!;
    expect(next2.toISOString()).toBe('2026-08-21T06:30:00.000Z'); // 当日15:30 JST
  });

  it('weekly:MON@08:00 は次の月曜を返す', () => {
    // 2026-08-21 はJSTで金曜
    const after = new Date('2026-08-21T03:00:00Z');
    const next = nextOccurrence('weekly:MON@08:00', after)!;
    expect(next.toISOString()).toBe('2026-08-23T23:00:00.000Z'); // 8/24(月) 08:00 JST
  });

  it('形式の検証', () => {
    expect(isValidRecurrence('daily@07:00')).toBe(true);
    expect(isValidRecurrence('weekly:SUN@22:30')).toBe(true);
    expect(isValidRecurrence('daily@25:00')).toBe(false);
    expect(isValidRecurrence('monthly@07:00')).toBe(false);
  });

  it('recurrence付きタスクは実行後にscheduledへ戻り次回時刻が入る', async () => {
    const env = makeTestEnv();
    const past = new Date(Date.now() - 60_000).toISOString();
    await env.registry.execute(
      'tasks.create',
      {
        title: '毎朝の照明',
        run_at: past,
        recurrence: 'daily@07:00',
        plan: [{ tool: 'home.execute', input: { entity_id: 'light.living', service: 'turn_on' } }],
      },
      env.ctx,
    );
    env.ha.states.set('light.living', { entity_id: 'light.living', state: 'off', attributes: {} });
    const orchestrator = {
      runScheduledTask: async () => ({ ok: true, summary: 'done' }),
    } as unknown as Orchestrator;
    const push = { notify: async () => undefined } as unknown as PushService;
    const scheduler = new Scheduler({
      db: env.db,
      userId: env.userId,
      orchestrator,
      push,
      settings: env.settings,
      memory: env.memory,
    });
    await scheduler.tick();

    const row = env.db.select().from(tasks).all()[0];
    expect(row.status).toBe('scheduled'); // doneではなく次回へ
    expect(new Date(row.runAt).getTime()).toBeGreaterThan(Date.now());
  });
});
