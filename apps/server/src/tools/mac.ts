import { z } from 'zod';
import type { ToolDef } from './registry.js';

export const macExecute: ToolDef = {
  name: 'mac.execute',
  description:
    'Mac mini上で操作を実行する。優先順位: API/CLI(shell) > バックグラウンドブラウザ > AppleScript > GUI。gui=trueの操作は人間がMac使用中の場合キューに入る。',
  inputSchema: z.object({
    kind: z.enum(['shell', 'applescript', 'open_app', 'playwright']),
    command: z.string().min(1).max(10_000),
    gui: z.boolean().optional(),
    timeout_ms: z.number().int().min(1000).max(600_000).optional(),
  }),
  inputDoc:
    '{"kind":"shell","command":"ls ~/Desktop","gui"?:false} ' +
    'kind=playwright はheadlessブラウザでJSを実行 (commandはasync関数の本体、pageが使える)',
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

export const browserOpen: ToolDef = {
  name: 'browser.open',
  description:
    'バックグラウンドブラウザでページを開き本文テキストを取得する。ログイン状態は専用プロファイルに保持される。' +
    'web.fetchで取得できない動的サイト(JS描画・要ログイン)に使う。人間の画面は奪わない。',
  inputSchema: z.object({
    url: z.string().url(),
    wait_for: z.string().optional(),
    screenshot: z.boolean().optional(),
  }),
  inputDoc: '{"url":"https://example.com","wait_for"?:".content","screenshot"?:false}',
  async execute(ctx, input) {
    if (!ctx.gateway.connected()) {
      return { ok: false, error: 'Mac Agentが接続されていません' };
    }
    const result = await ctx.gateway.call<{
      url: string;
      title: string;
      text?: string;
      screenshotBase64?: string;
    }>(
      'browser.open',
      { url: input.url, waitFor: input.wait_for, screenshot: Boolean(input.screenshot) },
      60_000,
    );
    return {
      ok: true,
      data: {
        url: result.url,
        title: result.title,
        text: result.text?.slice(0, 40_000),
        // スクリーンショットはプロンプトを膨らませるため有無だけ返す
        screenshot: result.screenshotBase64 ? '(取得済み)' : undefined,
      },
      summary: `ブラウザで開いた: ${result.title || result.url}`,
      target: String(input.url),
    };
  },
};

export const codexRun: ToolDef = {
  name: 'codex.run',
  description:
    'Codex CLIへ開発作業を委譲する (プログラム作成・コード修正・リポジトリ操作)。' +
    'ランタイムの判断はClaudeが行い、コード作業のみCodexへ渡す。未インストールならその旨を返す。',
  inputSchema: z.object({
    prompt: z.string().min(1).max(8000),
    cwd: z.string().optional(),
    timeout_ms: z.number().int().min(10_000).max(600_000).optional(),
  }),
  inputDoc: '{"prompt":"このリポジトリのテストを直して","cwd"?:"/Users/xxx/project"}',
  async execute(ctx, input) {
    if (!ctx.gateway.connected()) {
      return { ok: false, error: 'Mac Agentが接続されていません' };
    }
    const result = await ctx.gateway.call<{ stdout?: string; stderr?: string; exitCode?: number }>(
      'codex.run',
      { prompt: input.prompt, cwd: input.cwd, timeoutMs: input.timeout_ms },
      ((input.timeout_ms as number) ?? 300_000) + 15_000,
    );
    if (result.exitCode === 127) {
      return { ok: false, error: 'Codex CLIがMac miniにインストールされていません' };
    }
    const ok = (result.exitCode ?? 0) === 0;
    return {
      ok,
      data: { stdout: result.stdout?.slice(0, 20_000), stderr: result.stderr?.slice(0, 3000) },
      summary: `Codex実行: ${String(input.prompt).slice(0, 60)}`,
      error: ok ? undefined : `Codexが失敗しました (${result.exitCode})`,
      target: 'codex',
    };
  },
};
