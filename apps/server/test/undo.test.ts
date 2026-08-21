import { describe, expect, it } from 'vitest';
import { desc, eq } from 'drizzle-orm';
import { makeTestEnv } from './helpers.js';
import { actions } from '../src/db/schema.js';
import { applyUndo } from '../src/undo.js';
import type { HomeAssistantClient } from '../src/ha/client.js';

describe('Undo', () => {
  it('home.execute は実行前状態を保存し、Undoで復元できる', async () => {
    const env = makeTestEnv();
    env.ha.states.set('climate.living', {
      entity_id: 'climate.living',
      state: 'cool',
      attributes: { temperature: 27, hvac_mode: 'cool' },
    });

    const result = await env.registry.execute(
      'home.execute',
      { entity_id: 'climate.living', service: 'set_temperature', data: { temperature: 24 } },
      env.ctx,
    );
    expect(result.ok).toBe(true);

    const action = env.db.select().from(actions).orderBy(desc(actions.createdAt)).get();
    expect(action?.undoAvailable).toBe(1);

    const undoResult = await applyUndo(env.db, env.ha as unknown as HomeAssistantClient, action!.id);
    expect(undoResult.ok).toBe(true);

    // 復元は「モードを戻す→温度を戻す」の2段階 (set_temperatureにモードを載せても
    // 反映しない統合があるため)
    const restoreCalls = env.ha.calls.slice(-2);
    expect(restoreCalls[0].service).toBe('set_hvac_mode');
    expect(restoreCalls[0].data.hvac_mode).toBe('cool');
    expect(restoreCalls[1].service).toBe('set_temperature');
    expect(restoreCalls[1].data.temperature).toBe(27);
  });

  it('エアコンのモード変更は set_hvac_mode を先に単独で呼ぶ', async () => {
    const env = makeTestEnv();
    env.ha.states.set('climate.living', {
      entity_id: 'climate.living',
      state: 'fan_only',
      attributes: { temperature: 21 },
    });

    await env.registry.execute(
      'home.execute',
      { entity_id: 'climate.living', service: 'set_temperature', data: { hvac_mode: 'cool', temperature: 26 } },
      env.ctx,
    );

    expect(env.ha.calls).toHaveLength(2);
    expect(env.ha.calls[0]).toMatchObject({ service: 'set_hvac_mode', data: { hvac_mode: 'cool' } });
    expect(env.ha.calls[1]).toMatchObject({ service: 'set_temperature', data: { temperature: 26 } });
  });

  it('オフラインの機器は成功と誤報告せず、実行もしない', async () => {
    const env = makeTestEnv();
    env.ha.states.set('light.bedroom', {
      entity_id: 'light.bedroom',
      state: 'unavailable',
      attributes: {},
    });

    const result = await env.registry.execute(
      'home.execute',
      { entity_id: 'light.bedroom', service: 'turn_on' },
      env.ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('オフライン');
    expect(env.ha.calls).toHaveLength(0); // HAへ投げない
  });

  it('HAが黙って処理を飛ばした場合 (オフライン) は成功と誤報告しない', async () => {
    const env = makeTestEnv();
    // 実行前は off に見えるが、HAは空応答を返し、直後の再取得で unavailable と判明する
    // (実機で観測されたパターン。断続的にオフラインになる)
    env.ha.states.set('switch.dining', { entity_id: 'switch.dining', state: 'off', attributes: {} });
    env.ha.skipNext = true;
    let reads = 0;
    env.ha.getState = async (id: string) => {
      reads++;
      return { entity_id: id, state: reads === 1 ? 'off' : 'unavailable', attributes: {} };
    };

    const result = await env.registry.execute(
      'home.execute',
      { entity_id: 'switch.dining', service: 'turn_on' },
      env.ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('オフライン');
  });

  it('呼び出し側が誤ったドメインを指定してもentity_id側を優先する', async () => {
    const env = makeTestEnv();
    env.ha.states.set('switch.dining', { entity_id: 'switch.dining', state: 'off', attributes: {} });

    await env.registry.execute(
      'home.execute',
      { entity_id: 'switch.dining', domain: 'light', service: 'turn_on' },
      env.ctx,
    );

    expect(env.ha.calls[0].domain).toBe('switch');
  });

  it('存在しない機器は「見つかりません」を返す', async () => {
    const env = makeTestEnv();
    const result = await env.registry.execute(
      'home.execute',
      { entity_id: 'light.nonexistent', service: 'turn_on' },
      env.ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('見つかりません');
    expect(env.ha.calls).toHaveLength(0);
  });

  it('モード指定がなければ set_temperature のみ (余計な呼び出しをしない)', async () => {
    const env = makeTestEnv();
    env.ha.states.set('climate.living', {
      entity_id: 'climate.living',
      state: 'cool',
      attributes: { temperature: 26 },
    });

    await env.registry.execute(
      'home.execute',
      { entity_id: 'climate.living', service: 'set_temperature', data: { temperature: 24 } },
      env.ctx,
    );

    expect(env.ha.calls).toHaveLength(1);
    expect(env.ha.calls[0].service).toBe('set_temperature');
  });

  it('二重Undoは拒否される', async () => {
    const env = makeTestEnv();
    env.ha.states.set('light.bedroom', { entity_id: 'light.bedroom', state: 'off', attributes: {} });
    await env.registry.execute('home.execute', { entity_id: 'light.bedroom', service: 'turn_on' }, env.ctx);
    const action = env.db.select().from(actions).orderBy(desc(actions.createdAt)).get();

    const first = await applyUndo(env.db, env.ha as unknown as HomeAssistantClient, action!.id);
    expect(first.ok).toBe(true);
    const second = await applyUndo(env.db, env.ha as unknown as HomeAssistantClient, action!.id);
    expect(second.ok).toBe(false);
    expect(second.message).toContain('すでに');
  });

  it('Undo情報がない操作は「元に戻せません」', async () => {
    const env = makeTestEnv();
    await env.registry.execute('memory.search', { query: 'x' }, env.ctx);
    const action = env.db.select().from(actions).orderBy(desc(actions.createdAt)).get();
    const result = await applyUndo(env.db, env.ha as unknown as HomeAssistantClient, action!.id);
    expect(result.ok).toBe(false);
  });
});
