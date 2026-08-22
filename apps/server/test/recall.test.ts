// 「さっきの回答教えて」— Alexaが8秒で打ち切った回答を、後から口頭で聞き直せること。
// これが無いと、時間のかかる質問の答えはスマホを見るまで分からない。

import { describe, expect, it } from 'vitest';
import { v4 as uuid } from 'uuid';
import { makeTestEnv } from './helpers.js';
import { answerRecall } from '../src/recallAnswer.js';
import { classify } from '../src/router/classifier.js';
import { TEST_DEVICES } from './helpers.js';

function addTurn(
  env: ReturnType<typeof makeTestEnv>,
  convId: string,
  role: 'user' | 'assistant',
  content: string,
  offsetMs: number,
) {
  const at = new Date(Date.now() + offsetMs).toISOString();
  env.db.$client
    .prepare('INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES (?,?,?,?,?)')
    .run(uuid(), convId, role, content, at);
}

function newConversation(env: ReturnType<typeof makeTestEnv>, source = 'alexa') {
  const id = uuid();
  const now = new Date().toISOString();
  env.db.$client
    .prepare('INSERT INTO conversations (id,user_id,source,title,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, env.userId, source, 'test', now, now);
  return id;
}

describe('直前の回答の読み上げ直し', () => {
  it('「さっきの回答教えて」は recall に分類される (Claudeを使わない)', () => {
    for (const text of [
      'さっきの回答教えて',
      'さっきの答えは',
      'もう一回言って',
      'なんて言ってた',
      '繰り返して',
    ]) {
      expect(classify(text, TEST_DEVICES).kind, text).toBe('recall');
    }
  });

  it('バックグラウンドで完了した回答を返す', () => {
    const env = makeTestEnv();
    const c = newConversation(env);
    addTurn(env, c, 'user', 'この前調べたやつ何だっけ', -60_000);
    // Alexaには「スマホに通知しますね」と返しつつ、実際の回答は後から保存される
    addTurn(env, c, 'assistant', '先週調べたのは加湿器の比較でした。', -50_000);
    // いま「さっきの回答教えて」と聞いている
    addTurn(env, c, 'user', 'さっきの回答教えて', 0);

    expect(answerRecall(env.db, env.userId)).toBe('先週調べたのは加湿器の比較でした。');
  });

  it('待たせている最中なら、古い回答を読み上げず「確認中」と答える', () => {
    const env = makeTestEnv();
    const c = newConversation(env);
    addTurn(env, c, 'user', '難しい質問', -60_000);
    addTurn(env, c, 'assistant', '前の質問への回答です。', -50_000);
    addTurn(env, c, 'user', 'もう一つ質問', -30_000);
    addTurn(env, c, 'assistant', '確認しています。結果はスマホに通知しますね。', -20_000);
    addTurn(env, c, 'user', 'さっきの回答教えて', 0);

    // 別の質問の答えを言ってしまうより、待たせる方が正しい
    const answer = answerRecall(env.db, env.userId);
    expect(answer).toContain('まだ確認中');
    expect(answer).not.toContain('前の質問への回答');
  });

  it('まだ処理中なら「確認中」と伝える (古い回答を誤って読み上げない)', () => {
    const env = makeTestEnv();
    const c = newConversation(env);
    addTurn(env, c, 'user', 'まだ処理中の質問', -10_000);
    addTurn(env, c, 'user', 'さっきの回答教えて', 0);

    expect(answerRecall(env.db, env.userId)).toContain('まだ確認中');
  });

  it('会話が無ければその旨を返す', () => {
    const env = makeTestEnv();
    expect(answerRecall(env.db, env.userId)).toContain('見つかりませんでした');
  });

  it('別の会話にまたがっていても直近の回答を拾う (Alexaはセッションが切れやすい)', () => {
    const env = makeTestEnv();
    const c1 = newConversation(env);
    addTurn(env, c1, 'user', '前の質問', -120_000);
    addTurn(env, c1, 'assistant', '前の会話の回答です。', -110_000);
    const c2 = newConversation(env);
    addTurn(env, c2, 'user', 'さっきの回答教えて', 0);

    expect(answerRecall(env.db, env.userId)).toBe('前の会話の回答です。');
  });
});
