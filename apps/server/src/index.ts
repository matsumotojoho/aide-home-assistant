// Aide server エントリポイント。
// - REST API (/api/*) + PWA静的配信 + Mac Agent WebSocket (/agent/ws)
// - ローカル (Mac mini) でも Railway でも同一コードで動作する。

import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { v4 as uuid } from 'uuid';
import { eq } from 'drizzle-orm';
import { config } from './config.js';
import { createDb } from './db/index.js';
import { users } from './db/schema.js';
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

  const registry = createRegistry();
  const providerSelector = createProviderSelector({
    settings,
    gateway,
    anthropicApiKey: config.anthropicApiKey,
  });

  const buildToolContext = (source: ToolContext['source']): ToolContext => ({
    db,
    userId,
    source,
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
      buildToolContext,
    }),
  );

  // Alexa Custom Skill (Phase 2)。/api配下ではなくトップレベル (セッション認証でなく署名検証)
  app.route(
    '/alexa',
    createAlexaApp({
      orchestrator,
      settings,
      push,
      userId,
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
