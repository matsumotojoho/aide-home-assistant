// Alexa Custom Skill エンドポイント (Phase 2)。
// 設計思想 (仕様書3): Alexaは「耳と口」。判断・記憶・実行管理はBackend側。
// - 公式のリクエスト署名検証を必ず行う (alexa-verifier)
// - 応答後は shouldEndSession:false でセッション維持 → 「アレクサ」なしで会話継続
// - Alexaは約8秒でタイムアウトするため、Claude判断が長引く場合は
//   「結果はスマホに通知します」と即答し、処理はバックグラウンドで継続する

import { Hono } from 'hono';
import verifier from 'alexa-verifier';
import type { Orchestrator } from '../orchestrator.js';
import type { SettingsService } from '../services/settings.js';
import type { PushService } from '../push.js';

// Alexaのリクエストタイムアウトは8秒。検証や往復のマージンを引いた値で打ち切る
const REPLY_DEADLINE_MS = 6000;

export interface AlexaDeps {
  orchestrator: Orchestrator;
  settings: SettingsService;
  push: PushService;
  userId: string;
  /** テスト用: 署名検証の差し替え */
  verify?: (certUrl: string, signature: string, body: string) => Promise<void>;
}

interface AlexaRequestBody {
  version: string;
  session?: { sessionId?: string; new?: boolean };
  request: {
    type: string;
    requestId?: string;
    timestamp?: string;
    intent?: { name: string; slots?: Record<string, { name: string; value?: string }> };
    reason?: string;
  };
}

// Alexaセッション → Aide会話のマッピング (プロセス内 / TTL 30分)
const sessionConversations = new Map<string, { conversationId: string; touchedAt: number }>();
const SESSION_TTL_MS = 30 * 60_000;

function gcSessions(): void {
  const now = Date.now();
  for (const [k, v] of sessionConversations) {
    if (now - v.touchedAt > SESSION_TTL_MS) sessionConversations.delete(k);
  }
}

function defaultVerify(certUrl: string, signature: string, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    verifier(certUrl, signature, body, (err) => {
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve();
    });
  });
}

/** Alexa応答長設定に従って読み上げ文を整形する */
export function trimForAlexa(text: string, verbosity: 'short' | 'standard' | 'detailed' | 'full'): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (verbosity === 'full') return clean;
  const sentences = clean.split(/(?<=[。!?！？])/).filter((s) => s.trim().length > 0);
  const limits = { short: { n: 1, chars: 80 }, standard: { n: 2, chars: 200 }, detailed: { n: 4, chars: 400 } };
  const { n, chars } = limits[verbosity];
  const joined = sentences.slice(0, n).join('');
  return joined.length > chars ? `${joined.slice(0, chars)}…` : joined || clean.slice(0, chars);
}

function speechResponse(text: string, endSession: boolean, reprompt?: string): Record<string, unknown> {
  const response: Record<string, unknown> = {
    outputSpeech: { type: 'PlainText', text },
    shouldEndSession: endSession,
  };
  if (!endSession) {
    response.reprompt = { outputSpeech: { type: 'PlainText', text: reprompt ?? 'ほかに何かありますか?' } };
  }
  return { version: '1.0', response };
}

export function createAlexaApp(deps: AlexaDeps): Hono {
  const app = new Hono();
  const verify = deps.verify ?? defaultVerify;

  app.post('/', async (c) => {
    // 署名検証は必ず生のボディに対して行う
    const rawBody = await c.req.text();
    // Alexaのヘッダーは Signature-Cert-Chain-Url / Signature (ハイフン区切り)。
    // 旧SDK互換で SignatureCertChainUrl を送る経路もあるため両方受ける。
    const certUrl =
      c.req.header('signature-cert-chain-url') ?? c.req.header('signaturecertchainurl') ?? '';
    const signature = c.req.header('signature') ?? '';
    // 到達したことを必ず残す (届いていないのか、弾いているのかを切り分けるため)
    console.log(
      `[alexa] 受信 body=${rawBody.length}B cert=${certUrl ? 'あり' : 'なし'} sig=${signature ? 'あり' : 'なし'}`,
    );
    try {
      await verify(certUrl, signature, rawBody);
    } catch (err) {
      console.warn('[alexa] 署名検証失敗:', err instanceof Error ? err.message : err);
      return c.json({ error: 'invalid signature' }, 400);
    }

    let body: AlexaRequestBody;
    try {
      body = JSON.parse(rawBody) as AlexaRequestBody;
    } catch {
      console.warn('[alexa] JSONとして解釈できませんでした');
      return c.json({ error: 'invalid body' }, 400);
    }

    // タイムスタンプ検証 (リプレイ防止 / 公式要件は150秒以内)
    const ts = body.request?.timestamp ? Date.parse(body.request.timestamp) : NaN;
    if (Number.isNaN(ts) || Math.abs(Date.now() - ts) > 150_000) {
      console.warn(
        `[alexa] タイムスタンプ不正: ${body.request?.timestamp ?? '(なし)'} (サーバー時刻 ${new Date().toISOString()})`,
      );
      return c.json({ error: 'stale request' }, 400);
    }
    console.log(`[alexa] type=${body.request.type} intent=${body.request.intent?.name ?? '-'}`);

    gcSessions();
    const sessionId = body.session?.sessionId ?? 'no-session';

    switch (body.request.type) {
      case 'LaunchRequest':
        return c.json(speechResponse('はい、何をしましょう?', false, 'ご用件をどうぞ。'));

      case 'SessionEndedRequest':
        sessionConversations.delete(sessionId);
        return c.json({ version: '1.0', response: {} });

      case 'IntentRequest': {
        const intentName = body.request.intent?.name ?? '';
        if (intentName === 'AMAZON.StopIntent' || intentName === 'AMAZON.CancelIntent') {
          sessionConversations.delete(sessionId);
          return c.json(speechResponse('はい。', true));
        }
        if (intentName === 'AMAZON.HelpIntent') {
          return c.json(
            speechResponse(
              '家電の操作、予定の管理、調べ物などを頼めます。例えば「リビングの電気つけて」のように話してください。',
              false,
            ),
          );
        }
        if (intentName === 'AMAZON.FallbackIntent') {
          return c.json(speechResponse('すみません、聞き取れませんでした。もう一度お願いします。', false));
        }

        const query = body.request.intent?.slots?.query?.value?.trim() ?? '';
        if (!query) {
          return c.json(speechResponse('ご用件をどうぞ。', false));
        }
        return c.json(await handleQuery(deps, sessionId, query));
      }

      default:
        return c.json(speechResponse('すみません、対応していないリクエストです。', true));
    }
  });

  return app;
}

async function handleQuery(
  deps: AlexaDeps,
  sessionId: string,
  query: string,
): Promise<Record<string, unknown>> {
  const mapping = sessionConversations.get(sessionId);
  const work = deps.orchestrator
    .handleUserMessage({
      userId: deps.userId,
      text: query,
      source: 'alexa',
      conversationId: mapping?.conversationId,
    })
    .then((result) => {
      sessionConversations.set(sessionId, { conversationId: result.conversationId, touchedAt: Date.now() });
      return result;
    });

  const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), REPLY_DEADLINE_MS));
  const raced = await Promise.race([work, timeout]);

  if (raced === 'timeout') {
    // 処理はバックグラウンドで継続し、完了したらWeb Pushで結果を届ける
    void work
      .then((result) =>
        deps.push.notify(deps.userId, deps.settings, 'important', 'Aideの応答', result.reply.slice(0, 300)),
      )
      .catch((err) => {
        console.error('[alexa] バックグラウンド処理失敗:', err);
        void deps.push.notify(deps.userId, deps.settings, 'failure', 'Aideの処理が失敗しました', '');
      });
    return speechResponse('確認しています。結果はスマホに通知しますね。', false);
  }

  const verbosity = deps.settings.get('alexa.verbosity');
  return speechResponse(trimForAlexa(raced.reply, verbosity), false);
}
