import { and, desc, eq, lt, isNotNull } from 'drizzle-orm';
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


/**
 * FTS5クエリを組み立てる。
 * 「エアコン 冷房 温度」のような複数語をそのまま渡すとフレーズ検索になり必ず0件になるため、
 * 語ごとに分割して結合する。まずAND(絞り込み)、0件ならOR(拾い上げ)で再検索する。
 */
function ftsQueries(query: string): string[] {
  const terms = query
    .split(/[\s\u3000、,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 8)
    .map((t) => `"${t.replace(/"/g, '""')}"`);
  if (terms.length === 0) return [];
  if (terms.length === 1) return terms;
  return [terms.join(' AND '), terms.join(' OR ')];
}

/** LIKEフォールバック用: 語ごとの部分一致 (OR) */
function likeTerms(query: string): string[] {
  return query
    .split(/[\s\u3000、,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 8);
}

export class MemoryService {
  constructor(private db: Db, private userId: string) {}

  write(input: MemoryInput): MemoryRow {
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
