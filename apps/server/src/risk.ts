import type { RiskCategory } from '@aide/shared';

// Risk Engine: ツール名+入力内容から権限カテゴリを判定する。
// 「必ず確認」(決済・購入・契約・送金) はツール入力や依頼文のキーワードでも検出する。

const PAYMENT_PATTERNS = /決済|支払|購入|買って|注文|チャージ|振込|送金|課金|契約して|申し込|サブスク登録/;

const DESTRUCTIVE_SHELL_PATTERNS =
  /rm\s+-rf?\s+[~/]|rm\s+-fr\s|mkfs|diskutil\s+erase|:>\s*\/|sudo\s+rm|shutdown|killall\s+Finder|launchctl\s+unload|security\s+delete/;

const MASS_DELETE_PATTERNS = /全部消|すべて削除|一括削除|全削除/;

export function categorize(tool: string, input: Record<string, unknown>): RiskCategory {
  const text = JSON.stringify(input ?? {});

  // 内容ベースの判定 (ツール種別より優先)
  if (/送金|振込/.test(text)) return 'money_transfer';
  if (/サブスク|月額|年額|契約/.test(text) && PAYMENT_PATTERNS.test(text)) return 'subscription';
  if (PAYMENT_PATTERNS.test(text)) return 'purchase';
  if (/アカウント削除|退会/.test(text)) return 'account_delete';
  if (MASS_DELETE_PATTERNS.test(text)) return 'mass_delete';

  switch (tool) {
    case 'home.execute': {
      const entityId = String((input as { entity_id?: string }).entity_id ?? '');
      const service = String((input as { service?: string }).service ?? '');
      // 解錠は物理セキュリティに関わるため家電操作と同列にしない (施錠側は通常操作)
      if (entityId.startsWith('lock.') && /unlock|open/i.test(service)) return 'security_change';
      return 'home_control';
    }
    case 'home.get_state':
      return 'home_control';
    case 'memory.write':
    case 'memory.update':
    case 'memory.delete':
    case 'memory.search':
      return 'memory';
    case 'tasks.create':
    case 'tasks.update':
    case 'tasks.cancel':
    case 'tasks.list':
      return 'tasks';
    case 'calendar.create':
    case 'calendar.update':
    case 'calendar.delete':
      return 'calendar_write';
    case 'calendar.read':
      return 'web';
    case 'mail.send':
      return 'mail_send';
    case 'message.send':
    case 'message.prepare':
      return 'messaging_send';
    case 'mac.execute': {
      const cmd = String((input as { command?: string }).command ?? '');
      if (DESTRUCTIVE_SHELL_PATTERNS.test(cmd)) return 'destructive';
      const gui = Boolean((input as { gui?: boolean }).gui);
      return gui ? 'mac_gui' : 'mac_shell';
    }
    case 'mac.status':
      return 'system';
    case 'notification.send':
      return 'notification';
    case 'web.fetch':
    case 'web.search':
    case 'mail.search':
    case 'mail.read':
    case 'mail.draft':
    case 'contacts.search':
      return 'web';
    case 'system.get_context':
      return 'system';
    default:
      return 'system';
  }
}

/** 承認画面に出す危険度ラベル */
export function riskLabel(category: RiskCategory): 'high' | 'medium' | 'low' {
  switch (category) {
    case 'payment':
    case 'purchase':
    case 'subscription':
    case 'money_transfer':
    case 'account_delete':
    case 'mass_delete':
    case 'destructive':
    case 'security_change':
      return 'high';
    case 'messaging_send':
    case 'mail_send':
    case 'mac_shell':
    case 'mac_gui':
    case 'calendar_write':
      return 'medium';
    default:
      return 'low';
  }
}
