import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { desc, eq, and } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import type { PermissionMode, RiskCategory, SettingKey } from '@aide/shared';
import type { Db } from '../db/index.js';
import {
  actions,
  approvals,
  conversations,
  devices,
  memories,
  messages,
  notifications,
  tasks,
} from '../db/schema.js';
import type { AuthService } from '../auth.js';
import type { Orchestrator } from '../orchestrator.js';
import type { ToolRegistry, ToolContext } from '../tools/index.js';
import type { PushService } from '../push.js';
import type { SettingsService } from '../services/settings.js';
import type { MemoryService } from '../services/memory.js';
import type { PermissionService } from '../services/permissions.js';
import type { HomeAssistantClient } from '../ha/client.js';
import type { AgentGateway } from '../agentGateway.js';
import { applyUndo } from '../undo.js';
import { categorize } from '../risk.js';
import { LoginRateLimiter, clientKey } from '../rateLimit.js';
import type { GoogleAuth } from '../google/oauth.js';
import type { MessagingService } from '../messaging/channels.js';

export interface ApiDeps {
  db: Db;
  userId: string;
  auth: AuthService;
  orchestrator: Orchestrator;
  registry: ToolRegistry;
  push: PushService;
  settings: SettingsService;
  memory: MemoryService;
  permissions: PermissionService;
  ha: HomeAssistantClient;
  gateway: AgentGateway;
  googleAuth: GoogleAuth;
  messaging: MessagingService;
  buildToolContext: (source: ToolContext['source']) => ToolContext;
}

export function createApi(deps: ApiDeps): Hono {
  const api = new Hono();
  const { db, userId } = deps;

  /** 直近30分以内に更新された会話があれば、その続きとして扱う */
  const findRecentConversationId = (): string | undefined => {
    const row = db
      .select()
      .from(conversations)
      .where(eq(conversations.userId, userId))
      .orderBy(desc(conversations.updatedAt))
      .limit(1)
      .get();
    if (!row) return undefined;
    return Date.now() - Date.parse(row.updatedAt) < 30 * 60_000 ? row.id : undefined;
  };

  // ---------- auth ----------
  const loginLimiter = new LoginRateLimiter();

  api.post('/auth/login', async (c) => {
    const key = clientKey(c.req.raw.headers);
    const locked = loginLimiter.lockedFor(key);
    if (locked > 0) {
      const minutes = Math.ceil(locked / 60);
      return c.json({ error: `試行回数が多すぎます。${minutes}分ほど待ってから再度お試しください` }, 429);
    }

    const body = await c.req.json<{ password?: string }>().catch(() => ({ password: '' }));
    if (!body.password || !(await deps.auth.verifyPassword(body.password))) {
      loginLimiter.recordFailure(key);
      await new Promise((r) => setTimeout(r, 500)); // ブルートフォース抑制
      return c.json({ error: 'パスワードが違います' }, 401);
    }
    loginLimiter.recordSuccess(key);
    await deps.auth.issueSession(c, userId);
    return c.json({ ok: true });
  });

  api.post('/auth/logout', (c) => {
    deps.auth.clearSession(c);
    return c.json({ ok: true });
  });

  api.get('/auth/me', async (c) => {
    const uid = await deps.auth.verifySession(c);
    return uid ? c.json({ userId: uid }) : c.json({ error: 'unauthorized' }, 401);
  });

  // ---------- 認証必須ゾーン ----------
  api.use('/*', async (c, next) => {
    // login/me/logout以外は認証必須
    const path = c.req.path;
    if (path.endsWith('/auth/login') || path.endsWith('/auth/me') || path.endsWith('/auth/logout')) {
      return next();
    }
    const uid = await deps.auth.verifySession(c);
    if (!uid) return c.json({ error: 'unauthorized' }, 401);
    return next();
  });

  // ---------- chat ----------
  api.post('/chat', async (c) => {
    const body = await c.req.json<{ text?: string; conversationId?: string; source?: string }>();
    const text = (body.text ?? '').trim();
    if (!text) return c.json({ error: 'textが必要です' }, 400);
    const source = body.source === 'mobile' ? 'mobile' : 'web';
    // 明示指定が無ければ、直近30分の会話を入口に関わらず引き継ぐ。
    // (Alexaで話した直後にPWAで続けても文脈が切れないように)
    const conversationId = body.conversationId ?? findRecentConversationId();
    const result = await deps.orchestrator.handleUserMessage({
      userId,
      text,
      source,
      conversationId,
    });
    return c.json(result);
  });

  api.get('/conversations', (c) => {
    const rows = db
      .select()
      .from(conversations)
      .where(eq(conversations.userId, userId))
      .orderBy(desc(conversations.updatedAt))
      .limit(50)
      .all();
    return c.json(rows);
  });

  // 入口 (Alexa/Web/スマホ) をまたいだ統合タイムライン。
  // 仕様書2: どこから話しても同じユーザー・同じ会話として扱う。
  // Alexaが8秒で打ち切ってバックグラウンドで書いた回答も、ここに現れる。
  api.get('/messages/recent', (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 100), 300);
    const since = c.req.query('since');
    const rows = db.$client
      .prepare(
        `SELECT m.id, m.role, m.content, m.created_at AS createdAt,
                c.source, c.id AS conversationId
         FROM messages m JOIN conversations c ON c.id = m.conversation_id
         WHERE c.user_id = ?${since ? ' AND m.created_at > ?' : ''}
         ORDER BY m.created_at DESC, m.rowid DESC
         LIMIT ?`,
      )
      .all(...(since ? [userId, since, limit] : [userId, limit]));
    // 画面では古い順に並べる
    return c.json((rows as unknown[]).reverse());
  });

  api.get('/conversations/:id/messages', (c) => {
    const rows = db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, c.req.param('id')))
      .orderBy(messages.createdAt)
      .limit(200)
      .all();
    return c.json(rows);
  });

  // ---------- home ----------
  api.get('/home', async (c) => {
    const deviceRows = db.select().from(devices).where(eq(devices.userId, userId)).all();
    let states: unknown[] = [];
    let haError: string | null = null;
    if (deps.ha.configured()) {
      try {
        const all = await deps.ha.getStates();
        const ids = new Set(deviceRows.map((d) => d.entityId));
        states = ids.size > 0 ? all.filter((s) => ids.has(s.entity_id)) : all;
      } catch (err) {
        haError = err instanceof Error ? err.message : String(err);
      }
    } else {
      haError = 'Home Assistant未設定';
    }
    return c.json({
      configured: deps.ha.configured(),
      error: haError,
      devices: deviceRows.map((d) => ({ ...d, aliases: d.aliases ? JSON.parse(d.aliases) : [] })),
      states,
    });
  });

  api.post('/home/execute', async (c) => {
    const body = await c.req.json<{ entityId: string; service: string; data?: Record<string, unknown> }>();
    const ctx = deps.buildToolContext('web');
    const result = await deps.registry.execute(
      'home.execute',
      { entity_id: body.entityId, service: body.service, data: body.data },
      ctx,
    );
    return c.json(result);
  });

  const deviceSchema = z.object({
    entityId: z.string().min(1),
    name: z.string().min(1),
    room: z.string().nullable().optional(),
    type: z.string().min(1),
    aliases: z.array(z.string()).optional(),
  });

  api.get('/devices', (c) => {
    const rows = db.select().from(devices).where(eq(devices.userId, userId)).all();
    return c.json(rows.map((d) => ({ ...d, aliases: d.aliases ? JSON.parse(d.aliases) : [] })));
  });

  api.post('/devices', async (c) => {
    const body = deviceSchema.safeParse(await c.req.json());
    if (!body.success) return c.json({ error: body.error.issues[0]?.message }, 400);
    const id = uuid();
    db.insert(devices)
      .values({
        id,
        userId,
        entityId: body.data.entityId,
        name: body.data.name,
        room: body.data.room ?? null,
        type: body.data.type,
        aliases: JSON.stringify(body.data.aliases ?? []),
        createdAt: new Date().toISOString(),
      })
      .run();
    return c.json({ ok: true, id });
  });

  api.patch('/devices/:id', async (c) => {
    const patch = deviceSchema.partial().safeParse(await c.req.json());
    if (!patch.success) return c.json({ error: patch.error.issues[0]?.message }, 400);
    const row = db
      .select()
      .from(devices)
      .where(and(eq(devices.id, c.req.param('id')), eq(devices.userId, userId)))
      .get();
    if (!row) return c.json({ error: 'not found' }, 404);
    db.update(devices)
      .set({
        entityId: patch.data.entityId ?? row.entityId,
        name: patch.data.name ?? row.name,
        // room は null での明示的なクリアを許可する
        room: patch.data.room !== undefined ? patch.data.room : row.room,
        type: patch.data.type ?? row.type,
        aliases: patch.data.aliases ? JSON.stringify(patch.data.aliases) : row.aliases,
      })
      .where(eq(devices.id, row.id))
      .run();
    const updated = db.select().from(devices).where(eq(devices.id, row.id)).get()!;
    return c.json({ ...updated, aliases: updated.aliases ? JSON.parse(updated.aliases) : [] });
  });

  api.delete('/devices/:id', (c) => {
    db.delete(devices).where(and(eq(devices.id, c.req.param('id')), eq(devices.userId, userId))).run();
    return c.json({ ok: true });
  });

  // ---------- tasks ----------
  api.get('/tasks', (c) => {
    const rows = db
      .select()
      .from(tasks)
      .where(eq(tasks.userId, userId))
      .orderBy(desc(tasks.runAt))
      .limit(100)
      .all();
    return c.json(rows.map((t) => ({ ...t, plan: JSON.parse(t.plan) })));
  });

  api.post('/tasks/:id/cancel', async (c) => {
    const ctx = deps.buildToolContext('web');
    const result = await deps.registry.execute('tasks.cancel', { id: c.req.param('id') }, ctx);
    return c.json(result);
  });

  api.patch('/tasks/:id', async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const ctx = deps.buildToolContext('web');
    const result = await deps.registry.execute('tasks.update', { id: c.req.param('id'), ...body }, ctx);
    return c.json(result);
  });

  // ---------- history (actions) ----------
  api.get('/actions', (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 100), 300);
    const rows = db
      .select()
      .from(actions)
      .where(eq(actions.userId, userId))
      .orderBy(desc(actions.createdAt))
      .limit(limit)
      .all();
    return c.json(rows);
  });

  api.post('/actions/:id/undo', async (c) => {
    const result = await applyUndo(db, deps.ha, c.req.param('id'), deps.googleAuth);
    return c.json(result, result.ok ? 200 : 400);
  });

  // ---------- memory ----------
  api.get('/memories', (c) => {
    const kind = c.req.query('kind');
    const query = c.req.query('q');
    if (query) return c.json(deps.memory.search(query, 30));
    return c.json(deps.memory.list(kind || undefined, 200));
  });

  api.post('/memories', async (c) => {
    const body = await c.req.json<{ kind?: string; title?: string; content?: string; tags?: string[] }>();
    if (!body.title || !body.content) return c.json({ error: 'title/contentが必要です' }, 400);
    const row = deps.memory.write({
      kind: (body.kind as 'memory' | 'preference' | 'decision') ?? 'memory',
      title: body.title,
      content: body.content,
      tags: body.tags,
      source: 'manual',
    });
    return c.json(row);
  });

  api.patch('/memories/:id', async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const row = deps.memory.update(c.req.param('id'), body as never);
    return row ? c.json(row) : c.json({ error: 'not found' }, 404);
  });

  api.delete('/memories/:id', (c) => {
    const ok = deps.memory.delete(c.req.param('id'));
    return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  // ---------- settings / permissions ----------
  api.get('/settings', (c) => c.json(deps.settings.getAll()));

  api.put('/settings', async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    for (const [key, value] of Object.entries(body)) {
      deps.settings.set(key as SettingKey, value as never);
    }
    return c.json(deps.settings.getAll());
  });

  api.get('/permissions', (c) => c.json(deps.permissions.listAll()));

  api.patch('/permissions/:category', async (c) => {
    const body = await c.req.json<{ mode?: PermissionMode }>();
    const modes: PermissionMode[] = ['ask_once', 'always_ask', 'always_allow', 'deny'];
    if (!body.mode || !modes.includes(body.mode)) return c.json({ error: 'modeが不正です' }, 400);
    deps.permissions.setMode(c.req.param('category') as RiskCategory, body.mode);
    return c.json(deps.permissions.listAll());
  });

  // ---------- approvals ----------
  api.get('/approvals', (c) => {
    const status = c.req.query('status') ?? 'pending';
    const rows = db
      .select()
      .from(approvals)
      .where(and(eq(approvals.userId, userId), eq(approvals.status, status)))
      .orderBy(desc(approvals.createdAt))
      .limit(50)
      .all();
    return c.json(rows.map((a) => ({ ...a, payload: JSON.parse(a.payload) })));
  });

  api.post('/approvals/:id/respond', async (c) => {
    const body = await c.req.json<{ action: 'approve' | 'reject'; editedInput?: Record<string, unknown> }>();
    const row = db
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, c.req.param('id')), eq(approvals.userId, userId)))
      .get();
    if (!row) return c.json({ error: 'not found' }, 404);
    if (row.status !== 'pending') return c.json({ error: `この承認はすでに${row.status}です` }, 400);

    const now = new Date().toISOString();
    if (body.action === 'reject') {
      db.update(approvals).set({ status: 'rejected', resolvedAt: now }).where(eq(approvals.id, row.id)).run();
      return c.json({ ok: true, status: 'rejected' });
    }

    // 承認 → 実行 (編集された入力があれば差し替え)
    const payload = JSON.parse(row.payload) as { tool: string; input: Record<string, unknown>; category: string };
    const input = body.editedInput ?? payload.input;
    const ctx = deps.buildToolContext('mobile');
    const result = await deps.registry.execute(payload.tool, input, ctx, {
      skipPermission: true,
      approvalId: row.id,
    });

    // ask_onceカテゴリなら以後自動許可 (仕様書14: 最初の1回だけ許可→以後自動)
    const category = categorize(payload.tool, input);
    const mode = deps.permissions.getMode(category);
    if (mode.mode === 'ask_once') deps.permissions.markGrantedOnce(category);

    db.update(approvals)
      .set({ status: 'approved', resolvedAt: now, result: JSON.stringify(result) })
      .where(eq(approvals.id, row.id))
      .run();
    return c.json({ ok: true, status: 'approved', result });
  });

  // ---------- notifications / push ----------
  api.get('/notifications', (c) => {
    const rows = db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt))
      .limit(50)
      .all();
    return c.json(rows);
  });

  api.get('/push/vapid-public-key', (c) => c.json({ key: deps.push.vapidPublicKey() }));

  api.post('/push/subscribe', async (c) => {
    const sub = await c.req.json<{ endpoint?: string; keys?: unknown }>();
    if (!sub.endpoint || !sub.keys) return c.json({ error: 'invalid subscription' }, 400);
    deps.push.saveSubscription(userId, { endpoint: sub.endpoint, keys: sub.keys });
    return c.json({ ok: true });
  });

  // ---------- Google連携 (Phase 3) ----------
  api.get('/google/status', (c) => c.json(deps.googleAuth.status()));

  api.post('/google/credentials', async (c) => {
    const body = await c.req.json<{ clientId?: string; clientSecret?: string }>();
    if (!body.clientId || !body.clientSecret) {
      return c.json({ error: 'クライアントIDとシークレットが必要です' }, 400);
    }
    deps.googleAuth.setCredentials(body.clientId.trim(), body.clientSecret.trim());
    return c.json({ ok: true });
  });

  api.get('/google/auth-url', (c) => {
    // stateはCSRF対策。Cookieに入れてcallbackで照合する
    const state = uuid();
    setCookie(c, 'google_oauth_state', state, {
      httpOnly: true,
      secure: c.req.url.startsWith('https'),
      sameSite: 'Lax',
      path: '/',
      maxAge: 600,
    });
    const url = deps.googleAuth.authUrl(state);
    if (!url) return c.json({ error: '先にクライアントIDとシークレットを設定してください' }, 400);
    return c.json({ url });
  });

  api.post('/google/disconnect', (c) => {
    deps.googleAuth.disconnect();
    return c.json({ ok: true });
  });

  // ---------- メッセージ連携 (LINE / Slack) ----------
  api.get('/messaging/status', (c) => {
    const config = deps.messaging.getConfig();
    return c.json({
      ...deps.messaging.status(),
      lineDefaultTo: config.lineDefaultTo ? '設定済み' : '',
      slackDefaultTo: config.slackDefaultTo ?? '',
    });
  });

  api.post('/messaging/config', async (c) => {
    const body = await c.req.json<Record<string, string>>();
    // 空文字は「変更しない」ではなく「クリア」として扱えるよう、キーの有無で判定する
    const patch: Record<string, string> = {};
    for (const key of ['lineToken', 'lineDefaultTo', 'slackToken', 'slackDefaultTo']) {
      if (key in body) patch[key] = String(body[key] ?? '').trim();
    }
    deps.messaging.setConfig(patch);
    return c.json({ ok: true, ...deps.messaging.status() });
  });

  // ---------- status / agent ----------
  api.get('/status', async (c) => {
    return c.json({
      ha: { configured: deps.ha.configured() },
      macAgent: deps.gateway.status(),
      provider: deps.settings.get('ai.provider'),
      paidApiFallback: deps.settings.get('ai.paid_api_fallback'),
    });
  });

  // ---------- ChatGPT会話インポート (仕様書11 / 完全対応はPhase 3) ----------
  api.post('/import/chatgpt', async (c) => {
    // ChatGPT Data Export の conversations.json を受け取り、memoriesへ取り込む
    const body = await c.req.json<unknown>().catch(() => null);
    if (!Array.isArray(body)) {
      return c.json({ error: 'ChatGPTエクスポートの conversations.json (配列) を送信してください' }, 400);
    }
    let imported = 0;
    for (const conv of body as Array<Record<string, unknown>>) {
      const title = String(conv.title ?? '無題の会話');
      const mapping = conv.mapping as Record<string, { message?: { author?: { role?: string }; content?: { parts?: unknown[] } } }> | undefined;
      if (!mapping) continue;
      const lines: string[] = [];
      for (const node of Object.values(mapping)) {
        const m = node.message;
        if (!m?.content?.parts) continue;
        const role = m.author?.role ?? 'user';
        const textParts = m.content.parts.filter((p): p is string => typeof p === 'string' && p.length > 0);
        if (textParts.length > 0) lines.push(`${role === 'user' ? 'ユーザー' : 'ChatGPT'}: ${textParts.join('\n')}`);
      }
      if (lines.length === 0) continue;
      deps.memory.write({
        kind: 'imported',
        title: `[ChatGPT] ${title}`.slice(0, 200),
        content: lines.join('\n').slice(0, 50_000),
        source: 'chatgpt_import',
      });
      imported++;
    }
    return c.json({ ok: true, imported });
  });

  // ---------- Alexa (Phase 2) ----------
  api.post('/alexa', (c) =>
    c.json({ error: 'AlexaエンドポイントはトップレベルURLの /alexa です (docs/setup.md参照)' }, 404),
  );

  return api;
}
