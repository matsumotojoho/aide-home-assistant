// Claude障害時フォールバック (仕様書30):
// - 明確な家電操作はClaude不通でも動作する
// - 曖昧な処理は「現在AI判断機能が利用できません」を返す
// - 勝手に有料APIを使わない (auto選択はAPIを候補にしない)

import { describe, expect, it } from 'vitest';
import { v4 as uuid } from 'uuid';
import { makeTestEnv, TEST_DEVICES } from './helpers.js';
import { devices } from '../src/db/schema.js';
import { Orchestrator, parseAgentTurn } from '../src/orchestrator.js';
import { ProviderUnavailableError, type ProviderSelector } from '../src/llm/index.js';
import { HaRequestError } from '../src/ha/client.js';

function seedDevices(env: ReturnType<typeof makeTestEnv>) {
  for (const d of TEST_DEVICES) {
    env.db
      .insert(devices)
      .values({
        id: uuid(),
        userId: env.userId,
        entityId: d.entityId,
        name: d.name,
        room: d.room,
        type: d.type,
        aliases: JSON.stringify(d.aliases),
        createdAt: new Date().toISOString(),
      })
      .run();
  }
}

const failingSelector: ProviderSelector = {
  ids: () => [],
  pick: async () => {
    throw new ProviderUnavailableError();
  },
};

describe('Claude障害フォールバック', () => {
  it('明確な家電命令はClaude不通でも実行される', async () => {
    const env = makeTestEnv();
    seedDevices(env);
    env.ha.states.set('light.bedroom', { entity_id: 'light.bedroom', state: 'off', attributes: {} });

    const orchestrator = new Orchestrator({
      db: env.db,
      registry: env.registry,
      providerSelector: failingSelector,
      buildToolContext: () => env.ctx,
    });

    const result = await orchestrator.handleUserMessage({
      userId: env.userId,
      text: '寝室の電気つけて',
      source: 'web',
    });

    expect(result.intent).toBe('home_direct');
    expect(result.reply).toContain('つけました');
    expect(env.ha.calls).toHaveLength(1);
    expect(env.ha.calls[0].data.entity_id).toEqual(['light.bedroom']);
  });

  it('曖昧な命令はAI不通メッセージを返す (エラーで落ちない)', async () => {
    const env = makeTestEnv();
    seedDevices(env);

    const orchestrator = new Orchestrator({
      db: env.db,
      registry: env.registry,
      providerSelector: failingSelector,
      buildToolContext: () => env.ctx,
    });

    const result = await orchestrator.handleUserMessage({
      userId: env.userId,
      text: '部屋いい感じにして',
      source: 'web',
    });

    expect(result.intent).toBe('home_ambiguous');
    expect(result.reply).toContain('AI判断機能が利用できません');
    expect(result.reply).toContain('家電操作は引き続き');
  });

  it('家電実行エラー時は平易なエラーメッセージ (Stack Traceを返さない)', async () => {
    const env = makeTestEnv();
    seedDevices(env);
    env.ha.states.set('light.bedroom', { entity_id: 'light.bedroom', state: 'off', attributes: {} });
    env.ha.failNext = true;

    const orchestrator = new Orchestrator({
      db: env.db,
      registry: env.registry,
      providerSelector: failingSelector,
      buildToolContext: () => env.ctx,
    });

    const result = await orchestrator.handleUserMessage({
      userId: env.userId,
      text: '寝室の電気つけて',
      source: 'web',
    });
    expect(result.reply).toMatch(/^すみません、/);
    expect(result.reply).not.toContain('at ');
    expect(result.reply).not.toMatch(/Error:|ECONNREFUSED|\bstack\b/);
  });
});

describe('Home Assistantエラーのユーザー向け変換 (仕様書34)', () => {
  it('HTTPステータスを平易な日本語にし、数字を露出しない', () => {
    const offline = new HaRequestError(500, 'SwitchBotDeviceOfflineError', '/api/services/light/turn_off');
    expect(offline.message).toContain('電源');
    expect(offline.message).not.toContain('500');
    // 技術的詳細は保持され、ログ側で参照できる
    expect(offline.detail).toContain('SwitchBotDeviceOffline');

    expect(new HaRequestError(401, '', '/api/states').message).toContain('認証');
    expect(new HaRequestError(404, '', '/api/states').message).toContain('見つかりません');
  });
});

describe('LLM応答パース', () => {
  it('tool_calls JSONをパースできる', () => {
    const turn = parseAgentTurn('{"type":"tool_calls","calls":[{"tool":"home.get_state","input":{}}]}');
    expect(turn.type).toBe('tool_calls');
  });

  it('コードフェンス付きJSONもパースできる', () => {
    const turn = parseAgentTurn('前置き\n```json\n{"type":"final","speak":"つけました"}\n```');
    expect(turn.type).toBe('final');
    if (turn.type === 'final') expect(turn.speak).toBe('つけました');
  });

  it('save_memoryの不正エントリは除外される', () => {
    const turn = parseAgentTurn(
      '{"type":"final","speak":"ok","save_memory":[{"kind":"preference","title":"t","content":"c"},{"bad":true}]}',
    );
    if (turn.type === 'final') {
      expect(turn.save_memory).toHaveLength(1);
    }
  });

  it('JSONでない応答はfinalとして扱う', () => {
    const turn = parseAgentTurn('こんにちは、何かお手伝いしましょうか?');
    expect(turn.type).toBe('final');
  });
});
