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
