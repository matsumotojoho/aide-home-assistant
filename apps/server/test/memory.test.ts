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

describe('日本語の話し言葉で記憶を引ける (実運用で発見した不具合の回帰テスト)', () => {
  it('空白の無い文でもヒットする', () => {
    const env = makeTestEnv();
    env.memory.write({ kind: 'memory', title: '寝室の照明メモ', content: '寝室の照明は電球3つも含めて消す' });
    // Alexa・チャットから届くのは文まるごと。従来は文全体がフレーズ検索になり必ず0件だった
    expect(env.memory.search('寝室の電気を全部消して').length).toBeGreaterThan(0);
    expect(env.memory.search('寝室の電気消して').length).toBeGreaterThan(0);
  });

  it('助詞分割は最後の手段で、まず語そのもので探す', () => {
    const env = makeTestEnv();
    env.memory.write({ kind: 'memory', title: 'A', content: 'エアコンの話' });
    env.memory.write({ kind: 'memory', title: 'B', content: 'エアコンと加湿器の話' });
    // 「エアコン 加湿器」は従来どおりANDで1件に絞れる (助詞分割で拾いすぎない)
    expect(env.memory.search('エアコン 加湿器')).toHaveLength(1);
  });
});

describe('好み・決定事項は毎回プロンプトへ渡す', () => {
  it('pinned() は preference と decision だけを新しい順で返す', () => {
    const env = makeTestEnv();
    env.memory.write({ kind: 'memory', title: 'ただのメモ', content: 'x' });
    env.memory.write({ kind: 'preference', title: '好み1', content: 'a' });
    env.memory.write({ kind: 'decision', title: '決定1', content: 'b' });

    const pinned = env.memory.pinned();
    expect(pinned.map((m) => m.title).sort()).toEqual(['好み1', '決定1']);
  });

  it('entityGroups() は「まとめて操作する」機器の組を返す', () => {
    const env = makeTestEnv();
    env.memory.write({
      kind: 'preference',
      title: '寝室の電気の対象範囲',
      content: 'light.dian_qi だけでなく light.tradfri_bulb_6 も必ず含めて操作する。',
    });
    // まとめ指示ではない好みは対象外
    env.memory.write({ kind: 'preference', title: '温度', content: '夏は light.dian_qi を暗めにする' });

    const groups = env.memory.entityGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].sort()).toEqual(['light.dian_qi', 'light.tradfri_bulb_6']);
  });
});

describe('同じ学習を積み増さない (実運用で同じ記憶が5件溜まった)', () => {
  const A = {
    kind: 'preference' as const,
    title: '「寝室の電気を全部消して」の対象',
    content:
      '寝室の照明は light.dian_qi / light.dian_qiu_5 / light.tradfri_bulb_6 / light.tradfri_bulb_7 の4つを必ずまとめて消す。',
  };
  const B = {
    kind: 'preference' as const,
    title: '寝室の電気の対象範囲',
    content:
      'light.dian_qi だけでなく light.dian_qiu_5・light.tradfri_bulb_6・light.tradfri_bulb_7 も必ず含めて操作する。消し忘れて指摘された。',
  };

  it('言い回しが違っても同じ機器の組についての好みは1件にまとまる', () => {
    const env = makeTestEnv();
    const a = env.memory.write(A);
    const b = env.memory.write(B);
    expect(b.id).toBe(a.id); // 新規追加ではなく上書き
    expect(env.memory.list('preference')).toHaveLength(1);
    expect(env.memory.get(a.id)?.title).toBe(B.title); // 新しい内容が残る
  });

  it('別の機器についての好みは別件として残る', () => {
    const env = makeTestEnv();
    env.memory.write(A);
    env.memory.write({
      kind: 'preference',
      title: 'リビングを一番明るくするときの対象',
      content: '明るさ最大の指示は light.rihinku1 と light.rihinku2 をまとめて操作する。',
    });
    expect(env.memory.list('preference')).toHaveLength(2);
  });

  it('同じタイトルの学習も1件にまとまる', () => {
    const env = makeTestEnv();
    env.memory.write({ kind: 'preference', title: '夏の寝室温度', content: '25度を好む' });
    env.memory.write({ kind: 'preference', title: '夏の寝室温度', content: '27度を好む' });
    const rows = env.memory.list('preference');
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('27度を好む');
  });

  it('dedupe() は既に溜まった重複をまとめ、新しい方を残す', () => {
    const env = makeTestEnv();
    const insert = (id: string, title: string, content: string, at: string) =>
      env.db.$client
        .prepare(
          `INSERT INTO memories (id,user_id,kind,title,content,source,tags,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(id, env.userId, 'preference', title, content, null, '[]', at, at);

    insert('m1', A.title, A.content, '2026-09-03T23:08:00.000Z');
    insert('m2', B.title, B.content, '2026-09-10T16:39:00.000Z');
    insert('m3', '無関係な好み', 'コーヒーはブラックが好き', '2026-09-05T00:00:00.000Z');

    expect(env.memory.dedupe()).toBe(1);
    expect(env.memory.get('m1')).toBeNull(); // 古い方が消える
    expect(env.memory.get('m2')).not.toBeNull();
    expect(env.memory.get('m3')).not.toBeNull();
  });
});

describe('統合しすぎない (本番データを消す前の安全確認)', () => {
  it('同じ機器に触れていても、話題が違う好みは統合しない', () => {
    const env = makeTestEnv();
    env.memory.write({
      kind: 'preference',
      title: '寝室の照明の対象範囲',
      content: 'light.dian_qi と light.tradfri_bulb_6 は必ずまとめて操作する。片方だけだと指摘される。',
    });
    // 同じ機器の話だが「まとめ方」ではなく「明るさの好み」— 別件として残すべき
    env.memory.write({
      kind: 'preference',
      title: '寝室の明るさ',
      content: '就寝前の light.dian_qi と light.tradfri_bulb_6 は明るさ20%程度の暗めが好み。',
    });
    expect(env.memory.list('preference')).toHaveLength(2);
  });

  it('まとめ指示どうしでも本文が遠ければ統合しない', () => {
    const env = makeTestEnv();
    env.memory.write({
      kind: 'preference',
      title: '寝室の照明',
      content: 'light.dian_qi と light.tradfri_bulb_6 は必ずまとめて消す。',
    });
    env.memory.write({
      kind: 'preference',
      title: '来客時の運用',
      content:
        '来客があるときは light.dian_qi と light.tradfri_bulb_6 をすべて最大にし、' +
        '帰ったあとに元へ戻す。掃除のときも同じ扱いにして、普段の就寝前の設定とは分けて考えること。',
    });
    expect(env.memory.list('preference')).toHaveLength(2);
  });
});
