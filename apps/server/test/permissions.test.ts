import { describe, expect, it } from 'vitest';
import { v4 as uuid } from 'uuid';
import { makeTestEnv } from './helpers.js';
import { approvals, devices } from '../src/db/schema.js';

describe('Permissions + 承認フロー', () => {
  it('home_control は既定で always_allow → 即実行', async () => {
    const env = makeTestEnv();
    env.ha.states.set('light.bedroom', { entity_id: 'light.bedroom', state: 'off', attributes: {} });
    const result = await env.registry.execute(
      'home.execute',
      { entity_id: 'light.bedroom', service: 'turn_on' },
      env.ctx,
    );
    expect(result.ok).toBe(true);
    expect(env.ha.calls).toHaveLength(1);
  });

  it('always_ask カテゴリは承認待ちになり approval が作成される', async () => {
    const env = makeTestEnv();
    env.permissions.setMode('home_control', 'always_ask');
    const result = await env.registry.execute(
      'home.execute',
      { entity_id: 'light.bedroom', service: 'turn_on' },
      env.ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.pendingApprovalId).toBeTruthy();
    const rows = env.db.select().from(approvals).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    // 承認要求の通知が飛ぶ
    expect(env.notifications.some((n) => n.title.includes('承認'))).toBe(true);
  });

  it('deny カテゴリは実行されない', async () => {
    const env = makeTestEnv();
    env.permissions.setMode('home_control', 'deny');
    const result = await env.registry.execute(
      'home.execute',
      { entity_id: 'light.bedroom', service: 'turn_on' },
      env.ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('禁止');
    expect(env.ha.calls).toHaveLength(0);
  });

  it('ask_once は初回承認後に自動許可へ変わる', () => {
    const env = makeTestEnv();
    expect(env.permissions.check('mac_shell')).toBe('need_approval');
    env.permissions.markGrantedOnce('mac_shell');
    expect(env.permissions.check('mac_shell')).toBe('allow');
  });

  it('skipPermission (承認済み実行) は権限チェックを通らない', async () => {
    const env = makeTestEnv();
    env.permissions.setMode('home_control', 'always_ask');
    env.ha.states.set('light.bedroom', { entity_id: 'light.bedroom', state: 'off', attributes: {} });
    const result = await env.registry.execute(
      'home.execute',
      { entity_id: 'light.bedroom', service: 'turn_on' },
      env.ctx,
      { skipPermission: true },
    );
    expect(result.ok).toBe(true);
    expect(env.ha.calls).toHaveLength(1);
  });

  it('承認画面の文言は内部語彙でなく日本語のデバイス名で出す', async () => {
    const env = makeTestEnv();
    env.db
      .insert(devices)
      .values({
        id: uuid(),
        userId: env.userId,
        entityId: 'lock.front',
        name: '玄関の鍵',
        room: '玄関',
        type: 'lock',
        aliases: '[]',
        createdAt: new Date().toISOString(),
      })
      .run();

    await env.registry.execute('home.execute', { entity_id: 'lock.front', service: 'unlock' }, env.ctx);

    const row = env.db.select().from(approvals).all()[0];
    expect(row.title).toBe('玄関の鍵を解錠します');
    expect(row.title).not.toContain('home.execute');
    expect(row.title).not.toContain('security_change');
  });

  it('listAll は全カテゴリのモードを返す', () => {
    const env = makeTestEnv();
    const list = env.permissions.listAll();
    expect(list.find((p) => p.category === 'payment')?.mode).toBe('always_ask');
    expect(list.find((p) => p.category === 'home_control')?.mode).toBe('always_allow');
  });
});
