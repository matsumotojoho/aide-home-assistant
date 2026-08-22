// 仕様書30/31: 有料APIは有効化されるまで絶対に課金経路を使わない。
// Provider追加時にこの保証が壊れないよう固定する。

import { describe, expect, it } from 'vitest';
import { makeTestEnv } from './helpers.js';
import { createProviderSelector, ProviderUnavailableError } from '../src/llm/index.js';
import type { AgentGateway } from '../src/agentGateway.js';

const offlineGateway = { connected: () => false } as unknown as AgentGateway;

function selector(env: ReturnType<typeof makeTestEnv>) {
  return createProviderSelector({
    settings: env.settings,
    gateway: offlineGateway,
    anthropicApiKey: 'sk-ant-dummy',
    openaiApiKey: 'sk-openai-dummy',
  });
}

describe('AI Provider選択', () => {
  it('既定は有料APIがOFF', () => {
    const env = makeTestEnv();
    expect(env.settings.get('ai.paid_api_fallback')).toBe('off');
  });

  it('autoでは有料APIへ自動フォールバックしない (APIキーがあっても)', async () => {
    const env = makeTestEnv();
    env.settings.set('ai.provider', 'auto');
    // ローカルCLI/Mac Agent/ローカルLLMがいずれも使えない状況を作る
    const sel = createProviderSelector({
      settings: env.settings,
      gateway: offlineGateway,
      anthropicApiKey: 'sk-ant-dummy',
      openaiApiKey: 'sk-openai-dummy',
    });
    // claude CLIが実在する環境ではそれが選ばれる。その場合も有料APIでないことを確認する
    try {
      const provider = await sel.pick();
      expect(['claude-cli-local', 'claude-via-mac', 'local-llm']).toContain(provider.id);
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderUnavailableError);
    }
  });

  it('paid_api_fallback=off なら anthropic-api を明示指定しても使えない', async () => {
    const env = makeTestEnv();
    env.settings.set('ai.provider', 'anthropic-api');
    await expect(selector(env).pick()).rejects.toThrow(ProviderUnavailableError);
  });

  it('paid_api_fallback=off なら openai-api も使えない', async () => {
    const env = makeTestEnv();
    env.settings.set('ai.provider', 'openai-api');
    await expect(selector(env).pick()).rejects.toThrow(ProviderUnavailableError);
  });

  it('paid_api_fallback=on にして初めて有料APIが選べる', async () => {
    const env = makeTestEnv();
    env.settings.set('ai.provider', 'anthropic-api');
    env.settings.set('ai.paid_api_fallback', 'on');
    const provider = await selector(env).pick();
    expect(provider.id).toBe('anthropic-api');
  });

  it('APIキーが無ければ、ONにしても使えない', async () => {
    const env = makeTestEnv();
    env.settings.set('ai.provider', 'openai-api');
    env.settings.set('ai.paid_api_fallback', 'on');
    const sel = createProviderSelector({
      settings: env.settings,
      gateway: offlineGateway,
      anthropicApiKey: '',
      openaiApiKey: '',
    });
    await expect(sel.pick()).rejects.toThrow(ProviderUnavailableError);
  });

  it('ローカルLLMはモデル未設定なら使えない (誤って選ばれない)', async () => {
    const env = makeTestEnv();
    env.settings.set('ai.provider', 'local-llm');
    await expect(selector(env).pick()).rejects.toThrow(ProviderUnavailableError);
  });

  it('選択肢に5つのProviderが登録されている', () => {
    const env = makeTestEnv();
    expect(selector(env).ids()).toEqual([
      'claude-cli-local',
      'claude-via-mac',
      'anthropic-api',
      'openai-api',
      'local-llm',
    ]);
  });
});
