// オーケストレーター:
//  1. Routerで高速分類 (明確な家電命令はClaudeを経由せず即実行)
//  2. それ以外はContext Builderで必要情報だけを組み立ててClaudeへ
//  3. ClaudeのJSON応答 (tool_calls / final) をパースしTool Registryで実行、ループ
//  4. 学習 (save_memory) と履歴保存

import { desc, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type { AgentTurn, Intent, ToolCallRequest } from '@aide/shared';
import type { Db } from './db/index.js';
import { conversations, devices, messages, tasks } from './db/schema.js';
import { classify, type DeviceInfo } from './router/classifier.js';
import type { ProviderSelector } from './llm/index.js';
import { ProviderUnavailableError } from './llm/index.js';
import type { ToolRegistry, ToolContext } from './tools/index.js';

const MAX_TOOL_ITERATIONS = 6;

export interface ChatResult {
  reply: string;
  conversationId: string;
  intent: Intent['kind'];
  pendingApprovalIds: string[];
}

export interface OrchestratorDeps {
  db: Db;
  registry: ToolRegistry;
  providerSelector: ProviderSelector;
  buildToolContext: (source: ToolContext['source']) => ToolContext;
}

export class Orchestrator {
  constructor(private deps: OrchestratorDeps) {}

  async handleUserMessage(params: {
    userId: string;
    text: string;
    source: ToolContext['source'];
    conversationId?: string;
  }): Promise<ChatResult> {
    const { db } = this.deps;
    const now = new Date().toISOString();

    // 会話の確保 + ユーザー発話の保存
    let conversationId = params.conversationId ?? '';
    if (conversationId) {
      const exists = db.select().from(conversations).where(eq(conversations.id, conversationId)).get();
      if (!exists) conversationId = '';
    }
    if (!conversationId) {
      conversationId = uuid();
      db.insert(conversations)
        .values({
          id: conversationId,
          userId: params.userId,
          source: params.source,
          title: params.text.slice(0, 40),
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
    db.insert(messages)
      .values({ id: uuid(), conversationId, role: 'user', content: params.text, createdAt: now })
      .run();

    const ctx = this.deps.buildToolContext(params.source);
    const deviceRows = db.select().from(devices).where(eq(devices.userId, params.userId)).all();
    const deviceInfos: DeviceInfo[] = deviceRows.map((d) => ({
      entityId: d.entityId,
      name: d.name,
      room: d.room,
      type: d.type,
      aliases: d.aliases ? (JSON.parse(d.aliases) as string[]) : [],
    }));

    const intent = classify(params.text, deviceInfos, ctx.settings.get('router.default_room'));

    let reply: string;
    const pendingApprovalIds: string[] = [];

    if (intent.kind === 'home_direct') {
      // A. 明確な家電命令 → Claude不使用・即実行 (Claude停止時も動作)
      const result = await this.deps.registry.execute(
        'home.execute',
        { entity_id: intent.entityId, domain: intent.domain, service: intent.service, data: intent.data },
        ctx,
      );
      reply = result.ok ? intent.speak : `すみません、実行できませんでした。${result.error ?? ''}`;
    } else {
      // B〜E. Claudeによる判断
      try {
        const outcome = await this.runAgentLoop(ctx, {
          conversationId,
          userText: params.text,
          intentKind: intent.kind,
          deviceInfos,
        });
        reply = outcome.reply;
        pendingApprovalIds.push(...outcome.pendingApprovalIds);
      } catch (err) {
        if (err instanceof ProviderUnavailableError) {
          reply =
            '現在AI判断機能が利用できません。「電気つけて」「エアコン26度」のような明確な家電操作は引き続き利用できます。';
        } else {
          console.error('[orchestrator]', err);
          reply = 'すみません、処理中にエラーが発生しました。もう一度試してください。';
        }
      }
    }

    db.insert(messages)
      .values({ id: uuid(), conversationId, role: 'assistant', content: reply, createdAt: new Date().toISOString() })
      .run();
    db.update(conversations)
      .set({ updatedAt: new Date().toISOString() })
      .where(eq(conversations.id, conversationId))
      .run();

    return { reply, conversationId, intent: intent.kind, pendingApprovalIds };
  }

  /** 予約タスクの再評価付き実行 (schedulerから呼ばれる) */
  async runScheduledTask(params: {
    userId: string;
    taskTitle: string;
    intentText: string | null;
    plan: ToolCallRequest[];
    reevaluate: boolean;
  }): Promise<{ ok: boolean; summary: string }> {
    const ctx = this.deps.buildToolContext('scheduled');

    if (params.reevaluate) {
      try {
        const outcome = await this.runAgentLoop(ctx, {
          conversationId: null,
          userText:
            `【予約タスクの自動実行】\n` +
            `タスク名: ${params.taskTitle}\n` +
            (params.intentText ? `元の依頼: ${params.intentText}\n` : '') +
            `予定していたプラン: ${JSON.stringify(params.plan)}\n` +
            `system.get_contextで現在の状況(室温・外気温・天気・家電状態)を確認し、` +
            `状況が変わっていれば設定値を再計算してから実行してください。` +
            `これはユーザーが依頼したタスクの継続実行です。新しい仕事は開始しないでください。`,
          intentKind: 'schedule',
          deviceInfos: [],
        });
        return { ok: true, summary: outcome.reply };
      } catch (err) {
        if (!(err instanceof ProviderUnavailableError)) throw err;
        // Claude不通 → 保存済みプランをそのまま実行 (フォールバック)
      }
    }

    const summaries: string[] = [];
    let allOk = true;
    for (const call of params.plan) {
      const result = await this.deps.registry.execute(call.tool, call.input, ctx);
      summaries.push(`${call.tool}: ${result.ok ? 'OK' : `失敗 (${result.error})`}`);
      if (!result.ok) allOk = false;
    }
    return { ok: allOk, summary: summaries.join(' / ') };
  }

  // ---------- 内部: エージェントループ ----------

  private async runAgentLoop(
    ctx: ToolContext,
    params: {
      conversationId: string | null;
      userText: string;
      intentKind: Intent['kind'];
      deviceInfos: DeviceInfo[];
    },
  ): Promise<{ reply: string; pendingApprovalIds: string[] }> {
    const provider = await this.deps.providerSelector.pick();
    const system = this.buildSystemPrompt();
    let prompt = this.buildInitialPrompt(ctx, params);
    const pendingApprovalIds: string[] = [];

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const res = await provider.complete({ system, prompt });
      const turn = parseAgentTurn(res.text);

      if (turn.type === 'final') {
        if (turn.save_memory && ctx.settings.get('learning.enabled') === 'on') {
          for (const m of turn.save_memory.slice(0, 5)) {
            await this.deps.registry.execute(
              'memory.write',
              { kind: m.kind, title: m.title, content: m.content, tags: m.tags },
              ctx,
            );
          }
        }
        return { reply: turn.speak, pendingApprovalIds };
      }

      // tool_calls の実行
      const results: Array<{ tool: string; result: unknown }> = [];
      for (const call of turn.calls.slice(0, 8)) {
        const result = await this.deps.registry.execute(call.tool, call.input, ctx);
        if (result.pendingApprovalId) pendingApprovalIds.push(result.pendingApprovalId);
        results.push({ tool: call.tool, result });
      }
      prompt +=
        `\n\n[あなたのツール呼び出し]\n${JSON.stringify(turn.calls)}\n` +
        `[実行結果]\n${JSON.stringify(results).slice(0, 20_000)}\n` +
        `結果を踏まえて次のJSON応答を返してください。完了したら type:"final" で簡潔に報告してください。`;
    }

    return {
      reply: '処理が長くなりすぎたため中断しました。結果は履歴を確認してください。',
      pendingApprovalIds,
    };
  }

  private buildSystemPrompt(): string {
    return [
      'あなたは「Aide」、ユーザー専用のAI生活アシスタントの判断エンジンです。',
      '家電・PC・Webサービスを横断してユーザーの目的を実現します。応答は必ず日本語。',
      '',
      '# 応答形式 (厳守)',
      '必ず次のいずれかのJSONのみを出力する。JSONの前後に説明文を書かない。',
      '1. ツールを使う場合:',
      '{"type":"tool_calls","calls":[{"tool":"ツール名","input":{...}}]}',
      '2. 完了・返答する場合:',
      '{"type":"final","speak":"ユーザーへの短い返答","save_memory":[{"kind":"preference","title":"...","content":"..."}]}',
      'save_memoryは恒常的な好み・重要な決定があった時だけ付ける (単発の指示は保存しない)。',
      '',
      '# 利用可能なツール',
      this.deps.registry.promptCatalog(),
      '',
      '# 行動原則',
      '- ユーザーから指示された時だけ新しい仕事を始める。予約タスクの継続実行は例外。',
      '- 設定値が未指定なら、室温・外気温・季節・時刻・過去の好み(memory.search)から適切な値を自分で決める。',
      '- 時刻指定のある依頼 (「19時に帰るから〜」等) はtasks.createで予約し、reevaluate:trueを付ける。run_atは準備時間を考慮して逆算する (例: 帰宅19時なら18:30頃に冷房開始)。',
      '- 決済・購入・送金・契約は必ずユーザー承認が必要 (ツールが自動的に承認フローへ回す)。',
      '- ツール結果が「承認待ち」の場合、finalで「スマホで確認してください」と伝える。',
      '- 元に戻せない操作はその旨を伝える。',
      '- 返答(speak)は音声で読まれる可能性があるため簡潔にする。技術的なエラー詳細は言わず、平易に伝える。',
      '- ユーザーが温度・明るさ等を修正したら、恒常的な好みかを判断してsave_memoryで学習する。',
    ].join('\n');
  }

  private buildInitialPrompt(
    ctx: ToolContext,
    params: { conversationId: string | null; userText: string; intentKind: Intent['kind']; deviceInfos: DeviceInfo[] },
  ): string {
    const { db } = this.deps;
    const parts: string[] = [];

    const nowJst = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false });
    parts.push(`現在時刻 (JST): ${nowJst} / 入力元: ${ctx.source}`);

    // 登録デバイス
    if (params.deviceInfos.length > 0) {
      parts.push(
        '登録デバイス:\n' +
          params.deviceInfos
            .map((d) => `- ${d.entityId} (${d.name}${d.room ? ` / ${d.room}` : ''} / ${d.type})`)
            .join('\n'),
      );
    }

    // 関連する記憶 (FTS検索)
    const related = ctx.memory.search(params.userText, 5);
    if (related.length > 0) {
      parts.push(
        '関連する記憶:\n' + related.map((m) => `- [${m.kind}] ${m.title}: ${m.content.slice(0, 200)}`).join('\n'),
      );
    }

    // 直近の会話
    if (params.conversationId) {
      const recent = db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, params.conversationId))
        .orderBy(desc(messages.createdAt))
        .limit(12)
        .all()
        .reverse();
      if (recent.length > 1) {
        parts.push(
          '直近の会話:\n' +
            recent
              .slice(0, -1)
              .map((m) => `${m.role === 'user' ? 'ユーザー' : 'Aide'}: ${m.content.slice(0, 300)}`)
              .join('\n'),
        );
      }
    }

    // 予約タスク (schedule系の依頼時)
    if (params.intentKind === 'schedule') {
      const scheduled = db
        .select()
        .from(tasks)
        .where(eq(tasks.status, 'scheduled'))
        .orderBy(desc(tasks.runAt))
        .limit(5)
        .all();
      if (scheduled.length > 0) {
        parts.push('既存の予約タスク:\n' + scheduled.map((t) => `- ${t.id}: ${t.title} @ ${t.runAt}`).join('\n'));
      }
    }

    parts.push(`ユーザーの依頼: ${params.userText}`);
    return parts.join('\n\n');
  }
}

// ---------- LLM応答のパース (壊れたJSONにもある程度耐える) ----------
export function parseAgentTurn(text: string): AgentTurn {
  const candidates: string[] = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1]);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));

  for (const c of candidates) {
    try {
      const obj = JSON.parse(c) as Record<string, unknown>;
      if (obj.type === 'tool_calls' && Array.isArray(obj.calls)) {
        return {
          type: 'tool_calls',
          calls: (obj.calls as Array<Record<string, unknown>>)
            .filter((x) => typeof x.tool === 'string')
            .map((x) => ({ tool: String(x.tool), input: (x.input as Record<string, unknown>) ?? {} })),
        };
      }
      if (obj.type === 'final' && typeof obj.speak === 'string') {
        const saveMemory = Array.isArray(obj.save_memory)
          ? (obj.save_memory as Array<Record<string, unknown>>)
              .filter((m) => typeof m.title === 'string' && typeof m.content === 'string')
              .map((m) => ({
                kind: (['preference', 'memory', 'decision'].includes(String(m.kind))
                  ? String(m.kind)
                  : 'memory') as 'preference' | 'memory' | 'decision',
                title: String(m.title),
                content: String(m.content),
                tags: Array.isArray(m.tags) ? (m.tags as string[]) : undefined,
              }))
          : undefined;
        return { type: 'final', speak: obj.speak, save_memory: saveMemory };
      }
    } catch {
      /* try next candidate */
    }
  }
  // JSONで返らなかった場合はテキスト全体を返答として扱う
  return { type: 'final', speak: text.trim().slice(0, 1000) || 'すみません、うまく処理できませんでした。' };
}
