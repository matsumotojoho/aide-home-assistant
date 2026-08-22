// 予約タスクスケジューラ。
// 30秒間隔で期限到来タスクを実行する。reevaluate=1のタスクは実行直前に
// Claudeが状況(室温・天気・帰宅予定)を再確認し設定値を再計算する (仕様書7)。
// これは「勝手な自律行動」ではなく、ユーザーが依頼したタスクの継続実行。

import { and, eq, lte } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type { ToolCallRequest } from '@aide/shared';
import { nextOccurrence } from './recurrence.js';
import type { Db } from './db/index.js';
import { taskRuns, tasks } from './db/schema.js';
import type { Orchestrator } from './orchestrator.js';
import type { PushService } from './push.js';
import type { SettingsService } from './services/settings.js';
import type { MemoryService } from './services/memory.js';

const TICK_MS = 30_000;
const PURGE_INTERVAL_MS = 6 * 3600_000;

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private lastPurge = 0;
  private running = false;

  constructor(
    private deps: {
      db: Db;
      userId: string;
      orchestrator: Orchestrator;
      push: PushService;
      settings: SettingsService;
      memory: MemoryService;
    },
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** テスト可能な単一tick */
  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runDueTasks(now);
      this.maybePurgeMemories(now);
    } catch (err) {
      console.error('[scheduler]', err);
    } finally {
      this.running = false;
    }
  }

  private async runDueTasks(now: Date): Promise<void> {
    const { db } = this.deps;
    const due = db
      .select()
      .from(tasks)
      .where(and(eq(tasks.status, 'scheduled'), lte(tasks.runAt, now.toISOString())))
      .all();

    for (const task of due) {
      const runId = uuid();
      db.update(tasks).set({ status: 'running', updatedAt: now.toISOString() }).where(eq(tasks.id, task.id)).run();
      db.insert(taskRuns)
        .values({ id: runId, taskId: task.id, startedAt: new Date().toISOString(), status: 'running' })
        .run();

      let ok = false;
      let summary = '';
      try {
        const plan = JSON.parse(task.plan) as ToolCallRequest[];
        const result = await this.deps.orchestrator.runScheduledTask({
          userId: task.userId,
          taskTitle: task.title,
          intentText: task.intentText,
          plan,
          reevaluate: task.reevaluate === 1,
        });
        ok = result.ok;
        summary = result.summary;
      } catch (err) {
        summary = err instanceof Error ? err.message : String(err);
      }

      const finished = new Date().toISOString();
      db.update(taskRuns)
        .set({ finishedAt: finished, status: ok ? 'done' : 'failed', summary: summary.slice(0, 2000), error: ok ? null : summary.slice(0, 2000) })
        .where(eq(taskRuns.id, runId))
        .run();
      // 繰り返しタスクは次回実行をスケジュールし直す (失敗しても次回は実行する)
      const next = task.recurrence ? nextOccurrence(task.recurrence, new Date()) : null;
      if (next) {
        db.update(tasks)
          .set({ status: 'scheduled', runAt: next.toISOString(), updatedAt: finished })
          .where(eq(tasks.id, task.id))
          .run();
      } else {
        db.update(tasks)
          .set({ status: ok ? 'done' : 'failed', updatedAt: finished })
          .where(eq(tasks.id, task.id))
          .run();
      }

      await this.deps.push.notify(
        task.userId,
        this.deps.settings,
        ok ? 'important' : 'failure',
        ok ? `予約タスク完了: ${task.title}` : `予約タスク失敗: ${task.title}`,
        summary.slice(0, 300),
      );
    }
  }

  private maybePurgeMemories(now: Date): void {
    if (now.getTime() - this.lastPurge < PURGE_INTERVAL_MS) return;
    this.lastPurge = now.getTime();
    const retention = this.deps.settings.get('memory.retention');
    const purged = this.deps.memory.purgeExpired(retention);
    if (purged > 0) console.log(`[scheduler] 保存期間(${retention})超過の記憶を${purged}件削除`);
  }
}
