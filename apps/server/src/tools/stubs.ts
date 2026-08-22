// Phase 3で接続予定のツール群 (Calendar / Mail / Contacts / Messaging)。
// Tool Registryのインターフェースを先に固定し、未接続であることを明確に返す。
// tool_connections テーブルに接続状態を持ち、接続後は実装を差し替える。

import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import type { ToolDef, ToolContext } from './registry.js';
import { toolConnections } from '../db/schema.js';

function notConnected(provider: string, phase: string): { ok: false; error: string } {
  return {
    ok: false,
    error: `${provider} は未接続です (${phase}で接続予定)。設定画面のConnectionsから接続できます。`,
  };
}

function isConnected(ctx: ToolContext, provider: string): boolean {
  const row = ctx.db
    .select()
    .from(toolConnections)
    .where(and(eq(toolConnections.userId, ctx.userId), eq(toolConnections.provider, provider)))
    .get();
  return row?.status === 'connected';
}

function stub(
  name: string,
  description: string,
  inputDoc: string,
  schema: z.ZodTypeAny,
  provider: string,
  phase = 'Phase 3',
): ToolDef {
  return {
    name,
    description: `${description} (未接続時はエラーを返す)`,
    inputSchema: schema,
    inputDoc,
    async execute(ctx) {
      if (!isConnected(ctx, provider)) return notConnected(provider, phase);
      return { ok: false, error: `${provider} の実装は${phase}で追加されます` };
    },
  };
}

const anyObj = z.record(z.unknown());

export const messagePrepare = stub(
  'message.prepare',
  '送信メッセージ案を作成しスマホ承認へ回す (LINE/Slack等)',
  '{"to":"田中さん","service":"line","body":"30分ほど遅れます"}',
  anyObj,
  'messaging',
);
export const messageSend = stub(
  'message.send',
  '承認済みメッセージを送信する',
  '{"approval_id":"..."}',
  anyObj,
  'messaging',
);

export const webSearch: ToolDef = {
  name: 'web.search',
  description:
    'Web検索。Claude CLI Provider使用時はProvider内蔵のWebSearchが自動的に使われるため、このツールではなく自身の検索機能を使うこと。',
  inputSchema: z.object({ query: z.string().min(1) }),
  inputDoc: '{"query":"..."}',
  async execute() {
    return {
      ok: false,
      error: '検索はProvider内蔵のWebSearch機能を使用してください (無料枠のため外部検索APIは未接続)',
    };
  },
};
