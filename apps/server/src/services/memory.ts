import { and, desc, eq, inArray, lt, isNotNull } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type { Db } from '../db/index.js';
import { memories } from '../db/schema.js';

export interface MemoryInput {
  kind: 'memory' | 'preference' | 'decision' | 'imported';
  title: string;
  content: string;
  source?: string;
  tags?: string[];
}

export interface MemoryRow {
  id: string;
  kind: string;
  title: string;
  content: string;
  source: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

function toRow(r: typeof memories.$inferSelect): MemoryRow {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    content: r.content,
    source: r.source,
    tags: r.tags ? (JSON.parse(r.tags) as string[]) : [],
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}


const SPLIT_RE = /[\s\u3000、,。.!?！？「」『』()（）\/]+/;

/**
 * 助詞・語尾。日本語は分かち書きしないので、話し言葉は文まるごとが1語として届く。
 * 「寝室の電気を全部消して」が丸ごとフレーズ検索になり、実測で必ず0件になっていた。
 */
const PARTICLE_RE = /(?:から|まで|より|など|して|した|くらい|ぐらい|だけ|という|の|を|に|は|が|と|へ|で|も|や|ね|よ|か)/g;

/** 空白・句読点で区切った語。精度が高いのでこちらを優先する */
function primaryTerms(query: string): string[] {
  return query
    .split(SPLIT_RE)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 8);
}

/**
 * 助詞で切り直した語。空白の無い日本語文を拾うための最後の手段で、
 * 精度は落ちる前提なのでORでしか使わない。
 */
function subTerms(terms: string[]): string[] {
  const out = new Set<string>();
  for (const t of terms) {
    if (t.length <= 3) continue; // 短い語はそのままの方が正確
    for (const piece of t.split(PARTICLE_RE)) {
      const p = piece.trim();
      if (p.length >= 2) out.add(p);
    }
  }
  return [...out].slice(0, 8);
}

const quote = (t: string) => `"${t.replace(/"/g, '""')}"`;

/**
 * FTS5クエリを精度の高い順に組み立てる。前段が1件でもヒットしたら後段は使わない。
 *  1. AND (全語を含む) 2. OR (どれかを含む) 3. 助詞で切り直した語のOR
 */
function ftsQueries(query: string): string[] {
  const terms = primaryTerms(query);
  if (terms.length === 0) return [];
  const queries =
    terms.length === 1
      ? [quote(terms[0])]
      : [terms.map(quote).join(' AND '), terms.map(quote).join(' OR ')];
  const subs = subTerms(terms);
  if (subs.length > 0) {
    const orSubs = subs.map(quote).join(' OR ');
    if (!queries.includes(orSubs)) queries.push(orSubs);
  }
  return queries;
}

/** LIKEフォールバック用: 語ごとの部分一致 (OR) */
function likeTerms(query: string): string[] {
  const terms = primaryTerms(query);
  return [...new Set([...terms, ...subTerms(terms)])].slice(0, 12);
}

/** 「まとめて操作する」ことを指示している記憶かどうか */
const TOGETHER_RE = /まとめて|一緒に|全部|すべて|全て|必ず|含め|も含む|消し忘れ/;

// ---------- 重複検出 ----------

/** 記憶本文に出てくる entity_id。HAのドメインに限定して誤検出を防ぐ */
const ENTITY_RE =
  /(?:light|switch|climate|cover|media_player|fan|sensor|binary_sensor|scene|script|input_boolean|humidifier|vacuum|lock)\.[a-z0-9_]+/g;

function extractEntityIds(text: string): string[] {
  return [...new Set(text.toLowerCase().match(ENTITY_RE) ?? [])].sort();
}

const normalizeForCompare = (s: string) =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000、。,.「」『』()（）・:：;；!！?？]/g, '');

/**
 * 重複判定用に前処理した記憶。dedupe()は全ペアを比較するため、
 * 正規化と entity_id 抽出は1件につき1回だけ行う (Raspberry Piでも動かすため)。
 */
interface DupKey {
  title: string;
  body: string;
  ids: string[];
  /** 「まとめて操作する」ことを指示している記憶か */
  together: boolean;
  bigrams?: Set<string>;
}

function dupKey(m: { title: string; content: string }): DupKey {
  const whole = `${m.title} ${m.content}`;
  return {
    title: normalizeForCompare(m.title),
    body: normalizeForCompare(m.content),
    ids: extractEntityIds(whole),
    together: TOGETHER_RE.test(whole),
  };
}

function bigramsOf(k: DupKey): Set<string> {
  if (!k.bigrams) {
    const set = new Set<string>();
    for (let i = 0; i < k.body.length - 1; i++) set.add(k.body.slice(i, i + 2));
    k.bigrams = set;
  }
  return k.bigrams;
}

/** 文字bigramのDice係数。言い回しが違うだけの同じ学習を見つけるために使う */
function similarity(a: DupKey, b: DupKey): number {
  if (!a.body || !b.body) return 0;
  if (a.body === b.body) return 1;
  // 長さが倍以上違えば別物。全ペア比較になるので先に安く弾く
  if (Math.min(a.body.length, b.body.length) / Math.max(a.body.length, b.body.length) < 0.5) return 0;
  const A = bigramsOf(a);
  const B = bigramsOf(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const g of A) if (B.has(g)) shared++;
  return (2 * shared) / (A.size + B.size);
}

const sameSet = (a: string[], b: string[]) =>
  a.length > 0 && a.length === b.length && a.every((x) => b.includes(x));

/**
 * 同じ学習かどうか。実運用では「寝室の電気は電球3つも含む」という同じ内容が
 * 表現を変えて1週間で5件溜まった (毎回同じ失敗をして学習し直していた)。
 */
function isDuplicate(a: DupKey, b: DupKey): boolean {
  if (a.title === b.title) return true;
  // 同じ機器の組について「まとめて操作する」と書かれた好みは、言い回しが違っても同じ学習。
  // ただし同じ機器に触れているだけの別の好み (明るさ・温度など) を巻き込まないよう、
  // どちらもまとめ指示であることと、本文がある程度近いことを条件にする。
  if (a.ids.length >= 2 && sameSet(a.ids, b.ids) && a.together && b.together && similarity(a, b) >= 0.35) {
    return true;
  }
  return similarity(a, b) >= 0.72;
}

export class MemoryService {
  constructor(private db: Db, private userId: string) {}

  write(input: MemoryInput): MemoryRow {
    // 同じ学習を積み増さない。既にあるものは新しい内容で置き換える
    const dup = this.findDuplicate(input);
    if (dup) {
      return (
        this.update(dup.id, { title: input.title, content: input.content, tags: input.tags }) ?? dup
      );
    }
    const now = new Date().toISOString();
    const row = {
      id: uuid(),
      userId: this.userId,
      kind: input.kind,
      title: input.title,
      content: input.content,
      source: input.source ?? null,
      tags: JSON.stringify(input.tags ?? []),
      createdAt: now,
      updatedAt: now,
      expiresAt: null as string | null,
    };
    this.db.insert(memories).values(row).run();
    return toRow(row as typeof memories.$inferSelect);
  }

  update(id: string, patch: Partial<Pick<MemoryInput, 'title' | 'content' | 'tags' | 'kind'>>): MemoryRow | null {
    const existing = this.db
      .select()
      .from(memories)
      .where(and(eq(memories.id, id), eq(memories.userId, this.userId)))
      .get();
    if (!existing) return null;
    const now = new Date().toISOString();
    this.db
      .update(memories)
      .set({
        title: patch.title ?? existing.title,
        content: patch.content ?? existing.content,
        kind: patch.kind ?? existing.kind,
        tags: patch.tags ? JSON.stringify(patch.tags) : existing.tags,
        updatedAt: now,
      })
      .where(eq(memories.id, id))
      .run();
    return this.get(id);
  }

  delete(id: string): boolean {
    const res = this.db
      .delete(memories)
      .where(and(eq(memories.id, id), eq(memories.userId, this.userId)))
      .run();
    return res.changes > 0;
  }

  get(id: string): MemoryRow | null {
    const r = this.db
      .select()
      .from(memories)
      .where(and(eq(memories.id, id), eq(memories.userId, this.userId)))
      .get();
    return r ? toRow(r) : null;
  }

  list(kind?: string, limit = 100): MemoryRow[] {
    const rows = kind
      ? this.db
          .select()
          .from(memories)
          .where(and(eq(memories.userId, this.userId), eq(memories.kind, kind)))
          .orderBy(desc(memories.updatedAt))
          .limit(limit)
          .all()
      : this.db
          .select()
          .from(memories)
          .where(eq(memories.userId, this.userId))
          .orderBy(desc(memories.updatedAt))
          .limit(limit)
          .all();
    return rows.map(toRow);
  }

  /**
   * FTS5 (trigram) 全文検索。日本語対応。失敗時はLIKE検索へフォールバック。
   * 記憶に加え過去の会話 (messages) も対象にする。「この前調べたやつ何だっけ」に
   * 会話履歴から答えられるようにするため (仕様書10)。
   */
  search(query: string, limit = 8): MemoryRow[] {
    const memories = this.searchMemories(query, limit);
    const conversations = this.searchConversations(query, Math.max(2, limit - memories.length));
    return [...memories, ...conversations].slice(0, limit);
  }

  private searchMemories(query: string, limit: number): MemoryRow[] {
    const q = query.trim();
    if (!q) return [];
    const sqlite = this.db.$client;
    for (const ftsQuery of ftsQueries(q)) {
      try {
        const rows = sqlite
          .prepare(
            `SELECT m.* FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
             WHERE memories_fts MATCH ? AND m.user_id = ?
             ORDER BY rank LIMIT ?`,
          )
          .all(ftsQuery, this.userId, limit) as (typeof memories.$inferSelect)[];
        if (rows.length > 0) return rows.map(toRow);
      } catch {
        break; // fts5が使えない → LIKEへ
      }
    }
    // trigramは3文字未満で当たらないため、LIKEで拾い直す
    const terms = likeTerms(q);
    if (terms.length === 0) return [];
    const clause = terms.map(() => '(title LIKE ? OR content LIKE ?)').join(' OR ');
    const params = terms.flatMap((t) => [`%${t}%`, `%${t}%`]);
    const rows = sqlite
      .prepare(
        `SELECT * FROM memories WHERE user_id = ? AND (${clause})
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(this.userId, ...params, limit) as (typeof memories.$inferSelect)[];
    return rows.map(toRow);
  }

  /** 過去の会話を検索し、会話単位でまとめた擬似Memory行として返す */
  private searchConversations(query: string, limit: number): MemoryRow[] {
    const q = query.trim();
    if (!q) return [];
    const sqlite = this.db.$client;
    interface Hit {
      conversation_id: string;
      content: string;
      created_at: string;
      title: string | null;
    }
    let hits: Hit[] = [];
    for (const ftsQuery of ftsQueries(q)) {
      try {
        hits = sqlite
          .prepare(
            `SELECT m.conversation_id, m.content, m.created_at, c.title
             FROM messages_fts f
             JOIN messages m ON m.rowid = f.rowid
             JOIN conversations c ON c.id = m.conversation_id
             WHERE messages_fts MATCH ? AND c.user_id = ?
             ORDER BY rank LIMIT ?`,
          )
          .all(ftsQuery, this.userId, limit * 3) as Hit[];
        if (hits.length > 0) break;
      } catch {
        break;
      }
    }
    if (hits.length === 0) {
      const terms = likeTerms(q);
      if (terms.length === 0) return [];
      const clause = terms.map(() => 'm.content LIKE ?').join(' OR ');
      hits = sqlite
        .prepare(
          `SELECT m.conversation_id, m.content, m.created_at, c.title
           FROM messages m JOIN conversations c ON c.id = m.conversation_id
           WHERE c.user_id = ? AND (${clause})
           ORDER BY m.created_at DESC LIMIT ?`,
        )
        .all(this.userId, ...terms.map((t) => `%${t}%`), limit * 3) as Hit[];
    }
    // 会話単位で1件にまとめる (同じ会話の複数メッセージが並ぶのを防ぐ)
    const byConv = new Map<string, Hit>();
    for (const h of hits) {
      if (!byConv.has(h.conversation_id)) byConv.set(h.conversation_id, h);
    }
    return [...byConv.values()].slice(0, limit).map((h) => ({
      id: `conv:${h.conversation_id}`,
      kind: 'conversation',
      title: `[過去の会話] ${h.title ?? '無題'}`,
      content: h.content.slice(0, 500),
      source: 'conversation',
      tags: [],
      createdAt: h.created_at,
      updatedAt: h.created_at,
    }));
  }

  /**
   * 毎回プロンプトに入れる記憶 (好み・決定事項)。
   * 日本語は検索の取りこぼしが避けられないので、件数の少ないこの2種は全件渡す。
   */
  pinned(limit = 40): MemoryRow[] {
    const rows = this.db
      .select()
      .from(memories)
      .where(and(eq(memories.userId, this.userId), inArray(memories.kind, ['preference', 'decision'])))
      .orderBy(desc(memories.updatedAt))
      .limit(limit)
      .all();
    return rows.map(toRow);
  }

  /**
   * 「この機器を操作するときはこれらも一緒に」という好みを entity_id の組で返す。
   * home_directの高速パスはClaudeを通らないため、そこで記憶を効かせる唯一の手段。
   */
  entityGroups(): string[][] {
    return this.pinned(100)
      .filter((m) => TOGETHER_RE.test(m.content) || TOGETHER_RE.test(m.title))
      .map((m) => extractEntityIds(`${m.title} ${m.content}`))
      .filter((ids) => ids.length >= 2);
  }

  /** 既に溜まってしまった重複を1件にまとめる (schedulerから定期実行) */
  dedupe(): number {
    let removed = 0;
    const kept: Array<{ kind: string; title: string; key: DupKey }> = [];
    // updatedAt降順なので、先に見た方が新しい。古い側を消す
    for (const m of this.list(undefined, 500)) {
      const key = dupKey(m);
      const dup = kept.find((k) => k.kind === m.kind && isDuplicate(k.key, key));
      if (dup) {
        // 何を消したかログに残す (誤って統合した場合に気づけるようにするため)
        console.log(`[memory] 重複を統合: 「${m.title}」を削除 → 「${dup.title}」に集約`);
        this.delete(m.id);
        removed++;
      } else {
        kept.push({ kind: m.kind, title: m.title, key });
      }
    }
    return removed;
  }

  private findDuplicate(input: MemoryInput): MemoryRow | null {
    const key = dupKey(input);
    for (const m of this.list(input.kind, 200)) {
      if (isDuplicate(dupKey(m), key)) return m;
    }
    return null;
  }

  /** 保存期間設定に基づく期限切れ削除 (schedulerから定期実行) */
  purgeExpired(retention: string): number {
    if (retention === 'unlimited') return 0;
    const days = retention === '30d' ? 30 : retention === '90d' ? 90 : retention === '1y' ? 365 : parseInt(retention, 10);
    if (!Number.isFinite(days) || days <= 0) return 0;
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
    // 好み(preference)と決定事項はユーザーが明示削除するまで保持する
    const res = this.db
      .delete(memories)
      .where(
        and(
          eq(memories.userId, this.userId),
          eq(memories.kind, 'memory'),
          lt(memories.createdAt, cutoff),
        ),
      )
      .run();
    return res.changes;
  }
}
