// Aide Mac Agent — Mac mini常駐エージェント。
// - Railway(または同一マシン)のBackendへOutbound WebSocket接続 (ポート開放不要)
// - shell / AppleScript / アプリ起動を実行
// - 人間がMac使用中はGUI操作をキューに入れる (HIDIdleTime + 手動モード)
// - Claude Code CLI (公式・非対話モード) のブリッジ (llm.complete)
// - LAN内Home AssistantへのHTTPプロキシ (ha.request)

import { config as loadEnv } from 'dotenv';
import { spawn, execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import type { AgentMessage, AgentRpcRequest, MacExecuteParams, LlmCompleteParams } from '@aide/shared';
import { browseUrl, closeBrowser, runScript } from './browser.js';

loadEnv();
loadEnv({ path: join(process.env.HOME ?? '~', '.aide', 'agent.env') });

const SERVER_URL = process.env.AIDE_SERVER_URL ?? 'ws://localhost:8787/agent/ws';
const TOKEN = process.env.AIDE_AGENT_TOKEN ?? '';
const HA_URL = (process.env.AIDE_HA_URL ?? 'http://localhost:8123').replace(/\/$/, '');
const HA_TOKEN = process.env.AIDE_HA_TOKEN ?? '';
const IDLE_THRESHOLD_SEC = Number(process.env.AIDE_IDLE_THRESHOLD_SEC ?? 120);
const STATE_DIR = join(process.env.HOME ?? '.', '.aide');
const MODE_FILE = join(STATE_DIR, 'agent-mode');
const VERSION = '0.1.0';

if (!TOKEN) {
  console.error('AIDE_AGENT_TOKEN が未設定です (.env または ~/.aide/agent.env)');
  process.exit(1);
}
mkdirSync(STATE_DIR, { recursive: true });

type Mode = 'auto' | 'busy' | 'free';

function readMode(): Mode {
  try {
    const m = readFileSync(MODE_FILE, 'utf8').trim();
    if (m === 'busy' || m === 'free' || m === 'auto') return m;
  } catch {
    /* default */
  }
  return 'auto';
}

function writeMode(mode: Mode): void {
  writeFileSync(MODE_FILE, mode);
}

/** macOSの入力アイドル秒数 (ioreg HIDIdleTime) */
function getIdleSeconds(): Promise<number> {
  return new Promise((resolve) => {
    execFile('ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(0);
      const m = stdout.match(/"HIDIdleTime"\s*=\s*(\d+)/);
      resolve(m ? Number(m[1]) / 1e9 : 0);
    });
  });
}

async function isHumanBusy(): Promise<{ busy: boolean; idleSeconds: number; mode: Mode }> {
  const mode = readMode();
  const idleSeconds = await getIdleSeconds();
  if (mode === 'busy') return { busy: true, idleSeconds, mode };
  if (mode === 'free') return { busy: false, idleSeconds, mode };
  return { busy: idleSeconds < IDLE_THRESHOLD_SEC, idleSeconds, mode };
}

// ---------- 実行系 ----------

interface ExecResult {
  status: 'done' | 'queued';
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  queuedReason?: string;
}

function runCommand(cmd: string, args: string[], input: string | null, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ status: 'done', stdout, stderr: stderr + '\n[タイムアウト]', exitCode: 124 });
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ status: 'done', stderr: err.message, exitCode: 127 });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: 'done', stdout, stderr, exitCode: code ?? 0 });
    });
    if (input !== null) child.stdin.write(input);
    child.stdin.end();
  });
}

const guiQueue: Array<{ params: MacExecuteParams; queuedAt: number }> = [];

async function macExecute(params: MacExecuteParams, allowQueue = true): Promise<ExecResult> {
  const timeoutMs = params.timeoutMs ?? 60_000;
  // playwrightはheadlessで画面を奪わないため、GUI扱いにしない
  if (params.gui && params.kind !== 'playwright' && allowQueue) {
    const { busy, mode } = await isHumanBusy();
    if (busy) {
      guiQueue.push({ params, queuedAt: Date.now() });
      return { status: 'queued', queuedReason: mode === 'busy' ? '手動で使用中に設定' : '人間がMacを使用中' };
    }
  }
  switch (params.kind) {
    case 'shell':
      return runCommand('/bin/zsh', ['-lc', params.command], null, timeoutMs);
    case 'applescript':
      return runCommand('osascript', ['-e', params.command], null, timeoutMs);
    case 'open_app':
      return runCommand('open', ['-a', params.command], null, timeoutMs);
    case 'playwright': {
      // headlessなので人間のGUIを奪わない → キュー不要
      try {
        const result = await runScript(params.command, timeoutMs);
        return { status: 'done', stdout: JSON.stringify(result), exitCode: 0 };
      } catch (err) {
        return { status: 'done', stderr: err instanceof Error ? err.message : String(err), exitCode: 1 };
      }
    }
  }
}

async function drainGuiQueue(): Promise<void> {
  if (guiQueue.length === 0) return;
  const { busy } = await isHumanBusy();
  if (busy) return;
  const job = guiQueue.shift();
  if (!job) return;
  console.log(`[queue] GUI操作を実行: ${job.params.command.slice(0, 60)}`);
  const result = await macExecute(job.params, false);
  console.log(`[queue] 完了 exit=${result.exitCode}`);
}

// ---------- Claude Code CLI ブリッジ ----------

function llmComplete(params: LlmCompleteParams): Promise<{ text: string }> {
  const args = ['-p', '--output-format', 'json', '--max-turns', String(params.maxTurns ?? 12)];
  // WebFetchが無いと検索結果のURLを開けず、調べ物の質が大きく落ちる
  args.push('--allowedTools', 'WebSearch', 'WebFetch');
  if (params.model) args.push('--model', params.model);
  if (params.system) args.push('--append-system-prompt', params.system);

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Claude CLIタイムアウト'));
    }, 180_000);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Claude CLI起動失敗: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Claude CLIエラー(${code}): ${stderr.slice(0, 300)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { result?: string; is_error?: boolean };
        if (parsed.is_error) reject(new Error(`Claude CLIエラー: ${String(parsed.result).slice(0, 300)}`));
        else resolve({ text: parsed.result ?? '' });
      } catch {
        resolve({ text: stdout.trim() });
      }
    });
    child.stdin.write(params.prompt);
    child.stdin.end();
  });
}

// ---------- Home Assistant プロキシ ----------

async function haRequest(params: { method: string; path: string; body?: unknown }): Promise<{ status: number; body: unknown }> {
  if (!HA_TOKEN) return { status: 503, body: { error: 'AIDE_HA_TOKEN未設定' } };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`${HA_URL}${params.path}`, {
      method: params.method,
      headers: { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' },
      body: params.body ? JSON.stringify(params.body) : undefined,
      signal: ctrl.signal,
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Codex CLI ブリッジ (Phase 4) ----------
// ランタイムの頭脳はClaude。開発作業やリポジトリ操作をCodexへ委譲したい場合に使う。
// codexが未インストールなら明示的にその旨を返す (勝手に導入しない)。

async function runCodex(params: { prompt: string; cwd?: string; timeoutMs?: number }): Promise<ExecResult> {
  const probe = await runCommand('/bin/zsh', ['-lc', 'command -v codex'], null, 5000);
  if ((probe.exitCode ?? 1) !== 0) {
    return { status: 'done', stderr: 'Codex CLIがインストールされていません', exitCode: 127 };
  }
  const cwd = params.cwd ? `cd ${JSON.stringify(params.cwd)} && ` : '';
  // 非対話モードで実行 (承認プロンプトで固まらないようにする)
  const cmd = `${cwd}codex exec ${JSON.stringify(params.prompt)}`;
  return runCommand('/bin/zsh', ['-lc', cmd], null, params.timeoutMs ?? 300_000);
}

// ---------- WebSocket接続 ----------

let ws: WebSocket | null = null;
let reconnectDelay = 1000;

function connect(): void {
  console.log(`[ws] 接続: ${SERVER_URL}`);
  ws = new WebSocket(SERVER_URL, { headers: { Authorization: `Bearer ${TOKEN}` } });

  ws.on('open', () => {
    reconnectDelay = 1000;
    console.log('[ws] 接続完了');
    send({ type: 'hello', agent: 'mac', version: VERSION, capabilities: ['mac.execute', 'llm.complete', 'ha.request', 'browser.open', 'codex.run'] });
    void pushStatus();
  });

  ws.on('message', (raw) => {
    let msg: AgentMessage;
    try {
      msg = JSON.parse(String(raw)) as AgentMessage;
    } catch {
      return;
    }
    if (msg.type === 'rpc') void handleRpc(msg);
    if (msg.type === 'pong') {
      /* keepalive ok */
    }
  });

  ws.on('close', () => {
    console.log(`[ws] 切断。${reconnectDelay / 1000}秒後に再接続`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
  });

  ws.on('error', (err) => {
    console.error('[ws] エラー:', err.message);
    ws?.close();
  });
}

function send(msg: unknown): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function handleRpc(req: AgentRpcRequest): Promise<void> {
  try {
    let result: unknown;
    switch (req.method) {
      case 'mac.execute':
        result = await macExecute(req.params as unknown as MacExecuteParams);
        break;
      case 'mac.status': {
        const s = await isHumanBusy();
        result = { ...s, queuedGuiJobs: guiQueue.length, host: hostname(), version: VERSION };
        break;
      }
      case 'llm.complete':
        result = await llmComplete(req.params as unknown as LlmCompleteParams);
        break;
      case 'ha.request':
        result = await haRequest(req.params as { method: string; path: string; body?: unknown });
        break;
      case 'browser.open': {
        const p = req.params as { url: string; screenshot?: boolean; waitFor?: string };
        result = await browseUrl(p.url, { screenshot: p.screenshot, waitFor: p.waitFor });
        break;
      }
      case 'codex.run':
        result = await runCodex(req.params as { prompt: string; cwd?: string; timeoutMs?: number });
        break;
      case 'agent.set_mode': {
        const mode = String(req.params.mode);
        if (mode === 'auto' || mode === 'busy' || mode === 'free') {
          writeMode(mode);
          result = { mode };
        } else {
          throw new Error(`不正なモード: ${mode}`);
        }
        break;
      }
      default:
        throw new Error(`未対応メソッド: ${req.method}`);
    }
    send({ type: 'rpc_result', id: req.id, ok: true, result });
  } catch (err) {
    send({ type: 'rpc_result', id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function pushStatus(): Promise<void> {
  const s = await isHumanBusy();
  send({ type: 'status', busy: s.busy, mode: s.mode, idleSeconds: Math.round(s.idleSeconds), queuedGuiJobs: guiQueue.length });
}

setInterval(() => send({ type: 'ping' }), 30_000);
setInterval(() => void pushStatus(), 20_000);
setInterval(() => void drainGuiQueue(), 30_000);

process.on('SIGTERM', () => {
  void closeBrowser().finally(() => process.exit(0));
});

console.log(`Aide Mac Agent v${VERSION} (mode file: ${MODE_FILE})`);
connect();
