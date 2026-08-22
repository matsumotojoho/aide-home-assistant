// ============================================================
// @aide/shared — server / web / mac-agent 間で共有する型とプロトコル
// ランタイム依存なし (型・定数・小さなヘルパのみ)
// ============================================================

// ---------- Router intents ----------
export type Intent =
  | {
      kind: 'home_direct';
      /** 同一部屋の同種デバイスをまとめて操作するため配列で持つ (例: リビングの照明4灯) */
      entityIds: string[];
      domain: string;
      service: string;
      data?: Record<string, unknown>;
      speak: string;
      description: string;
    }
  | { kind: 'home_ambiguous' }
  | { kind: 'schedule' }
  | { kind: 'mac' }
  | { kind: 'consult' };

// ---------- Tool protocol (orchestrator <-> LLM) ----------
export interface ToolCallRequest {
  tool: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  pendingApprovalId?: string;
}

/** LLMに要求する応答JSONの形 */
export type AgentTurn =
  | { type: 'tool_calls'; calls: ToolCallRequest[]; note?: string }
  | {
      type: 'final';
      speak: string;
      save_memory?: Array<{
        kind: 'preference' | 'memory' | 'decision';
        title: string;
        content: string;
        tags?: string[];
      }>;
    };

// ---------- Permissions / Risk ----------
export type PermissionMode = 'ask_once' | 'always_ask' | 'always_allow' | 'deny';

export type RiskCategory =
  | 'payment'
  | 'purchase'
  | 'subscription'
  | 'money_transfer'
  | 'account_delete'
  | 'mass_delete'
  | 'destructive'
  | 'security_change'
  | 'messaging_send'
  | 'mail_send'
  | 'mac_shell'
  | 'mac_gui'
  | 'home_control'
  | 'memory'
  | 'tasks'
  | 'calendar_write'
  | 'notification'
  | 'web'
  | 'system';

/** カテゴリ別の初期ポリシー (設定画面から変更可能) */
export const DEFAULT_PERMISSION_MODES: Record<RiskCategory, PermissionMode> = {
  payment: 'always_ask',
  purchase: 'always_ask',
  subscription: 'always_ask',
  money_transfer: 'always_ask',
  account_delete: 'always_ask',
  mass_delete: 'always_ask',
  destructive: 'always_ask',
  security_change: 'always_ask',
  messaging_send: 'always_ask',
  mail_send: 'always_ask',
  mac_shell: 'ask_once',
  mac_gui: 'ask_once',
  home_control: 'always_allow',
  memory: 'always_allow',
  tasks: 'always_allow',
  calendar_write: 'ask_once',
  notification: 'always_allow',
  web: 'always_allow',
  system: 'always_allow',
};

/** 「必ず確認」— 設定でalways_allowにしてもUI上で警告するカテゴリ */
export const HARD_CONFIRM_CATEGORIES: RiskCategory[] = [
  'payment',
  'purchase',
  'subscription',
  'money_transfer',
];

// ---------- Settings ----------
export interface SettingsMap {
  'ai.provider': 'auto' | 'claude-cli-local' | 'claude-via-mac' | 'anthropic-api' | 'openai-api' | 'local-llm';
  'ai.paid_api_fallback': 'off' | 'on';
  'ai.api_model': string;
  'ai.openai_model': string;
  'ai.local_model': string; // Ollamaモデル名 (Phase 4)
  'ai.claude_cli_model': string; // '' = CLI既定
  'alexa.verbosity': 'short' | 'standard' | 'detailed' | 'full';
  'notifications.level': 'all' | 'important' | 'failure' | 'none';
  'memory.retention': 'unlimited' | '30d' | '90d' | '1y' | string; // string = custom days e.g. '180d'
  'learning.enabled': 'on' | 'off';
  'router.default_room': string;
  'home.location': string; // "lat,lon" 天気取得用
  'mac.busy_mode': 'auto' | 'busy' | 'free';
  'mac.gui_policy': 'queue_when_busy' | 'always_queue' | 'always_run';
  /** 確認なしで送信してよい相手 (仕様書16「この相手には確認不要」) */
  'messaging.trusted_recipients': string[];
}

export const DEFAULT_SETTINGS: SettingsMap = {
  'ai.provider': 'auto',
  'ai.paid_api_fallback': 'off',
  'ai.api_model': 'claude-opus-5',
  'ai.openai_model': 'gpt-5.2',
  'ai.local_model': '',
  'ai.claude_cli_model': '',
  'alexa.verbosity': 'standard',
  'notifications.level': 'important',
  'memory.retention': 'unlimited',
  'learning.enabled': 'on',
  'router.default_room': '',
  'home.location': '',
  'mac.busy_mode': 'auto',
  'mac.gui_policy': 'queue_when_busy',
  'messaging.trusted_recipients': [],
};

export type SettingKey = keyof SettingsMap;

// ---------- Mac Agent WebSocket protocol ----------
export type AgentRpcMethod =
  | 'mac.execute'
  | 'mac.status'
  | 'llm.complete'
  | 'ha.request'
  | 'agent.set_mode'
  | 'codex.run'
  | 'browser.open';

export interface AgentRpcRequest {
  type: 'rpc';
  id: string;
  method: AgentRpcMethod;
  params: Record<string, unknown>;
}

export interface AgentRpcResponse {
  type: 'rpc_result';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface AgentHello {
  type: 'hello';
  agent: 'mac';
  version: string;
  capabilities: string[];
}

export interface AgentStatusPush {
  type: 'status';
  busy: boolean;
  mode: 'auto' | 'busy' | 'free';
  idleSeconds: number;
  queuedGuiJobs: number;
}

export type AgentMessage = AgentRpcRequest | AgentRpcResponse | AgentHello | AgentStatusPush | { type: 'ping' } | { type: 'pong' };

export interface MacExecuteParams {
  kind: 'shell' | 'applescript' | 'open_app' | 'playwright';
  command: string;
  gui?: boolean;
  timeoutMs?: number;
}

export interface LlmCompleteParams {
  system: string;
  prompt: string;
  model?: string;
  maxTurns?: number;
}

// ---------- misc ----------
export const APP_NAME = 'Aide';

export function nowIso(): string {
  return new Date().toISOString();
}
