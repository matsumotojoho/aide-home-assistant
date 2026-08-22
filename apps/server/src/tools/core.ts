import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type { ToolDef } from './registry.js';
import { RECURRENCE_RE, isValidRecurrence } from '../recurrence.js';
import { tasks } from '../db/schema.js';

// ---------- memory.* ----------
export const memorySearch: ToolDef = {
  name: 'memory.search',
  description: '長期記憶(会話・好み・過去の操作・決定事項・インポート済みChatGPT履歴)を全文検索する',
  inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(20).optional() }),
  inputDoc: '{"query":"寝室 温度", "limit"?: 8}',
  async execute(ctx, input) {
    const rows = ctx.memory.search(String(input.query), (input.limit as number) ?? 8);
    return {
      ok: true,
      data: rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, content: r.content, updatedAt: r.updatedAt })),
      summary: `記憶検索 "${input.query}" → ${rows.length}件`,
    };
  },
};

export const memoryWrite: ToolDef = {
  name: 'memory.write',
  description: '新しい記憶・好み・決定事項を保存する。単発の指示ではなく恒常的な好みのみpreferenceにする。',
  inputSchema: z.object({
    kind: z.enum(['memory', 'preference', 'decision']),
    title: z.string().min(1).max(200),
    content: z.string().min(1),
    tags: z.array(z.string()).optional(),
  }),
  inputDoc: '{"kind":"preference","title":"夏の寝室温度","content":"25〜26℃を好む","tags"?:["climate"]}',
  async execute(ctx, input) {
    if (input.kind === 'preference' && ctx.settings.get('learning.enabled') !== 'on') {
      return { ok: false, error: '学習は設定でOFFになっています' };
    }
    const row = ctx.memory.write({
      kind: input.kind as 'memory' | 'preference' | 'decision',
      title: String(input.title),
      content: String(input.content),
      tags: input.tags as string[] | undefined,
      source: 'learning',
    });
    return { ok: true, data: { id: row.id }, summary: `記憶を保存: ${row.title}`, target: row.id };
  },
};

export const memoryUpdate: ToolDef = {
  name: 'memory.update',
  description: '既存の記憶を更新する',
  inputSchema: z.object({
    id: z.string().min(1),
    title: z.string().optional(),
    content: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }),
  inputDoc: '{"id":"...","content":"新しい内容"}',
  async execute(ctx, input) {
    const row = ctx.memory.update(String(input.id), {
      title: input.title as string | undefined,
      content: input.content as string | undefined,
      tags: input.tags as string[] | undefined,
    });
    if (!row) return { ok: false, error: '対象の記憶が見つかりません' };
    return { ok: true, data: { id: row.id }, summary: `記憶を更新: ${row.title}` };
  },
};

export const memoryDelete: ToolDef = {
  name: 'memory.delete',
  description: '記憶を削除する',
  inputSchema: z.object({ id: z.string().min(1) }),
  inputDoc: '{"id":"..."}',
  async execute(ctx, input) {
    const ok = ctx.memory.delete(String(input.id));
    return ok ? { ok: true, summary: '記憶を削除' } : { ok: false, error: '対象の記憶が見つかりません' };
  },
};

// ---------- tasks.* ----------
const planSchema = z.array(z.object({ tool: z.string(), input: z.record(z.unknown()) })).min(1);

export const tasksCreate: ToolDef = {
  name: 'tasks.create',
  description:
    '予約タスクを作成する。ユーザー依頼から生成されたタスクは指定時刻に自動実行される。reevaluate=trueなら実行直前に状況(室温・天気・帰宅予定など)を再確認して設定値を再計算する。',
  inputSchema: z.object({
    title: z.string().min(1).max(200),
    run_at: z.string().min(1), // ISO 8601 (タイムゾーン付き)
    plan: planSchema,
    reevaluate: z.boolean().optional(),
    intent_text: z.string().optional(),
    recurrence: z
      .string()
      .regex(RECURRENCE_RE, 'recurrenceは daily@HH:MM または weekly:MON@HH:MM 形式 (JST)')
      .optional(),
  }),
  inputDoc:
    '{"title":"帰宅前の冷房","run_at":"2026-08-20T18:30:00+09:00","plan":[{"tool":"home.execute","input":{...}}],"reevaluate":true,"intent_text":"19時に帰るから快適にしといて"} ' +
    '毎日/毎週の繰り返しはrecurrence:"daily@07:00"等 (JST)',
  async execute(ctx, input) {
    const runAt = new Date(String(input.run_at));
    if (Number.isNaN(runAt.getTime())) return { ok: false, error: 'run_at の日時形式が不正です (ISO 8601で指定)' };
    const recurrence = (input.recurrence as string | undefined) ?? null;
    if (recurrence && !isValidRecurrence(recurrence)) {
      return { ok: false, error: 'recurrenceの形式が不正です (daily@HH:MM / weekly:MON@HH:MM)' };
    }
    const now = new Date().toISOString();
    const id = uuid();
    ctx.db
      .insert(tasks)
      .values({
        id,
        userId: ctx.userId,
        title: String(input.title),
        runAt: runAt.toISOString(),
        recurrence,
        plan: JSON.stringify(input.plan),
        reevaluate: input.reevaluate ? 1 : 0,
        intentText: (input.intent_text as string) ?? null,
        status: 'scheduled',
        createdFrom: ctx.source,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    return {
      ok: true,
      data: { id, run_at: runAt.toISOString() },
      summary: `予約タスク作成: ${input.title} (${runAt.toISOString()})`,
      target: id,
    };
  },
};

export const tasksUpdate: ToolDef = {
  name: 'tasks.update',
  description: '予約タスクの時刻や内容を変更する',
  inputSchema: z.object({
    id: z.string().min(1),
    title: z.string().optional(),
    run_at: z.string().optional(),
    plan: planSchema.optional(),
    reevaluate: z.boolean().optional(),
  }),
  inputDoc: '{"id":"...","run_at":"2026-08-20T18:00:00+09:00"}',
  async execute(ctx, input) {
    const row = ctx.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, String(input.id)), eq(tasks.userId, ctx.userId)))
      .get();
    if (!row) return { ok: false, error: '対象のタスクが見つかりません' };
    if (row.status !== 'scheduled') return { ok: false, error: `このタスクは変更できません (状態: ${row.status})` };
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (input.title) patch.title = input.title;
    if (input.run_at) {
      const d = new Date(String(input.run_at));
      if (Number.isNaN(d.getTime())) return { ok: false, error: 'run_at の日時形式が不正です' };
      patch.runAt = d.toISOString();
    }
    if (input.plan) patch.plan = JSON.stringify(input.plan);
    if (input.reevaluate !== undefined) patch.reevaluate = input.reevaluate ? 1 : 0;
    ctx.db.update(tasks).set(patch).where(eq(tasks.id, row.id)).run();
    return { ok: true, summary: `タスク更新: ${row.title}`, target: row.id };
  },
};

export const tasksCancel: ToolDef = {
  name: 'tasks.cancel',
  description: '予約タスクをキャンセルする',
  inputSchema: z.object({ id: z.string().min(1) }),
  inputDoc: '{"id":"..."}',
  async execute(ctx, input) {
    const row = ctx.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, String(input.id)), eq(tasks.userId, ctx.userId)))
      .get();
    if (!row) return { ok: false, error: '対象のタスクが見つかりません' };
    if (row.status !== 'scheduled' && row.status !== 'running') {
      return { ok: false, error: `このタスクはキャンセルできません (状態: ${row.status})` };
    }
    ctx.db
      .update(tasks)
      .set({ status: 'canceled', updatedAt: new Date().toISOString() })
      .where(eq(tasks.id, row.id))
      .run();
    return { ok: true, summary: `タスクをキャンセル: ${row.title}`, target: row.id };
  },
};

export const tasksList: ToolDef = {
  name: 'tasks.list',
  description: '予約中・実行済みタスクの一覧を取得する',
  inputSchema: z.object({ status: z.enum(['scheduled', 'done', 'canceled', 'failed', 'all']).optional() }),
  inputDoc: '{"status"?:"scheduled"}',
  async execute(ctx, input) {
    const status = (input.status as string) ?? 'scheduled';
    const rows =
      status === 'all'
        ? ctx.db.select().from(tasks).where(eq(tasks.userId, ctx.userId)).all()
        : ctx.db
            .select()
            .from(tasks)
            .where(and(eq(tasks.userId, ctx.userId), inArray(tasks.status, [status])))
            .all();
    return {
      ok: true,
      data: rows.map((r) => ({
        id: r.id,
        title: r.title,
        run_at: r.runAt,
        status: r.status,
        recurrence: r.recurrence,
        reevaluate: r.reevaluate === 1,
        plan: JSON.parse(r.plan),
      })),
      summary: `タスク一覧 (${status}) → ${rows.length}件`,
    };
  },
};

// ---------- notification / system / web ----------
export const notificationSend: ToolDef = {
  name: 'notification.send',
  description: 'ユーザーのスマホ/PCへ通知を送る (Web Push)',
  inputSchema: z.object({
    title: z.string().min(1).max(100),
    body: z.string().max(500).optional(),
    level: z.enum(['info', 'important', 'failure']).optional(),
  }),
  inputDoc: '{"title":"冷房を開始しました","body"?:"...","level"?:"info"}',
  async execute(ctx, input) {
    await ctx.push.notify(
      ctx.userId,
      ctx.settings,
      (input.level as 'info' | 'important' | 'failure') ?? 'info',
      String(input.title),
      String(input.body ?? ''),
    );
    return { ok: true, summary: `通知送信: ${input.title}` };
  },
};

export const systemGetContext: ToolDef = {
  name: 'system.get_context',
  description: '現在時刻(JST)・天気・外気温・家の状態サマリ・Mac Agent状態を取得する',
  inputSchema: z.object({}),
  inputDoc: '{}',
  async execute(ctx) {
    const now = new Date();
    const jst = now.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false });
    const context: Record<string, unknown> = { now_jst: jst, now_utc: now.toISOString() };

    // 天気 (Open-Meteo: 無料・キー不要)
    const loc = ctx.settings.get('home.location');
    if (loc) {
      const [lat, lon] = loc.split(',').map((s) => s.trim());
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code&timezone=Asia%2FTokyo`,
          { signal: ctrl.signal },
        );
        clearTimeout(timer);
        if (res.ok) {
          const w = (await res.json()) as { current?: Record<string, unknown> };
          context.weather = w.current;
        }
      } catch {
        context.weather = '取得失敗';
      }
    }

    if (ctx.ha.configured()) {
      try {
        const states = await ctx.ha.getStates();
        const interesting = states.filter((s) =>
          /^(light|climate|media_player|switch|sensor)\./.test(s.entity_id),
        );
        context.home = interesting.slice(0, 40).map((s) => ({
          entity_id: s.entity_id,
          state: s.state,
          temp: s.attributes['current_temperature'] ?? s.attributes['temperature'],
        }));
      } catch {
        context.home = 'Home Assistant接続エラー';
      }
    }

    context.mac_agent = ctx.gateway.status();
    return { ok: true, data: context, summary: 'コンテキスト取得' };
  },
};

export const webFetch: ToolDef = {
  name: 'web.fetch',
  description: '指定URLのページ内容をテキストで取得する',
  inputSchema: z.object({ url: z.string().url() }),
  inputDoc: '{"url":"https://example.com"}',
  async execute(_ctx, input) {
    const url = String(input.url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AideAgent/0.1)' },
        redirect: 'follow',
      });
      const html = await res.text();
      const text = htmlToText(html).slice(0, 60_000);
      return { ok: true, data: { url, status: res.status, text }, summary: `web.fetch ${url}`, target: url };
    } finally {
      clearTimeout(timer);
    }
  },
};

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
