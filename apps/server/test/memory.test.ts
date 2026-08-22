import { describe, expect, it } from 'vitest';
import { makeTestEnv } from './helpers.js';

describe('Memory CRUD + 検索', () => {
  it('write → get → update → delete', () => {
    const env = makeTestEnv();
    const row = env.memory.write({ kind: 'preference', title: '夏の寝室温度', content: '25〜26℃を好む' });
    expect(row.id).toBeTruthy();

    const fetched = env.memory.get(row.id);
    expect(fetched?.title).toBe('夏の寝室温度');

    const updated = env.memory.update(row.id, { content: '26℃を好む' });
    expect(updated?.content).toBe('26℃を好む');

    expect(env.memory.delete(row.id)).toBe(true);
    expect(env.memory.get(row.id)).toBeNull();
  });

  it('日本語全文検索 (FTS5 trigram)', () => {
    const env = makeTestEnv();
    env.memory.write({ kind: 'memory', title: '照明の好み', content: '夜の寝室照明は暗めが良い' });
    env.memory.write({ kind: 'memory', title: '買い物メモ', content: '牛乳を買う' });

    const hits = env.memory.search('寝室照明');
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe('照明の好み');
  });

  it('短いクエリはLIKEフォールバックで検索できる', () => {
    const env = makeTestEnv();
    env.memory.write({ kind: 'memory', title: 'テスト', content: '暗め設定' });
    const hits = env.memory.search('暗');
    expect(hits.length).toBeGreaterThanOrEqual(1);
  });

  it('更新後もFTSインデックスが追従する', () => {
    const env = makeTestEnv();
    const row = env.memory.write({ kind: 'memory', title: 'タイトル', content: '古い内容カレーライス' });
    env.memory.update(row.id, { content: '新しい内容ハンバーグ' });
    expect(env.memory.search('カレーライス')).toHaveLength(0);
    expect(env.memory.search('ハンバーグ')).toHaveLength(1);
  });

  it('保存期間purgeはkind=memoryのみ削除しpreferenceは残す', () => {
    const env = makeTestEnv();
    const old = env.memory.write({ kind: 'memory', title: '古い記憶', content: 'x' });
    const pref = env.memory.write({ kind: 'preference', title: '好み', content: 'y' });
    // createdAtを過去に書き換え
    env.db.$client
      .prepare(`UPDATE memories SET created_at = ? WHERE id IN (?, ?)`)
      .run(new Date(Date.now() - 100 * 86400_000).toISOString(), old.id, pref.id);

    const purged = env.memory.purgeExpired('30d');
    expect(purged).toBe(1);
    expect(env.memory.get(old.id)).toBeNull();
    expect(env.memory.get(pref.id)).not.toBeNull();
  });

  it('unlimited設定では何も削除しない', () => {
    const env = makeTestEnv();
    env.memory.write({ kind: 'memory', title: 'a', content: 'b' });
    expect(env.memory.purgeExpired('unlimited')).toBe(0);
  });
});

describe('複数キーワード検索 (実運用で発見した不具合の回帰テスト)', () => {
  it('スペース区切りの複数語がフレーズ扱いされず、ちゃんとヒットする', () => {
    const env = makeTestEnv();
    env.memory.write({ kind: 'memory', title: 'エアコンの設定', content: '夏は冷房26度が快適' });
    // Claudeが実際に投げたクエリの形
    const hits = env.memory.search('エアコン 冷房 暖房 温度 設定');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].title).toContain('エアコン');
  });

  it('全角スペース・読点区切りも扱える', () => {
    const env = makeTestEnv();
    env.memory.write({ kind: 'memory', title: '照明メモ', content: '寝室は暗めが好み' });
    expect(env.memory.search('寝室　照明').length).toBeGreaterThan(0);
    expect(env.memory.search('寝室、照明').length).toBeGreaterThan(0);
  });

  it('AND優先: 全部の語を含むものが先に返る', () => {
    const env = makeTestEnv();
    env.memory.write({ kind: 'memory', title: 'A', content: 'エアコンの話' });
    env.memory.write({ kind: 'memory', title: 'B', content: 'エアコンと加湿器の話' });
    const hits = env.memory.search('エアコン 加湿器');
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe('B');
  });

  it('ANDで0件ならORで拾い直す', () => {
    const env = makeTestEnv();
    env.memory.write({ kind: 'memory', title: 'A', content: 'エアコンの話' });
    const hits = env.memory.search('エアコン 存在しない語');
    expect(hits.length).toBeGreaterThan(0);
  });

  it('過去の会話も検索対象になる', () => {
    const env = makeTestEnv();
    const now = new Date().toISOString();
    env.db.$client
      .prepare("INSERT INTO conversations (id,user_id,source,title,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run('c1', env.userId, 'web', 'エアコンの相談', now, now);
    env.db.$client
      .prepare('INSERT INTO messages (id,conversation_id,role,content,created_at) VALUES (?,?,?,?,?)')
      .run('m1', 'c1', 'user', '暑いのでエアコン快適にして', now);

    const hits = env.memory.search('エアコン 快適');
    expect(hits.some((h) => h.kind === 'conversation')).toBe(true);
  });
});
