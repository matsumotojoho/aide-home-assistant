import { describe, expect, it } from 'vitest';
import { createAlexaApp, trimForAlexa } from '../src/alexa/skill.js';
import type { Orchestrator } from '../src/orchestrator.js';
import type { SettingsService } from '../src/services/settings.js';
import type { PushService } from '../src/push.js';

function makeApp(opts: {
  reply?: string;
  delayMs?: number;
  verbosity?: string;
  verifyFail?: boolean;
  onNotify?: (title: string, body: string) => void;
}) {
  const orchestrator = {
    handleUserMessage: async (params: { text: string; conversationId?: string }) => {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      return {
        reply: opts.reply ?? `了解: ${params.text}`,
        conversationId: params.conversationId ?? 'conv-1',
        intent: 'consult' as const,
        pendingApprovalIds: [],
      };
    },
  } as unknown as Orchestrator;
  const settings = {
    get: (key: string) => (key === 'alexa.verbosity' ? (opts.verbosity ?? 'standard') : 'important'),
  } as unknown as SettingsService;
  const push = {
    notify: async (_u: unknown, _s: unknown, _l: string, title: string, body: string) => {
      opts.onNotify?.(title, body);
    },
  } as unknown as PushService;
  return createAlexaApp({
    orchestrator,
    settings,
    push,
    userId: 'u1',
    verify: opts.verifyFail ? async () => Promise.reject(new Error('bad sig')) : async () => undefined,
  });
}

function alexaRequest(request: Record<string, unknown>, sessionId = 's1') {
  return {
    version: '1.0',
    session: { sessionId, new: false },
    request: { timestamp: new Date().toISOString(), requestId: 'r1', ...request },
  };
}

async function post(app: ReturnType<typeof makeApp>, body: unknown) {
  const res = await app.request('/', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { signaturecertchainurl: 'https://s3.amazonaws.com/echo.api/cert', signature: 'x' },
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('Alexa Skill エンドポイント', () => {
  it('署名検証に失敗したリクエストは400', async () => {
    const app = makeApp({ verifyFail: true });
    const { status } = await post(app, alexaRequest({ type: 'LaunchRequest' }));
    expect(status).toBe(400);
  });

  it('古いタイムスタンプは拒否 (リプレイ防止)', async () => {
    const app = makeApp({});
    const body = alexaRequest({ type: 'LaunchRequest' });
    (body.request as Record<string, unknown>).timestamp = new Date(Date.now() - 300_000).toISOString();
    const { status } = await post(app, body);
    expect(status).toBe(400);
  });

  it('LaunchRequest は起動あいさつ + セッション維持', async () => {
    const app = makeApp({});
    const { json } = await post(app, alexaRequest({ type: 'LaunchRequest' }));
    const resp = json.response as Record<string, unknown>;
    expect((resp.outputSpeech as Record<string, unknown>).text).toContain('何をしましょう');
    expect(resp.shouldEndSession).toBe(false); // 「アレクサ」なしで続けられる
  });

  it('自由発話はorchestratorへ渡り、応答後もセッション維持', async () => {
    const app = makeApp({ reply: 'リビングの照明をつけました。' });
    const { json } = await post(
      app,
      alexaRequest({
        type: 'IntentRequest',
        intent: { name: 'CatchAllIntent', slots: { query: { name: 'query', value: 'リビングの電気つけて' } } },
      }),
    );
    const resp = json.response as Record<string, unknown>;
    expect((resp.outputSpeech as Record<string, unknown>).text).toContain('つけました');
    expect(resp.shouldEndSession).toBe(false);
  });

  it('StopIntent はセッション終了', async () => {
    const app = makeApp({});
    const { json } = await post(app, alexaRequest({ type: 'IntentRequest', intent: { name: 'AMAZON.StopIntent' } }));
    expect((json.response as Record<string, unknown>).shouldEndSession).toBe(true);
  });

  it('処理が6秒を超えたら即答し、完了後にPush通知する (8秒タイムアウト対策)', async () => {
    let notified = '';
    const app = makeApp({
      reply: '調べ終わりました。結果はこちらです。',
      delayMs: 6300,
      onNotify: (_t, body) => (notified = body),
    });
    const { json } = await post(
      app,
      alexaRequest({
        type: 'IntentRequest',
        intent: { name: 'CatchAllIntent', slots: { query: { name: 'query', value: '難しい調査をして' } } },
      }),
    );
    expect((json.response as Record<string, unknown>).outputSpeech).toMatchObject({
      text: expect.stringContaining('スマホに通知'),
    });
    // バックグラウンド完了 → Push
    await new Promise((r) => setTimeout(r, 700));
    expect(notified).toContain('調べ終わりました');
  }, 10_000);
});

describe('Alexa応答長 (alexa.verbosity)', () => {
  const long = '一文目です。二文目です。三文目です。四文目です。五文目です。';
  it('short は1文', () => {
    expect(trimForAlexa(long, 'short')).toBe('一文目です。');
  });
  it('standard は2文まで', () => {
    expect(trimForAlexa(long, 'standard')).toBe('一文目です。二文目です。');
  });
  it('full は全文', () => {
    expect(trimForAlexa(long, 'full')).toBe(long);
  });
  it('文字数上限を超えたら省略記号', () => {
    const veryLong = 'あ'.repeat(300) + '。';
    expect(trimForAlexa(veryLong, 'short').length).toBeLessThanOrEqual(81);
    expect(trimForAlexa(veryLong, 'short')).toContain('…');
  });
});
