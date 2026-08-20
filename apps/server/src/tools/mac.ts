import { z } from 'zod';
import type { ToolDef } from './registry.js';

export const macExecute: ToolDef = {
  name: 'mac.execute',
  description:
    'Mac mini上で操作を実行する。優先順位: API/CLI(shell) > バックグラウンドブラウザ > AppleScript > GUI。gui=trueの操作は人間がMac使用中の場合キューに入る。',
  inputSchema: z.object({
    kind: z.enum(['shell', 'applescript', 'open_app']),
    command: z.string().min(1).max(10_000),
    gui: z.boolean().optional(),
    timeout_ms: z.number().int().min(1000).max(600_000).optional(),
  }),
  inputDoc: '{"kind":"shell","command":"ls ~/Desktop","gui"?:false}',
  async execute(ctx, input) {
    if (!ctx.gateway.connected()) {
      return { ok: false, error: 'Mac Agentが接続されていません' };
    }
    const result = await ctx.gateway.call<{
      status: 'done' | 'queued';
      stdout?: string;
      stderr?: string;
      exitCode?: number;
      queuedReason?: string;
    }>(
      'mac.execute',
      {
        kind: input.kind,
        command: input.command,
        gui: Boolean(input.gui),
        timeoutMs: (input.timeout_ms as number) ?? 60_000,
      },
      ((input.timeout_ms as number) ?? 60_000) + 10_000,
    );
    if (result.status === 'queued') {
      return {
        ok: true,
        data: result,
        summary: `Mac操作をキューに追加 (${result.queuedReason ?? '人間が使用中'})`,
        target: 'mac',
      };
    }
    const ok = (result.exitCode ?? 0) === 0;
    return {
      ok,
      data: { stdout: result.stdout?.slice(0, 20_000), stderr: result.stderr?.slice(0, 5000), exitCode: result.exitCode },
      summary: `Mac ${input.kind}: ${String(input.command).slice(0, 60)} → exit ${result.exitCode}`,
      error: ok ? undefined : `終了コード ${result.exitCode}: ${result.stderr?.slice(0, 300) ?? ''}`,
      target: 'mac',
    };
  },
};

export const macStatus: ToolDef = {
  name: 'mac.status',
  description: 'Mac Agentの接続状態・使用中判定・キュー状況を取得する',
  inputSchema: z.object({}),
  inputDoc: '{}',
  async execute(ctx) {
    const gw = ctx.gateway.status();
    if (!gw.connected) {
      return { ok: true, data: { connected: false }, summary: 'Mac Agent未接続' };
    }
    try {
      const detail = await ctx.gateway.call('mac.status', {}, 10_000);
      return { ok: true, data: { connected: true, ...(detail as object) }, summary: 'Mac Agent状態取得' };
    } catch (e) {
      return { ok: true, data: { connected: true, detail: 'unavailable' }, summary: 'Mac Agent状態取得(簡易)' };
    }
  },
};
