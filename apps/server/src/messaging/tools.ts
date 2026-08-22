import { z } from 'zod';
import type { ToolDef, ToolContext } from '../tools/registry.js';
import type { MessagingService, ChannelId } from './channels.js';

type MessagingFactory = (ctx: ToolContext) => MessagingService;

const CHANNEL_LABEL: Record<string, string> = { line: 'LINE', slack: 'Slack', mail: 'メール' };

export function createMessagingTools(getMessaging: MessagingFactory): ToolDef[] {
  const messageSend: ToolDef = {
    name: 'message.send',
    description:
      '相手にメッセージを送る (LINE/Slack)。人への送信は承認必須で、スマホに送信先・サービス・本文が表示され、' +
      'ユーザーが文面を修正してから送信できる。送信後は取り消せない。メールで送る場合は mail.send を使う。',
    inputSchema: z.object({
      to: z.string().min(1),
      channel: z.enum(['line', 'slack']),
      body: z.string().min(1).max(4000),
      recipient_name: z.string().optional(),
    }),
    inputDoc:
      '{"to":"<LINEのuserId または Slackのチャンネル>","channel":"line",' +
      '"body":"30分ほど遅れます。すみません。","recipient_name"?:"田中さん"}',
    async execute(ctx, input) {
      const messaging = getMessaging(ctx);
      const channel = String(input.channel) as ChannelId;
      if (!messaging.availableChannels().includes(channel)) {
        return {
          ok: false,
          error: `${CHANNEL_LABEL[channel] ?? channel}が未接続です。設定タブのメッセージ連携から接続してください`,
        };
      }
      await messaging.send(channel, String(input.to), String(input.body));
      const who = String(input.recipient_name ?? input.to);
      return {
        ok: true,
        summary: `${CHANNEL_LABEL[channel]}で${who}へ送信済み (この操作は元に戻せません)`,
        target: who,
      };
    },
  };

  const messageChannels: ToolDef = {
    name: 'message.channels',
    description: '使えるメッセージ送信手段を確認する。誰にどの手段で送るか決める前に呼ぶ。',
    inputSchema: z.object({}),
    inputDoc: '{}',
    async execute(ctx) {
      const messaging = getMessaging(ctx);
      const status = messaging.status();
      const config = messaging.getConfig();
      const available: string[] = [];
      if (status.line) available.push('line');
      if (status.slack) available.push('slack');
      if (ctx.googleAuth.connected()) available.push('mail (mail.sendを使う)');
      return {
        ok: true,
        data: {
          available,
          line_default_to: config.lineDefaultTo ? '(設定済み)' : undefined,
          slack_default_to: config.slackDefaultTo,
        },
        summary: `利用可能: ${available.join(', ') || 'なし'}`,
      };
    },
  };

  return [messageSend, messageChannels];
}
