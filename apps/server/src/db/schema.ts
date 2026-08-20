import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';

// 日時は内部UTC (ISO 8601 文字列)。UIでAsia/Tokyoに変換する。
// IDはUUID (文字列)。将来PostgreSQLへ移行できるようDrizzle ORMを使用。

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  displayName: text('display_name'),
  createdAt: text('created_at').notNull(),
});

export const settings = sqliteTable(
  'settings',
  {
    userId: text('user_id').notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(), // JSON文字列
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.key] })],
);

export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  source: text('source').notNull(), // alexa | web | mobile | scheduled
  title: text('title'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull(),
  role: text('role').notNull(), // user | assistant | system
  content: text('content').notNull(),
  createdAt: text('created_at').notNull(),
});

export const memories = sqliteTable('memories', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  kind: text('kind').notNull(), // memory | preference | decision | imported | action_log
  title: text('title').notNull(),
  content: text('content').notNull(),
  source: text('source'), // chat | learning | chatgpt_import | manual
  tags: text('tags'), // JSON配列
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  expiresAt: text('expires_at'), // 保存期間設定による自動削除用 (null=無期限)
});

export const preferences = sqliteTable('preferences', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  domain: text('domain').notNull(), // climate | light | tv | general ...
  key: text('key').notNull(), // 例: "夏の寝室温度"
  value: text('value').notNull(), // JSON
  note: text('note'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  entityId: text('entity_id').notNull(), // Home Assistant entity_id
  name: text('name').notNull(), // 日本語名 例: 寝室の照明
  room: text('room'), // 寝室 | リビング ...
  type: text('type').notNull(), // light | climate | tv | switch | sensor ...
  aliases: text('aliases'), // JSON配列 例: ["寝室ライト"]
  createdAt: text('created_at').notNull(),
});

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  title: text('title').notNull(),
  runAt: text('run_at').notNull(), // UTC ISO
  recurrence: text('recurrence'), // null=単発 / 簡易cron表現 (Phase 2)
  plan: text('plan').notNull(), // JSON: ToolCallRequest[]
  reevaluate: integer('reevaluate').notNull().default(0), // 実行直前にAIが状況再確認
  intentText: text('intent_text'), // 元のユーザー依頼 (再評価時の文脈)
  status: text('status').notNull().default('scheduled'), // scheduled|running|done|canceled|failed
  createdFrom: text('created_from'), // conversation_id 等
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const taskRuns = sqliteTable('task_runs', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
  status: text('status').notNull(), // running|done|failed
  summary: text('summary'),
  error: text('error'),
});

export const actions = sqliteTable('actions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  source: text('source').notNull(), // alexa|web|mobile|scheduled
  tool: text('tool').notNull(),
  operation: text('operation'),
  target: text('target'),
  input: text('input'), // JSON
  status: text('status').notNull(), // success|failed|pending_approval|denied
  resultSummary: text('result_summary'),
  undoAvailable: integer('undo_available').notNull().default(0),
  undoRecordId: text('undo_record_id'),
  approvalId: text('approval_id'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
});

export const undoRecords = sqliteTable('undo_records', {
  id: text('id').primaryKey(),
  actionId: text('action_id').notNull(),
  kind: text('kind').notNull(), // home_state | setting | memory
  restore: text('restore').notNull(), // JSON: 復元に必要な情報
  createdAt: text('created_at').notNull(),
  usedAt: text('used_at'),
});

export const permissions = sqliteTable(
  'permissions',
  {
    userId: text('user_id').notNull(),
    category: text('category').notNull(),
    mode: text('mode').notNull(), // ask_once|always_ask|always_allow|deny
    grantedOnce: integer('granted_once').notNull().default(0),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.category] })],
);

export const approvals = sqliteTable('approvals', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  kind: text('kind').notNull(), // tool_execution | message_send | permission_grant
  title: text('title').notNull(),
  payload: text('payload').notNull(), // JSON (編集可能な本文などを含む)
  status: text('status').notNull().default('pending'), // pending|approved|rejected|canceled|expired
  createdAt: text('created_at').notNull(),
  resolvedAt: text('resolved_at'),
  result: text('result'), // JSON: 実行結果
});

export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  title: text('title').notNull(),
  body: text('body'),
  level: text('level').notNull(), // info|important|failure
  read: integer('read').notNull().default(0),
  createdAt: text('created_at').notNull(),
});

export const pushSubscriptions = sqliteTable('push_subscriptions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  endpoint: text('endpoint').notNull().unique(),
  keys: text('keys').notNull(), // JSON {p256dh, auth}
  createdAt: text('created_at').notNull(),
});

export const toolConnections = sqliteTable('tool_connections', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  provider: text('provider').notNull(), // home_assistant|google_calendar|gmail|line|slack|...
  status: text('status').notNull().default('disconnected'), // connected|disconnected|error
  config: text('config'), // JSON (秘密情報は環境変数側に置く)
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
