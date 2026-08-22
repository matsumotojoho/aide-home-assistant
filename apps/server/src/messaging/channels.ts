// メッセージ送信チャネル (Phase 3)。
// 仕様書16: AIが「誰に・どの手段で・どんな文面で」まで判断してよいが、
// 人への送信はスマホ確認を初期設定とする (Risk Engine が messaging_send を承認必須にする)。
//
// 資格情報は tool_connections.config に保存し、Gitへは出さない。

import { and, eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type { Db } from '../db/index.js';
import { toolConnections } from '../db/schema.js';

export type ChannelId = 'line' | 'slack' | 'mail';

export interface ChannelConfig {
  /** LINE Messaging API: チャネルアクセストークン */
  lineToken?: string;
  /** 既定の送信先 (LINEのuserId) */
  lineDefaultTo?: string;
  /** Slack: Bot User OAuth Token (xoxb-) */
  slackToken?: string;
  /** 既定の送信先チャンネル (#general など) */
  slackDefaultTo?: string;
}

export class MessagingService {
  constructor(private db: Db, private userId: string) {}

  private row(provider: string) {
    return this.db
      .select()
      .from(toolConnections)
      .where(and(eq(toolConnections.userId, this.userId), eq(toolConnections.provider, provider)))
      .get();
  }

  getConfig(): ChannelConfig {
    const row = this.row('messaging');
    if (!row?.config) return {};
    try {
      return JSON.parse(row.config) as ChannelConfig;
    } catch {
      return {};
    }
  }

  setConfig(patch: ChannelConfig): void {
    const now = new Date().toISOString();
    const merged = { ...this.getConfig(), ...patch };
    const configured = Boolean(merged.lineToken || merged.slackToken);
    const existing = this.row('messaging');
    if (existing) {
      this.db
        .update(toolConnections)
        .set({
          config: JSON.stringify(merged),
          status: configured ? 'connected' : 'disconnected',
          updatedAt: now,
        })
        .where(eq(toolConnections.id, existing.id))
        .run();
    } else {
      this.db
        .insert(toolConnections)
        .values({
          id: uuid(),
          userId: this.userId,
          provider: 'messaging',
          status: configured ? 'connected' : 'disconnected',
          config: JSON.stringify(merged),
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
  }

  /** 使えるチャネル一覧 (mailはGoogle連携側で判断するので含めない) */
  availableChannels(): ChannelId[] {
    const c = this.getConfig();
    const list: ChannelId[] = [];
    if (c.lineToken) list.push('line');
    if (c.slackToken) list.push('slack');
    return list;
  }

  status(): { line: boolean; slack: boolean } {
    const c = this.getConfig();
    return { line: Boolean(c.lineToken), slack: Boolean(c.slackToken) };
  }

  async send(channel: ChannelId, to: string, body: string): Promise<void> {
    const config = this.getConfig();
    if (channel === 'line') {
      if (!config.lineToken) throw new Error('LINEが未接続です。設定タブから接続してください');
      const target = to || config.lineDefaultTo;
      if (!target) throw new Error('LINEの送信先が指定されていません');
      const res = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.lineToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ to: target, messages: [{ type: 'text', text: body.slice(0, 5000) }] }),
      });
      if (!res.ok) {
        console.error('[messaging] LINE送信失敗:', res.status, (await res.text().catch(() => '')).slice(0, 300));
        throw new Error('LINEへの送信に失敗しました');
      }
      return;
    }

    if (channel === 'slack') {
      if (!config.slackToken) throw new Error('Slackが未接続です。設定タブから接続してください');
      const target = to || config.slackDefaultTo;
      if (!target) throw new Error('Slackの送信先が指定されていません');
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.slackToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({ channel: target, text: body.slice(0, 4000) }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        console.error('[messaging] Slack送信失敗:', data.error);
        throw new Error('Slackへの送信に失敗しました');
      }
      return;
    }

    throw new Error(`未対応のチャネルです: ${channel}`);
  }
}
