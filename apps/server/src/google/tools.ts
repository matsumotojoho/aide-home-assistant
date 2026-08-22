// Google連携ツール (Phase 3): Calendar / Gmail / Contacts。
// 未接続時は「未接続」と明示して返す (勝手に別手段へ回さない)。
// メール送信は Risk Engine により承認必須 (mail_send)。

import { z } from 'zod';
import type { ToolDef, ToolContext } from '../tools/registry.js';
import type { GoogleAuth } from './oauth.js';

type GoogleAuthFactory = (ctx: ToolContext) => GoogleAuth;

const JST = 'Asia/Tokyo';

function fmtJst(iso: string | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('ja-JP', { timeZone: JST, hour12: false });
  } catch {
    return iso;
  }
}

function notConnected() {
  return { ok: false as const, error: 'Googleが未接続です。設定タブのGoogle連携から接続してください' };
}

interface CalendarEvent {
  id: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
  description?: string;
}

export function createGoogleTools(getAuth: GoogleAuthFactory): ToolDef[] {
  // ---------- Calendar ----------
  const calendarRead: ToolDef = {
    name: 'calendar.read',
    description: 'Googleカレンダーの予定を取得する (既定は今日から7日間)',
    inputSchema: z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      query: z.string().optional(),
      max: z.number().int().min(1).max(50).optional(),
    }),
    inputDoc: '{"from"?:"2026-08-21T00:00:00+09:00","to"?:"2026-08-28T00:00:00+09:00","query"?:"会議"}',
    async execute(ctx, input) {
      const auth = getAuth(ctx);
      if (!auth.connected()) return notConnected();
      const from = input.from ? new Date(String(input.from)) : new Date();
      const to = input.to ? new Date(String(input.to)) : new Date(Date.now() + 7 * 86400_000);
      const params = new URLSearchParams({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: String((input.max as number) ?? 20),
      });
      if (input.query) params.set('q', String(input.query));
      const data = (await auth.api(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
      )) as { items?: CalendarEvent[] };
      const items = (data.items ?? []).map((e) => ({
        id: e.id,
        title: e.summary ?? '(無題)',
        start: fmtJst(e.start?.dateTime) || e.start?.date || '',
        end: fmtJst(e.end?.dateTime) || e.end?.date || '',
        location: e.location,
      }));
      return { ok: true, data: items, summary: `予定 ${items.length}件を取得` };
    },
  };

  const calendarCreate: ToolDef = {
    name: 'calendar.create',
    description: 'Googleカレンダーに予定を作成する。日時はJSTのISO 8601で指定。',
    inputSchema: z.object({
      title: z.string().min(1),
      start: z.string().min(1),
      end: z.string().optional(),
      location: z.string().optional(),
      description: z.string().optional(),
    }),
    inputDoc: '{"title":"歯医者","start":"2026-08-25T10:00:00+09:00","end"?:"2026-08-25T11:00:00+09:00"}',
    async execute(ctx, input) {
      const auth = getAuth(ctx);
      if (!auth.connected()) return notConnected();
      const start = new Date(String(input.start));
      if (Number.isNaN(start.getTime())) return { ok: false, error: '開始日時の形式が不正です' };
      // 終了未指定なら1時間
      const end = input.end ? new Date(String(input.end)) : new Date(start.getTime() + 3600_000);
      const created = (await auth.api('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST',
        body: JSON.stringify({
          summary: input.title,
          location: input.location,
          description: input.description,
          start: { dateTime: start.toISOString(), timeZone: JST },
          end: { dateTime: end.toISOString(), timeZone: JST },
        }),
      })) as CalendarEvent;
      return {
        ok: true,
        data: { id: created.id },
        summary: `予定を作成: ${input.title} (${fmtJst(start.toISOString())})`,
        target: created.id,
        // 作成した予定は削除で取り消せる
        undo: { kind: 'calendar_event', restore: { eventId: created.id } },
      };
    },
  };

  const calendarUpdate: ToolDef = {
    name: 'calendar.update',
    description: 'カレンダーの予定を変更する',
    inputSchema: z.object({
      id: z.string().min(1),
      title: z.string().optional(),
      start: z.string().optional(),
      end: z.string().optional(),
      location: z.string().optional(),
    }),
    inputDoc: '{"id":"...","start":"2026-08-25T11:00:00+09:00"}',
    async execute(ctx, input) {
      const auth = getAuth(ctx);
      if (!auth.connected()) return notConnected();
      const patch: Record<string, unknown> = {};
      if (input.title) patch.summary = input.title;
      if (input.location) patch.location = input.location;
      if (input.start) patch.start = { dateTime: new Date(String(input.start)).toISOString(), timeZone: JST };
      if (input.end) patch.end = { dateTime: new Date(String(input.end)).toISOString(), timeZone: JST };
      await auth.api(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(String(input.id))}`,
        { method: 'PATCH', body: JSON.stringify(patch) },
      );
      return { ok: true, summary: '予定を変更しました', target: String(input.id) };
    },
  };

  const calendarDelete: ToolDef = {
    name: 'calendar.delete',
    description: 'カレンダーの予定を削除する',
    inputSchema: z.object({ id: z.string().min(1) }),
    inputDoc: '{"id":"..."}',
    async execute(ctx, input) {
      const auth = getAuth(ctx);
      if (!auth.connected()) return notConnected();
      await auth.api(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(String(input.id))}`,
        { method: 'DELETE' },
      );
      return { ok: true, summary: '予定を削除しました', target: String(input.id) };
    },
  };

  // ---------- Gmail ----------
  interface GmailMessage {
    id: string;
    threadId: string;
    snippet?: string;
    payload?: { headers?: Array<{ name: string; value: string }>; parts?: unknown[]; body?: { data?: string } };
  }

  const header = (m: GmailMessage, name: string) =>
    m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

  const mailSearch: ToolDef = {
    name: 'mail.search',
    description: 'Gmailを検索する (Gmailの検索構文が使える。例: from:tanaka is:unread newer_than:7d)',
    inputSchema: z.object({ query: z.string().min(1), max: z.number().int().min(1).max(20).optional() }),
    inputDoc: '{"query":"is:unread newer_than:3d","max"?:10}',
    async execute(ctx, input) {
      const auth = getAuth(ctx);
      if (!auth.connected()) return notConnected();
      const list = (await auth.api(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(String(input.query))}&maxResults=${(input.max as number) ?? 10}`,
      )) as { messages?: Array<{ id: string }> };
      const ids = (list.messages ?? []).slice(0, (input.max as number) ?? 10);
      const items = await Promise.all(
        ids.map(async (m) => {
          const full = (await auth.api(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
          )) as GmailMessage;
          return {
            id: full.id,
            from: header(full, 'From'),
            subject: header(full, 'Subject'),
            date: header(full, 'Date'),
            snippet: full.snippet,
          };
        }),
      );
      return { ok: true, data: items, summary: `メール ${items.length}件` };
    },
  };

  const mailRead: ToolDef = {
    name: 'mail.read',
    description: 'メール本文を読む',
    inputSchema: z.object({ id: z.string().min(1) }),
    inputDoc: '{"id":"..."}',
    async execute(ctx, input) {
      const auth = getAuth(ctx);
      if (!auth.connected()) return notConnected();
      const full = (await auth.api(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(String(input.id))}?format=full`,
      )) as GmailMessage;
      return {
        ok: true,
        data: {
          from: header(full, 'From'),
          to: header(full, 'To'),
          subject: header(full, 'Subject'),
          date: header(full, 'Date'),
          body: extractGmailBody(full).slice(0, 20_000),
        },
        summary: `メールを読んだ: ${header(full, 'Subject')}`,
      };
    },
  };

  const mailDraft: ToolDef = {
    name: 'mail.draft',
    description: 'メールの下書きを作成する (送信はしない)',
    inputSchema: z.object({
      to: z.string().min(1),
      subject: z.string().min(1),
      body: z.string().min(1),
    }),
    inputDoc: '{"to":"a@example.com","subject":"件名","body":"本文"}',
    async execute(ctx, input) {
      const auth = getAuth(ctx);
      if (!auth.connected()) return notConnected();
      const raw = buildRawMail(String(input.to), String(input.subject), String(input.body));
      const draft = (await auth.api('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
        method: 'POST',
        body: JSON.stringify({ message: { raw } }),
      })) as { id: string };
      return { ok: true, data: { draft_id: draft.id }, summary: `下書きを作成: ${input.subject}` };
    },
  };

  const mailSend: ToolDef = {
    name: 'mail.send',
    description:
      'メールを送信する。人への送信は承認必須 (Risk Engineが自動的に承認フローへ回す)。送信後は取り消せない。',
    inputSchema: z.object({
      to: z.string().min(1),
      subject: z.string().min(1),
      body: z.string().min(1),
    }),
    inputDoc: '{"to":"a@example.com","subject":"件名","body":"本文"}',
    async execute(ctx, input) {
      const auth = getAuth(ctx);
      if (!auth.connected()) return notConnected();
      const raw = buildRawMail(String(input.to), String(input.subject), String(input.body));
      await auth.api('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        body: JSON.stringify({ raw }),
      });
      return {
        ok: true,
        summary: `メール送信済み: ${input.to} 「${input.subject}」(この操作は元に戻せません)`,
        target: String(input.to),
      };
    },
  };

  // ---------- Contacts ----------
  const contactsSearch: ToolDef = {
    name: 'contacts.search',
    description: '連絡先を名前で検索し、メールアドレス・電話番号を返す',
    inputSchema: z.object({ name: z.string().min(1) }),
    inputDoc: '{"name":"田中"}',
    async execute(ctx, input) {
      const auth = getAuth(ctx);
      if (!auth.connected()) return notConnected();
      const data = (await auth.api(
        `https://people.googleapis.com/v1/people:searchContacts?query=${encodeURIComponent(String(input.name))}&readMask=names,emailAddresses,phoneNumbers`,
      )) as {
        results?: Array<{
          person?: {
            names?: Array<{ displayName?: string }>;
            emailAddresses?: Array<{ value?: string }>;
            phoneNumbers?: Array<{ value?: string }>;
          };
        }>;
      };
      const items = (data.results ?? []).map((r) => ({
        name: r.person?.names?.[0]?.displayName ?? '',
        emails: (r.person?.emailAddresses ?? []).map((e) => e.value).filter(Boolean),
        phones: (r.person?.phoneNumbers ?? []).map((p) => p.value).filter(Boolean),
      }));
      return { ok: true, data: items, summary: `連絡先 ${items.length}件` };
    },
  };

  return [
    calendarRead,
    calendarCreate,
    calendarUpdate,
    calendarDelete,
    mailSearch,
    mailRead,
    mailDraft,
    mailSend,
    contactsSearch,
  ];
}

/** RFC 2822形式のメールをbase64urlで組み立てる (日本語件名はMIMEエンコード) */
function buildRawMail(to: string, subject: string, body: string): string {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
  const mail = [
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body, 'utf8').toString('base64'),
  ].join('\r\n');
  return Buffer.from(mail, 'utf8').toString('base64url');
}

function extractGmailBody(msg: { payload?: unknown }): string {
  const decode = (data: string) => Buffer.from(data, 'base64url').toString('utf8');
  const walk = (part: Record<string, unknown>): string => {
    const mimeType = String(part.mimeType ?? '');
    const body = part.body as { data?: string } | undefined;
    if (mimeType === 'text/plain' && body?.data) return decode(body.data);
    const parts = part.parts as Array<Record<string, unknown>> | undefined;
    if (parts) {
      for (const p of parts) {
        const found = walk(p);
        if (found) return found;
      }
    }
    // text/plainが無ければHTMLをタグ除去して返す
    if (mimeType === 'text/html' && body?.data) {
      return decode(body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    return '';
  };
  return msg.payload ? walk(msg.payload as Record<string, unknown>) : '';
}
