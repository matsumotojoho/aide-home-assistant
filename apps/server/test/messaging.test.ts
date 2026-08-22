import { describe, expect, it, vi, afterEach } from 'vitest';
import { makeTestEnv } from './helpers.js';
import { approvals } from '../src/db/schema.js';

afterEach(() => vi.unstubAllGlobals());

describe('メッセージ送信 (仕様書16)', () => {
  it('未接続のチャネルは「未接続」と返す', async () => {
    const env = makeTestEnv();
    const result = await env.registry.execute(
      'message.send',
      { to: 'U123', channel: 'line', body: '遅れます' },
      env.ctx,
      { skipPermission: true },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('LINE');
    expect(result.error).toContain('未接続');
  });

  it('人への送信は承認必須で、承認画面に相手と手段が日本語で出る', async () => {
    const env = makeTestEnv();
    env.messaging.setConfig({ lineToken: 'dummy' });

    const result = await env.registry.execute(
      'message.send',
      { to: 'U123', channel: 'line', body: '30分ほど遅れます。すみません。', recipient_name: '田中さん' },
      env.ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.pendingApprovalId).toBeTruthy();

    const row = env.db.select().from(approvals).all()[0];
    expect(row.title).toBe('田中さんへLINEでメッセージを送信します');
    // 承認画面で本文を修正できるよう、入力がそのまま保持される
    const payload = JSON.parse(row.payload) as { input: { body: string } };
    expect(payload.input.body).toContain('30分ほど遅れます');
  });

  it('承認後はLINE APIへ送信され、取り消せない旨を返す', async () => {
    const env = makeTestEnv();
    env.messaging.setConfig({ lineToken: 'dummy-token' });
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response('{}', { status: 200 });
    });

    const result = await env.registry.execute(
      'message.send',
      { to: 'U123', channel: 'line', body: '遅れます', recipient_name: '田中さん' },
      env.ctx,
      { skipPermission: true },
    );
    expect(result.ok).toBe(true);
    expect(calls[0].url).toContain('api.line.me');
    expect(calls[0].body).toMatchObject({ to: 'U123', messages: [{ type: 'text', text: '遅れます' }] });
    expect(String(result.data)).toContain('元に戻せません');
  });

  it('LINE APIが失敗したら平易なエラーを返す (生のレスポンスを見せない)', async () => {
    const env = makeTestEnv();
    env.messaging.setConfig({ lineToken: 'bad' });
    vi.stubGlobal('fetch', async () => new Response('{"message":"Invalid token"}', { status: 401 }));

    const result = await env.registry.execute(
      'message.send',
      { to: 'U1', channel: 'line', body: 'x' },
      env.ctx,
      { skipPermission: true },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBe('LINEへの送信に失敗しました');
  });

  it('Slackはok:falseの応答も失敗として扱う (HTTP200でもエラーを返すため)', async () => {
    const env = makeTestEnv();
    env.messaging.setConfig({ slackToken: 'xoxb-dummy' });
    vi.stubGlobal('fetch', async () => new Response('{"ok":false,"error":"channel_not_found"}', { status: 200 }));

    const result = await env.registry.execute(
      'message.send',
      { to: '#nope', channel: 'slack', body: 'x' },
      env.ctx,
      { skipPermission: true },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Slack');
  });

  it('message.channels は使える手段を返す', async () => {
    const env = makeTestEnv();
    env.messaging.setConfig({ slackToken: 'xoxb-dummy', slackDefaultTo: '#general' });
    const result = await env.registry.execute('message.channels', {}, env.ctx);
    const data = result.data as { available: string[] };
    expect(data.available).toContain('slack');
    expect(data.available).not.toContain('line');
  });
});
