// 実運用で誤診を招いた不具合の回帰テスト。
// Home Assistantに繋がらない時に「その機器が見つかりませんでした」と表示され、
// 機器（SwitchBotの電球）が壊れていると誤解させた。
// 「繋がらない」と「機器が無い」は必ず区別する。

import { describe, expect, it, vi, afterEach } from 'vitest';
import { makeTestEnv } from './helpers.js';
import { HomeAssistantClient, HaRequestError } from '../src/ha/client.js';
import { answerStatus } from '../src/statusAnswer.js';

afterEach(() => vi.unstubAllGlobals());

describe('Home Assistantの接続断と機器不在の区別', () => {
  it('接続できないときは「見つかりません」ではなく接続エラーを返す', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    const ha = new HomeAssistantClient('http://ha.local:8123', 'token');
    await expect(ha.getState('light.bedroom')).rejects.toMatchObject({
      name: 'HaRequestError',
      status: 0,
    });
    await expect(ha.getState('light.bedroom')).rejects.toThrow('接続できませんでした');
  });

  it('本当に存在しない機器 (404) のときだけ null を返す', async () => {
    vi.stubGlobal('fetch', async () => new Response('Not Found', { status: 404 }));
    const ha = new HomeAssistantClient('http://ha.local:8123', 'token');
    expect(await ha.getState('light.nonexistent')).toBeNull();
  });

  it('Mac Agentが未接続のときも接続エラーとして扱う', async () => {
    const ha = new HomeAssistantClient('', '', () => async () => {
      throw new Error('Mac Agentが接続されていません');
    });
    await expect(ha.getState('light.bedroom')).rejects.toMatchObject({ status: 0 });
  });

  it('ユーザー向け文言が状況ごとに変わる', () => {
    expect(HaRequestError.userMessage(0)).toContain('接続できませんでした');
    expect(HaRequestError.userMessage(404)).toContain('見つかりませんでした');
    expect(HaRequestError.userMessage(500)).toContain('電源');
    expect(HaRequestError.userMessage(401)).toContain('認証');
  });

  it('操作時、接続断なら「見つかりません」と言わない', async () => {
    const env = makeTestEnv();
    env.ha.getState = async () => {
      throw new HaRequestError(0, 'fetch failed', '/api/states/light.x');
    };
    const result = await env.registry.execute(
      'home.execute',
      { entity_id: 'light.bedroom', service: 'turn_off' },
      env.ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('接続できませんでした');
    expect(result.error).not.toContain('見つかりません');
  });

  it('状態確認でも、接続断とセンサー未設置を言い分ける', async () => {
    const env = makeTestEnv();
    const deps = {
      db: env.db,
      userId: env.userId,
      ha: env.ha as unknown as HomeAssistantClient,
      location: '',
    };
    // センサーが無いだけ
    expect(await answerStatus('indoor', deps)).toContain('センサーが見つかりません');

    // 取得そのものができない
    env.ha.getStates = async () => {
      throw new HaRequestError(0, 'fetch failed', '/api/states');
    };
    const answer = await answerStatus('indoor', deps);
    expect(answer).toContain('取得できませんでした');
    expect(answer).not.toContain('センサーが見つかりません');
  });

  it('家電が取れなくても外の天気は答える', async () => {
    const env = makeTestEnv();
    env.ha.getStates = async () => {
      throw new HaRequestError(0, 'fetch failed', '/api/states');
    };
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ current: { temperature_2m: 26.6, weather_code: 0 } }), { status: 200 }),
    );
    const answer = await answerStatus('weather', {
      db: env.db,
      userId: env.userId,
      ha: env.ha as unknown as HomeAssistantClient,
      location: '33.7668,130.4913',
    });
    expect(answer).toContain('26.6度');
  });
});
