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

export const webSearch: ToolDef = {
  name: 'web.search',
  description:
    '【呼ばないこと】Web検索はあなた自身の検索機能を使う。こちらは外部の検索APIを契約していないため常に失敗する。',
  inputSchema: z.object({ query: z.string().min(1) }),
  inputDoc: '(使用しない)',
  async execute() {
    return {
      ok: false,
      error: '外部の検索APIは未契約です。自分のWeb検索機能を使ってください',
    };
  },
};
