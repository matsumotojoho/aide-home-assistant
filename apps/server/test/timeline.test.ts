// 入口をまたいだ統合タイムライン。
// Alexaが8秒で打ち切ってバックグラウンドで書いた回答が、PWAのChatに現れることを保証する。

import { describe, expect, it } from 'vitest';
import { v4 as uuid } from 'uuid';
import { makeTestEnv } from './helpers.js';

function conversation(env: ReturnType<typeof makeTestEnv>, source: string, ageMs = 0) {
  const id = uuid();
  const at = new Date(Date.now() - ageMs).toISOString();
  env.db.$client
    .prepare('INSERT INTO conversations (id,user_id,source,title,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, env.userId, source, source, at, at);
  return id;
}

function message(
  env: ReturnType<typeof makeTestEnv>,
  convId: string,
  role: string,
  content: string,
  offsetMs: number,
) {
  env.db.$client
    .prepare('INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES (?,?,?,?,?)')
    .run(uuid(), convId, role, content, new Date(Date.now() + offsetMs).toISOString());
}

/** api.ts の /messages/recent と同じSQL */
function recent(env: ReturnType<typeof makeTestEnv>, limit = 100) {
  const rows = env.db.$client
    .prepare(
      `SELECT m.role, m.content, m.created_at AS createdAt, c.source
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE c.user_id = ?
       ORDER BY m.created_at DESC, m.rowid DESC
       LIMIT ?`,
    )
    .all(env.userId, limit) as Array<{ role: string; content: string; source: string }>;
  return rows.reverse();
}

describe('統合タイムライン', () => {
  it('Alexaでの会話もWebでの会話も1本に並ぶ', () => {
    const env = makeTestEnv();
    const web = conversation(env, 'web');
    const alexa = conversation(env, 'alexa');
    message(env, web, 'user', 'PWAからの質問', -30_000);
    message(env, web, 'assistant', 'PWAへの回答', -29_000);
    message(env, alexa, 'user', 'Alexaからの質問', -20_000);
    message(env, alexa, 'assistant', 'Alexaへの回答', -10_000);

    const rows = recent(env);
    expect(rows.map((r) => r.content)).toEqual([
      'PWAからの質問',
      'PWAへの回答',
      'Alexaからの質問',
      'Alexaへの回答',
    ]);
  });

  it('入口が分かるようsourceを返す (画面でタグ表示するため)', () => {
    const env = makeTestEnv();
    const alexa = conversation(env, 'alexa');
    message(env, alexa, 'assistant', 'Alexaの回答', 0);
    expect(recent(env)[0].source).toBe('alexa');
  });

  it('後から書かれた回答が末尾に現れる (8秒打ち切りの後追い)', () => {
    const env = makeTestEnv();
    const alexa = conversation(env, 'alexa');
    message(env, alexa, 'user', '時間のかかる質問', -20_000);
    expect(recent(env)).toHaveLength(1);

    // バックグラウンド完了後に回答が保存される
    message(env, alexa, 'assistant', '調べた結果です', 0);
    const rows = recent(env);
    expect(rows).toHaveLength(2);
    expect(rows[1].content).toBe('調べた結果です');
  });

  it('他ユーザーのメッセージは混ざらない', () => {
    const env = makeTestEnv();
    const mine = conversation(env, 'web');
    message(env, mine, 'user', '自分の発話', 0);
    // 別ユーザーの会話
    const otherConv = uuid();
    const now = new Date().toISOString();
    env.db.$client
      .prepare('INSERT INTO conversations (id,user_id,source,title,created_at,updated_at) VALUES (?,?,?,?,?,?)')
      .run(otherConv, 'other-user', 'web', 'x', now, now);
    env.db.$client
      .prepare('INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES (?,?,?,?,?)')
      .run(uuid(), otherConv, 'user', '他人の発話', now);

    expect(recent(env).map((r) => r.content)).toEqual(['自分の発話']);
  });
});
