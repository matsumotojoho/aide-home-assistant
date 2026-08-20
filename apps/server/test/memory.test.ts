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
