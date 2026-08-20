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

    // 復元呼び出しは温度27に戻す
    const restoreCall = env.ha.calls.at(-1)!;
    expect(restoreCall.service).toBe('set_temperature');
    expect(restoreCall.data.temperature).toBe(27);
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
