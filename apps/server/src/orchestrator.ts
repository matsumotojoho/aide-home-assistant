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
import { answerStatus } from './statusAnswer.js';
import { answerRecall } from './recallAnswer.js';
import { buildContextSnapshot } from './statusAnswer.js';

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
        { entity_id: intent.entityIds, domain: intent.domain, service: intent.service, data: intent.data },
        ctx,
      );
      reply = result.ok ? intent.speak : `すみません、${result.error ?? '実行できませんでした'}`;
    } else if (intent.kind === 'recall') {
      // 保存済みの直前の回答を読み上げ直す (Claude不要)
      reply = answerRecall(db, params.userId);
    } else if (intent.kind === 'status') {
      // 天気・室温・家の状態はClaudeを使わず即答する。
      // Claude CLIは9〜12秒かかりAlexaの8秒制限に収まらないため、頻出の問い合わせをここで捌く。
      try {
        reply = await answerStatus(intent.topic, {
          db,
          userId: params.userId,
          ha: ctx.ha,
          location: ctx.settings.get('home.location'),
        });
      } catch (err) {
        console.error('[orchestrator] status失敗:', err);
        reply = 'すみません、状態を取得できませんでした。';
      }
    } else {
      // B〜E. Claudeによる判断
      try {
        const outcome = await this.runAgentLoop(ctx, {
          conversationId,
          userText: params.text,
          intentKind: intent.kind,
          deviceInfos,
          userId: params.userId,
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
          userId: params.userId,
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
      userId: string;
    },
  ): Promise<{ reply: string; pendingApprovalIds: string[] }> {
    // Providerの用意と状況取得を同時に進める
    const [provider, snapshot] = await Promise.all([
      this.deps.providerSelector.pick(),
      buildContextSnapshot({
        db: this.deps.db,
        userId: params.userId,
        ha: ctx.ha,
        location: ctx.settings.get('home.location'),
      }).catch(() => ''),
    ]);
    const system = this.buildSystemPrompt();
    let prompt = this.buildInitialPrompt(ctx, params, snapshot);
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
      let allOk = true;
      for (const call of turn.calls.slice(0, 8)) {
        const result = await this.deps.registry.execute(call.tool, call.input, ctx);
        if (result.pendingApprovalId) pendingApprovalIds.push(result.pendingApprovalId);
        if (!result.ok) allOk = false;
        results.push({ tool: call.tool, result });
      }

      // 全部成功していて返答文も用意されているなら、もう一往復せずに返す。
      // (LLM 1回あたり8〜10秒かかるため、これで体感が大きく変わる)
      if (allOk && turn.speak) {
        return { reply: turn.speak, pendingApprovalIds };
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
      'あなたは「Aide」、ユーザー個人の生活アシスタントです。',
      '家・PC・Webサービスを横断して、ユーザーの目的を実際に達成させます。応答は必ず日本語。',
      '',
      '# 応答形式 (厳守)',
      '必ず次のいずれかのJSONのみを出力する。JSONの前後に説明文を書かない。',
      '1. ツールを使う場合:',
      '{"type":"tool_calls","calls":[{"tool":"ツール名","input":{...}}],"speak":"完了時の返答"}',
      '  speak は「全部成功したらこう答える」という文。付けておくと応答が速くなる。',
      '  結果を見てから考えたい場合だけ省略する (省略すると結果を渡してもう一度聞く)。',
      '2. 完了・返答する場合:',
      '{"type":"final","speak":"ユーザーへの返答","save_memory":[{"kind":"preference","title":"...","content":"..."}]}',
      '複数のツールは1回のtool_callsにまとめて並べてよい (往復が減り速くなる)。',
      '',
      '# 利用可能なツール',
      this.deps.registry.promptCatalog(),
      '',
      '# 最優先: 聞き返さずに実行する',
      'このアシスタントは音声でも使われる。聞き返されるとユーザーは手間を感じる。',
      '- 値が指定されていなくても、状況と好みから自分で決めて実行する。決めた値は返答で伝える。',
      '  良い例: 「エアコンつけて」→ 室温と外気温から判断し「冷房26度でつけました」',
      '  悪い例: 「何度にしますか?」と聞き返す',
      '- 対象が複数あるなら、文脈から最も自然なものを選ぶ。迷ったら人がいる部屋・直前に話題にした部屋を優先し、1つに絞る。',
      '  全部にやるのは「全部」「家中」と言われたときだけ。',
      '- 本当に取り返しがつかない場合だけ確認する (誤爆すると困る送信・削除など)。',
      '  ただし承認が要る操作はツール側が自動で承認フローに回すので、自分で聞き返す必要はない。',
      '',
      '# 状況の使い方',
      '- 冒頭に現在時刻・外気温・天気・家電の現在値が渡される。これで足りるならツールを呼ばない。',
      '- 足りない場合だけツールを使う。過去の好みは memory.search で引く。',
      '- 家電を操作するときは渡された entity_id をそのまま使う。',
      '',
      '# 学習',
      'ユーザーが値を直したり好みを述べたら、`save_memory` に kind:"preference" で残す。',
      '「覚えて」と言われなくてよい。次回から同じ判断ができるように、条件も含めて書く。',
      '  例: 「ちょっと寒い」と言われて27度にした → title:"夏の寝室の設定温度" content:"27度を好む。26度だと寒いと言われた"',
      '単発の指示 (今日だけ・今回だけ) は保存しない。',
      '',
      '# 予約',
      '時刻指定のある依頼は tasks.create で予約し reevaluate:true を付ける。',
      'run_at は準備時間を逆算する (帰宅19時なら18:30に冷房開始)。',
      '',
      '# 返答の書き方',
      '- 音声で読まれる前提。1〜2文で、結果と決めた値を伝える。前置きや復唱はしない。',
      '- **実際にやったことだけを、漏らさず報告する。** 2台操作したなら2台とも言う。',
      '  やっていないことを言ったり、やったのに言わなかったりしない。',
      '- 実行できなかったときは理由を平易に言う。技術的な用語やエラーコードは出さない。',
      '- 元に戻せない操作をしたときはその旨を添える。',
    ].join('\n');
  }

  private buildInitialPrompt(
    ctx: ToolContext,
    params: { conversationId: string | null; userText: string; intentKind: Intent['kind']; deviceInfos: DeviceInfo[] },
    snapshot = '',
  ): string {
    const { db } = this.deps;
    const parts: string[] = [];

    const nowJst = new Date().toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    parts.push(`現在時刻 (JST): ${nowJst} / 入力元: ${ctx.source}`);
    if (snapshot) parts.push(`いまの状況:\n${snapshot}`);

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
          speak: typeof obj.speak === 'string' ? obj.speak : undefined,
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
