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

  /** FTS5 (trigram) 全文検索。日本語対応。失敗時はLIKE検索へフォールバック。 */
  search(query: string, limit = 8): MemoryRow[] {
    const q = query.trim();
    if (!q) return [];
    const sqlite = this.db.$client;
    try {
      // trigram tokenizerは3文字未満のクエリでヒットしないためLIKEと併用
      const ftsQuery = `"${q.replace(/"/g, '""')}"`;
      const rows = sqlite
        .prepare(
          `SELECT m.* FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
           WHERE memories_fts MATCH ? AND m.user_id = ?
           ORDER BY rank LIMIT ?`,
        )
        .all(ftsQuery, this.userId, limit) as (typeof memories.$inferSelect)[];
      if (rows.length > 0) return rows.map(toRow);
    } catch {
      /* fall through to LIKE */
    }
    const like = `%${q}%`;
    const rows = sqlite
      .prepare(
        `SELECT * FROM memories WHERE user_id = ? AND (title LIKE ? OR content LIKE ?)
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(this.userId, like, like, limit) as (typeof memories.$inferSelect)[];
    return rows.map(toRow);
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
