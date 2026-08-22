import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import type { ToolResult } from '@aide/shared';
import type { Db } from '../db/index.js';
import { and, eq } from 'drizzle-orm';
import { actions, approvals, devices, undoRecords } from '../db/schema.js';
import { categorize, riskLabel } from '../risk.js';
import type { HomeAssistantClient } from '../ha/client.js';
import type { AgentGateway } from '../agentGateway.js';
import type { PushService } from '../push.js';
import type { SettingsService } from '../services/settings.js';
import type { MemoryService } from '../services/memory.js';
import type { PermissionService } from '../services/permissions.js';
import type { GoogleAuth } from '../google/oauth.js';
import type { MessagingService } from '../messaging/channels.js';

export interface ToolContext {
  db: Db;
  /** Google連携 (Phase 3)。未接続でもツールは存在し、その旨を返す */
  googleAuth: GoogleAuth;
  /** LINE/Slack送信 (Phase 3) */
  messaging: MessagingService;
  userId: string;
  source: 'alexa' | 'web' | 'mobile' | 'scheduled';
  ha: HomeAssistantClient;
  gateway: AgentGateway;
  push: PushService;
  settings: SettingsService;
  memory: MemoryService;
  permissions: PermissionService;
}

export interface ToolExecOutcome {
  ok: boolean;
  data?: unknown;
  error?: string;
  summary?: string;
  target?: string;
  undo?: { kind: string; restore: unknown };
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  /** LLMプロンプト向けの入力例/説明 */
  inputDoc: string;
  execute(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolExecOutcome>;
}

export interface ExecuteOptions {
  /** 承認済み実行時にtrue (権限チェックをスキップ) */
  skipPermission?: boolean;
  approvalId?: string;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDef>();

  register(def: ToolDef): void {
    this.tools.set(def.name, def);
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  list(): ToolDef[] {
    return [...this.tools.values()];
  }

  /** LLMのシステムプロンプトに入れるツール一覧 */
  promptCatalog(): string {
    return this.list()
      .map((t) => `- ${t.name}: ${t.description}\n  input: ${t.inputDoc}`)
      .join('\n');
  }

  async execute(
    name: string,
    rawInput: Record<string, unknown>,
    ctx: ToolContext,
    opts: ExecuteOptions = {},
  ): Promise<ToolResult> {
    const def = this.tools.get(name);
    const now = new Date().toISOString();
    if (!def) {
      return { ok: false, error: `未知のツールです: ${name}` };
    }

    const parsed = def.inputSchema.safeParse(rawInput ?? {});
    if (!parsed.success) {
      return { ok: false, error: `入力が不正です: ${parsed.error.issues.map((i) => i.message).join(', ')}` };
    }
    const input = parsed.data as Record<string, unknown>;
    const category = categorize(name, input);

    // 権限チェック → 必要なら承認フロー
    if (!opts.skipPermission) {
      const decision = ctx.permissions.check(category);
      if (decision === 'deny') {
        this.logAction(ctx, { name, input, status: 'denied', error: '設定で禁止されています' });
        return { ok: false, error: `この操作 (${category}) は設定で禁止されています` };
      }
      if (decision === 'need_approval') {
        const approvalId = uuid();
        ctx.db
          .insert(approvals)
          .values({
            id: approvalId,
            userId: ctx.userId,
            kind: 'tool_execution',
            title: approvalTitle(ctx, name, category, input),
            payload: JSON.stringify({ tool: name, input, category, riskLabel: riskLabel(category) }),
            status: 'pending',
            createdAt: now,
          })
          .run();
        this.logAction(ctx, { name, input, status: 'pending_approval', approvalId });
        void ctx.push.notify(
          ctx.userId,
          ctx.settings,
          'important',
          '承認が必要な操作があります',
          approvalTitle(ctx, name, category, input),
        );
        return {
          ok: false,
          pendingApprovalId: approvalId,
          error: 'ユーザーの承認待ちです。スマホ(PWA)で確認してください。',
        };
      }
    }

    // 実行
    try {
      const outcome = await def.execute(ctx, input);
      let undoRecordId: string | undefined;
      if (outcome.ok && outcome.undo) {
        undoRecordId = uuid();
      }
      const actionId = this.logAction(ctx, {
        name,
        input,
        status: outcome.ok ? 'success' : 'failed',
        summary: outcome.summary,
        target: outcome.target,
        error: outcome.error,
        undoRecordId,
        approvalId: opts.approvalId,
      });
      if (outcome.ok && outcome.undo && undoRecordId) {
        ctx.db
          .insert(undoRecords)
          .values({
            id: undoRecordId,
            actionId,
            kind: outcome.undo.kind,
            restore: JSON.stringify(outcome.undo.restore),
            createdAt: now,
          })
          .run();
      }
      return outcome.ok
        ? { ok: true, data: outcome.data ?? outcome.summary }
        : { ok: false, error: outcome.error ?? '実行に失敗しました' };
    } catch (err) {
      // ユーザーへは平易な message のみ返し、技術的詳細はサーバーログへ (仕様書34)
      console.error(`[tool] ${name} 失敗:`, err);
      const message = err instanceof Error ? err.message : String(err);
      this.logAction(ctx, { name, input, status: 'failed', error: message });
      return { ok: false, error: message };
    }
  }

  private logAction(
    ctx: ToolContext,
    entry: {
      name: string;
      input: Record<string, unknown>;
      status: string;
      summary?: string;
      target?: string;
      error?: string;
      undoRecordId?: string;
      approvalId?: string;
    },
  ): string {
    const id = uuid();
    const [tool, operation] = splitToolName(entry.name);
    ctx.db
      .insert(actions)
      .values({
        id,
        userId: ctx.userId,
        source: ctx.source,
        tool,
        operation,
        target: entry.target ?? null,
        input: JSON.stringify(entry.input),
        status: entry.status,
        resultSummary: entry.summary ?? null,
        undoAvailable: entry.undoRecordId ? 1 : 0,
        undoRecordId: entry.undoRecordId ?? null,
        approvalId: entry.approvalId ?? null,
        error: entry.error ?? null,
        createdAt: new Date().toISOString(),
      })
      .run();
    return id;
  }
}

function splitToolName(name: string): [string, string | null] {
  const idx = name.indexOf('.');
  return idx === -1 ? [name, null] : [name.slice(0, idx), name.slice(idx + 1)];
}

/**
 * 承認画面はスマホに出るため、何を許可するのかが一目で分かる日本語にする (仕様書16)。
 * ツール名やカテゴリ名のような内部語彙は出さない。
 */
function approvalTitle(
  ctx: ToolContext,
  tool: string,
  category: string,
  input: Record<string, unknown>,
): string {
  if (tool === 'home.execute') {
    const entityId = String((input as { entity_id?: string }).entity_id ?? '');
    const service = String((input as { service?: string }).service ?? '');
    const name = lookupDeviceName(ctx, entityId);
    if (entityId.startsWith('lock.')) {
      return /unlock|open/i.test(service) ? `${name}を解錠します` : `${name}を施錠します`;
    }
    const action = service === 'turn_on' ? 'つけます' : service === 'turn_off' ? '消します' : `${service}を実行します`;
    return `${name}を${action}`;
  }
  if (tool === 'mac.execute') {
    const kind = String((input as { kind?: string }).kind ?? '');
    const command = String((input as { command?: string }).command ?? '');
    const label = kind === 'open_app' ? 'アプリを起動' : kind === 'applescript' ? 'Mac操作' : 'コマンド実行';
    return `Macで${label}: ${command.slice(0, 80)}`;
  }
  if (tool === 'message.send') {
    const i = input as { recipient_name?: string; to?: string; channel?: string };
    const who = i.recipient_name ?? i.to ?? '相手';
    const via = i.channel === 'line' ? 'LINE' : i.channel === 'slack' ? 'Slack' : String(i.channel ?? '');
    return `${who}へ${via}でメッセージを送信します`;
  }
  if (tool === 'mail.send') {
    const i = input as { to?: string; subject?: string };
    return `${i.to ?? ''} へメールを送信します「${String(i.subject ?? '').slice(0, 40)}」`;
  }
  return `${tool} を実行します (${category})`;
}

function lookupDeviceName(ctx: ToolContext, entityId: string): string {
  if (!entityId) return '機器';
  try {
    const row = ctx.db
      .select()
      .from(devices)
      .where(and(eq(devices.userId, ctx.userId), eq(devices.entityId, entityId)))
      .get();
    return row?.name ?? entityId;
  } catch {
    return entityId;
  }
}
