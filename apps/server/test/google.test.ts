import { describe, expect, it } from 'vitest';
import { makeTestEnv } from './helpers.js';
import type { GoogleAuth } from '../src/google/oauth.js';

/** 接続済みのGoogleAuthを模し、APIレスポンスを差し替える */
function connectGoogle(env: ReturnType<typeof makeTestEnv>, responses: Record<string, unknown>) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  env.ctx.googleAuth = {
    connected: () => true,
    status: () => ({ connected: true, email: 'me@example.com' }),
    api: async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      const key = Object.keys(responses).find((k) => path.includes(k));
      if (!key) throw new Error(`unexpected path: ${path}`);
      return responses[key];
    },
  } as unknown as GoogleAuth;
  return calls;
}

describe('Google連携ツール', () => {
  it('未接続なら「未接続」と明示して返す (勝手に別手段へ回さない)', async () => {
    const env = makeTestEnv();
    for (const tool of ['calendar.read', 'mail.search', 'contacts.search']) {
      const input = tool === 'contacts.search' ? { name: '田中' } : tool === 'mail.search' ? { query: 'x' } : {};
      const result = await env.registry.execute(tool, input, env.ctx);
      expect(result.ok, tool).toBe(false);
      expect(result.error, tool).toContain('未接続');
    }
  });

  it('calendar.read はJSTに変換して返す', async () => {
    const env = makeTestEnv();
    connectGoogle(env, {
      '/calendar/v3/calendars/primary/events': {
        items: [
          {
            id: 'e1',
            summary: '歯医者',
            start: { dateTime: '2026-08-25T01:00:00Z' }, // JST 10:00
            end: { dateTime: '2026-08-25T02:00:00Z' },
            location: '駅前',
          },
        ],
      },
    });
    const result = await env.registry.execute('calendar.read', {}, env.ctx);
    expect(result.ok).toBe(true);
    const items = result.data as Array<{ title: string; start: string }>;
    expect(items[0].title).toBe('歯医者');
    expect(items[0].start).toContain('10:00');
  });

  it('calendar.create は初回のみ確認が必要 (ask_once)', async () => {
    const env = makeTestEnv();
    connectGoogle(env, { '/calendar/v3/calendars/primary/events': { id: 'created-1' } });
    const first = await env.registry.execute(
      'calendar.create',
      { title: '打ち合わせ', start: '2026-08-25T10:00:00+09:00' },
      env.ctx,
    );
    expect(first.ok).toBe(false);
    expect(first.pendingApprovalId).toBeTruthy();

    // 初回承認後は自動許可になる
    env.permissions.markGrantedOnce('calendar_write');
    const second = await env.registry.execute(
      'calendar.create',
      { title: '打ち合わせ', start: '2026-08-25T10:00:00+09:00' },
      env.ctx,
    );
    expect(second.ok).toBe(true);
  });

  it('calendar.create は作成した予定をUndo可能として記録する', async () => {
    const env = makeTestEnv();
    connectGoogle(env, { '/calendar/v3/calendars/primary/events': { id: 'created-1' } });
    env.permissions.markGrantedOnce('calendar_write');
    const result = await env.registry.execute(
      'calendar.create',
      { title: '打ち合わせ', start: '2026-08-25T10:00:00+09:00' },
      env.ctx,
    );
    expect(result.ok).toBe(true);
    const action = env.db.$client
      .prepare("SELECT * FROM actions WHERE tool='calendar' ORDER BY created_at DESC")
      .get() as { undo_available: number };
    expect(action.undo_available).toBe(1);
  });

  it('mail.send は承認必須 (Risk Engineがmail_sendに分類)', async () => {
    const env = makeTestEnv();
    connectGoogle(env, { '/messages/send': {} });
    const result = await env.registry.execute(
      'mail.send',
      { to: 'a@example.com', subject: '件名', body: '本文' },
      env.ctx,
    );
    // 既定は always_ask → 実行されず承認待ち
    expect(result.ok).toBe(false);
    expect(result.pendingApprovalId).toBeTruthy();
  });

  it('mail.send は承認後に日本語件名をMIMEエンコードして送る', async () => {
    const env = makeTestEnv();
    const calls = connectGoogle(env, { '/messages/send': {} });
    const result = await env.registry.execute(
      'mail.send',
      { to: 'a@example.com', subject: '打ち合わせの件', body: 'よろしくお願いします' },
      env.ctx,
      { skipPermission: true },
    );
    expect(result.ok).toBe(true);
    const body = JSON.parse(String(calls[0].init?.body)) as { raw: string };
    const decoded = Buffer.from(body.raw, 'base64url').toString('utf8');
    expect(decoded).toContain('=?UTF-8?B?'); // 件名はMIMEエンコード
    expect(decoded).toContain('To: a@example.com');
  });

  it('mail.send の結果は取り消せない旨を含む', async () => {
    const env = makeTestEnv();
    connectGoogle(env, { '/messages/send': {} });
    const result = await env.registry.execute(
      'mail.send',
      { to: 'a@example.com', subject: 'x', body: 'y' },
      env.ctx,
      { skipPermission: true },
    );
    expect(String(result.data)).toContain('元に戻せません');
  });

  it('contacts.search は名前・メール・電話を返す', async () => {
    const env = makeTestEnv();
    connectGoogle(env, {
      'people:searchContacts': {
        results: [
          {
            person: {
              names: [{ displayName: '田中太郎' }],
              emailAddresses: [{ value: 'tanaka@example.com' }],
              phoneNumbers: [{ value: '090-0000-0000' }],
            },
          },
        ],
      },
    });
    const result = await env.registry.execute('contacts.search', { name: '田中' }, env.ctx);
    const items = result.data as Array<{ name: string; emails: string[] }>;
    expect(items[0].name).toBe('田中太郎');
    expect(items[0].emails[0]).toBe('tanaka@example.com');
  });
});
