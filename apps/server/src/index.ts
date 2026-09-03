// Aide server エントリポイント。
// - REST API (/api/*) + PWA静的配信 + Mac Agent WebSocket (/agent/ws)
// - ローカル (Mac mini) でも Railway でも同一コードで動作する。

import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { getCookie, deleteCookie } from 'hono/cookie';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { v4 as uuid } from 'uuid';
import { and, desc, eq } from 'drizzle-orm';
import { config } from './config.js';
import { createDb } from './db/index.js';
import { conversations, users } from './db/schema.js';
import { AuthService } from './auth.js';
import { SettingsService } from './services/settings.js';
import { MemoryService } from './services/memory.js';
import { PermissionService } from './services/permissions.js';
import { HomeAssistantClient } from './ha/client.js';
import { AgentGateway } from './agentGateway.js';
import { PushService } from './push.js';
import { createRegistry, type ToolContext } from './tools/index.js';
import { createProviderSelector } from './llm/index.js';
import { Orchestrator } from './orchestrator.js';
import { Scheduler } from './scheduler.js';
import { createApi } from './routes/api.js';
import { createAlexaApp } from './alexa/skill.js';
import { AlexaOAuth } from './alexa/oauth.js';
import { handleDirective } from './alexa/smarthome.js';
import { GoogleAuth } from './google/oauth.js';
import { MessagingService } from './messaging/channels.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const db = createDb(join(config.dataDir, 'aide.db'));

  // 単一ユーザーのシード (DB設計はマルチユーザー対応済み)
  let owner = db.select().from(users).where(eq(users.email, config.authEmail)).get();
  if (!owner) {
    owner = {
      id: uuid(),
      email: config.authEmail,
      displayName: 'Owner',
      createdAt: new Date().toISOString(),
    };
    db.insert(users).values(owner).run();
    console.log(`[boot] オーナーユーザーを作成: ${owner.email}`);
  }
  const userId = owner.id;

  const gateway = new AgentGateway(config.agentToken);
  const settings = new SettingsService(db, userId);
  const memory = new MemoryService(db, userId);
  const permissions = new PermissionService(db, userId);
  const push = new PushService(db, config.vapid);
  const auth = new AuthService(config.sessionSecret, config.authPasswordHash, config.isProd);

  const ha = new HomeAssistantClient(config.ha.baseUrl, config.ha.token, () => {
    // 直接アクセス不可 (Railway等) の場合はMac Agent経由でHAへ中継
    if (!gateway.connected()) return null;
    return async ({ method, path, body }) => {
      const res = await gateway.call<{ status: number; body: unknown }>('ha.request', { method, path, body }, 15_000);
      return res;
    };
  });

  const googleAuth = new GoogleAuth(db, userId, `${config.publicUrl}/api/google/callback`);

  const messaging = new MessagingService(db, userId);

  const registry = createRegistry();
  const providerSelector = createProviderSelector({
    settings,
    gateway,
    anthropicApiKey: config.anthropicApiKey,
    openaiApiKey: config.openaiApiKey,
  });

  const buildToolContext = (source: ToolContext['source']): ToolContext => ({
    db,
    userId,
    source,
    googleAuth,
    messaging,
    ha,
    gateway,
    push,
    settings,
    memory,
    permissions,
  });

  const orchestrator = new Orchestrator({ db, registry, providerSelector, buildToolContext });
  const scheduler = new Scheduler({ db, userId, orchestrator, push, settings, memory });

  // ---------- HTTP app ----------
  const app = new Hono();

  app.route(
    '/api',
    createApi({
      db,
      userId,
      auth,
      orchestrator,
      registry,
      push,
      settings,
      memory,
      permissions,
      ha,
      gateway,
      googleAuth,
      messaging,
      buildToolContext,
    }),
  );

  // Google OAuthコールバック (Googleからのリダイレクトを受けるため /api の認証ゾーン外)
  app.get('/api/google/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const expected = getCookie(c, 'google_oauth_state');
    const html = (msg: string) =>
      c.html(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
          `<body style="font-family:-apple-system,sans-serif;padding:40px;text-align:center">` +
          `<p>${msg}</p><p><a href="/">Aideへ戻る</a></p></body>`,
      );
    if (!code || !state || state !== expected) {
      return html('連携に失敗しました (リクエストが不正です)。もう一度お試しください。');
    }
    deleteCookie(c, 'google_oauth_state', { path: '/' });
    try {
      await googleAuth.exchangeCode(code);
      return html('Googleと連携しました。');
    } catch (err) {
      console.error('[google] コード交換失敗:', err);
      return html('連携に失敗しました。設定をやり直してください。');
    }
  });

  // ---- Alexa スマートホームスキル (標準の言い方でHA経由にする) ----
  const alexaOAuth = new AlexaOAuth(db, {
    clientId: config.alexa.clientId,
    clientSecret: config.alexa.clientSecret,
  });

  // アカウントリンクの同意画面。ログイン済みならそのまま認可コードを返す
  app.get('/alexa/oauth/authorize', async (c) => {
    const clientId = c.req.query('client_id') ?? '';
    const redirectUri = c.req.query('redirect_uri') ?? '';
    const state = c.req.query('state') ?? '';
    const page = (msg: string) =>
      c.html(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
          `<body style="font-family:-apple-system,sans-serif;padding:40px;text-align:center;line-height:1.8">` +
          `<p>${msg}</p></body>`,
      );
    if (!alexaOAuth.configured()) return page('Alexa連携が未設定です。設定タブから設定してください。');
    if (!alexaOAuth.verifyClient(clientId)) return page('連携情報が一致しません。');
    if (!alexaOAuth.isAllowedRedirect(redirectUri)) return page('リダイレクト先が許可されていません。');

    const uid = await auth.verifySession(c);
    if (!uid) {
      // 未ログインならログインさせてから戻す
      return c.redirect(`/?next=${encodeURIComponent(c.req.url)}`);
    }
    const code = alexaOAuth.issueCode(uid, clientId, redirectUri);
    const url = new URL(redirectUri);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    return c.redirect(url.toString());
  });

  // トークンエンドポイント (Alexaのサーバーから呼ばれる)
  app.post('/alexa/oauth/token', async (c) => {
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const get = (k: string) => String((form as Record<string, unknown>)[k] ?? '');
    // client_secret_basic にも対応する
    let clientId = get('client_id');
    let clientSecret = get('client_secret');
    const authz = c.req.header('authorization') ?? '';
    if (authz.startsWith('Basic ')) {
      const [id, secret] = Buffer.from(authz.slice(6), 'base64').toString('utf8').split(':');
      clientId = clientId || id;
      clientSecret = clientSecret || secret;
    }
    if (!alexaOAuth.verifyClient(clientId, clientSecret)) {
      return c.json({ error: 'invalid_client' }, 401);
    }
    const grantType = get('grant_type');
    const tokens =
      grantType === 'refresh_token'
        ? alexaOAuth.refresh(get('refresh_token'))
        : alexaOAuth.exchangeCode(get('code'), clientId, get('redirect_uri'));
    if (!tokens) return c.json({ error: 'invalid_grant' }, 400);
    return c.json({ token_type: 'Bearer', ...tokens });
  });

  // スマートホームのディレクティブ本体 (Lambdaが中継してくる)
  app.post('/alexa/smarthome', async (c) => {
    // Lambdaとの共有シークレットで保護する (Alexaの署名はLambda側で完結するため)
    const presented = c.req.header('x-aide-lambda-secret') ?? '';
    if (!config.alexa.lambdaSecret || presented !== config.alexa.lambdaSecret) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: 'invalid body' }, 400);
    const result = await handleDirective(
      {
        db,
        ha,
        registry,
        buildToolContext,
        resolveUser: (token) => alexaOAuth.verifyAccessToken(token),
      },
      body,
    );
    return c.json(result);
  });

  // Alexa Custom Skill (Phase 2)。/api配下ではなくトップレベル (セッション認証でなく署名検証)
  app.route(
    '/alexa',
    createAlexaApp({
      orchestrator,
      settings,
      push,
      userId,
      // Alexaのセッションが切れても、30分以内なら同じ会話を続ける
      findRecentConversation: () => {
        const row = db
          .select()
          .from(conversations)
          .where(and(eq(conversations.userId, userId), eq(conversations.source, 'alexa')))
          .orderBy(desc(conversations.updatedAt))
          .limit(1)
          .get();
        if (!row) return undefined;
        const age = Date.now() - Date.parse(row.updatedAt);
        return age < 30 * 60_000 ? row.id : undefined;
      },
      // 開発時のみ署名検証をスキップできる (本番では常に検証)
      verify:
        !config.isProd && process.env.ALEXA_SKIP_VERIFY === '1'
          ? async () => undefined
          : undefined,
    }),
  );

  // PWA静的配信 (apps/web/dist)
  const webDist = resolve(__dirname, '../../web/dist');
  if (existsSync(webDist)) {
    app.use('/*', serveStatic({ root: webDist, rewriteRequestPath: (p) => p }));
    // SPAフォールバック
    const indexHtml = readFileSync(join(webDist, 'index.html'), 'utf8');
    app.get('*', (c) => c.html(indexHtml));
  } else {
    app.get('/', (c) => c.text('Aide server: web build がありません (npm run build を実行してください)'));
  }

  const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`[boot] Aide server: http://localhost:${info.port}`);
    console.log(`[boot] Mac Agent WS: /agent/ws (Bearer認証)`);
  });

  // Mac Agent用WebSocketアップグレード
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/agent/ws') {
      gateway.handleUpgrade(req, socket, head as Buffer);
    } else {
      socket.destroy();
    }
  });

  scheduler.start();

  process.on('SIGTERM', () => {
    scheduler.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[boot] 起動失敗:', err);
  process.exit(1);
});
