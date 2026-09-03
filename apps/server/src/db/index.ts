import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

// マイグレーションは冪等なSQLで管理する (小規模・単一ユーザー運用のため)。
// スキーマ変更時はここにALTER文を追記する。PostgreSQL移行時はDrizzle Kitへ切替可能。
const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, source TEXT NOT NULL, title TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages (conversation_id, created_at);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
  content TEXT NOT NULL, source TEXT, tags TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  title, content, content='memories', content_rowid='rowid', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
  INSERT INTO memories_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content, content='messages', content_rowid='rowid', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TABLE IF NOT EXISTS preferences (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, domain TEXT NOT NULL, key TEXT NOT NULL,
  value TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, entity_id TEXT NOT NULL, name TEXT NOT NULL,
  room TEXT, type TEXT NOT NULL, aliases TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, run_at TEXT NOT NULL,
  recurrence TEXT, plan TEXT NOT NULL, reevaluate INTEGER NOT NULL DEFAULT 0, intent_text TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled', created_from TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks (status, run_at);
CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
  status TEXT NOT NULL, summary TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, source TEXT NOT NULL, tool TEXT NOT NULL,
  operation TEXT, target TEXT, input TEXT, status TEXT NOT NULL, result_summary TEXT,
  undo_available INTEGER NOT NULL DEFAULT 0, undo_record_id TEXT, approval_id TEXT, error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_actions_created ON actions (created_at DESC);
CREATE TABLE IF NOT EXISTS undo_records (
  id TEXT PRIMARY KEY, action_id TEXT NOT NULL, kind TEXT NOT NULL, restore TEXT NOT NULL,
  created_at TEXT NOT NULL, used_at TEXT
);
CREATE TABLE IF NOT EXISTS permissions (
  user_id TEXT NOT NULL, category TEXT NOT NULL, mode TEXT NOT NULL,
  granted_once INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, category)
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
  payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL, resolved_at TEXT, result TEXT
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT,
  level TEXT NOT NULL, read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE, keys TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- Alexaアカウントリンク用のOAuth2。Alexaスマートホームスキルは
-- 「Alexaユーザー ↔ このシステムのユーザー」を結ぶためにOAuth2を要求する。
CREATE TABLE IF NOT EXISTS oauth_codes (
  code TEXT PRIMARY KEY, user_id TEXT NOT NULL, client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL,
  expires_at TEXT, created_at TEXT NOT NULL, last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_tokens (user_id, kind);
CREATE TABLE IF NOT EXISTS tool_connections (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disconnected', config TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
`;

export function createDb(filePath: string): Db {
  if (filePath !== ':memory:') {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  const sqlite = new Database(filePath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(MIGRATION_SQL);
  // FTS索引の再構築はバージョンで管理する。
  // (external-content FTS5 は件数比較では未構築を検出できないため、ヒューリスティックに頼らない)
  ensureFtsIndexes(sqlite);

  const db = drizzle(sqlite, { schema }) as Db;
  return db;
}

/** FTSの定義を変えたら FTS_VERSION を上げる。起動時に一度だけ再構築される。 */
const FTS_VERSION = 1;

function ensureFtsIndexes(sqlite: Database.Database): void {
  try {
    sqlite.exec('CREATE TABLE IF NOT EXISTS aide_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const row = sqlite.prepare("SELECT value FROM aide_meta WHERE key='fts_version'").get() as
      | { value: string }
      | undefined;
    if (Number(row?.value ?? 0) >= FTS_VERSION) return;

    for (const table of ['messages_fts', 'memories_fts']) {
      sqlite.exec(`INSERT INTO ${table}(${table}) VALUES('rebuild')`);
    }
    sqlite
      .prepare("INSERT INTO aide_meta(key, value) VALUES('fts_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(String(FTS_VERSION));
    console.log('[db] 全文検索インデックスを再構築しました');
  } catch (err) {
    // fts5が使えない環境では検索がLIKEへフォールバックするので、起動は止めない
    console.warn('[db] FTSインデックスの再構築をスキップしました:', err instanceof Error ? err.message : err);
  }
}

export { schema };
