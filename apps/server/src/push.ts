import webpush from 'web-push';
import { eq } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import type { Db } from './db/index.js';
import { notifications, pushSubscriptions } from './db/schema.js';
import type { SettingsService } from './services/settings.js';

export type NotifyLevel = 'info' | 'important' | 'failure';

export class PushService {
  private enabled = false;

  constructor(
    private db: Db,
    private vapid: { publicKey: string; privateKey: string; subject: string },
  ) {
    if (vapid.publicKey && vapid.privateKey) {
      webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
      this.enabled = true;
    }
  }

  vapidPublicKey(): string {
    return this.vapid.publicKey;
  }

  saveSubscription(userId: string, sub: { endpoint: string; keys: unknown }): void {
    this.db
      .insert(pushSubscriptions)
      .values({
        id: uuid(),
        userId,
        endpoint: sub.endpoint,
        keys: JSON.stringify(sub.keys),
        createdAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: { keys: JSON.stringify(sub.keys) },
      })
      .run();
  }

  /** 通知レベル設定に従って記録+Web Push送信 */
  async notify(
    userId: string,
    settingsService: SettingsService,
    level: NotifyLevel,
    title: string,
    body: string,
  ): Promise<void> {
    this.db
      .insert(notifications)
      .values({
        id: uuid(),
        userId,
        title,
        body,
        level,
        read: 0,
        createdAt: new Date().toISOString(),
      })
      .run();

    const pref = settingsService.get('notifications.level');
    const shouldPush =
      pref === 'all' ||
      (pref === 'important' && (level === 'important' || level === 'failure')) ||
      (pref === 'failure' && level === 'failure');
    if (!shouldPush || !this.enabled) return;

    const subs = this.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).all();
    await Promise.allSettled(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: JSON.parse(s.keys) },
            JSON.stringify({ title, body, level }),
          );
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id)).run();
          }
        }
      }),
    );
  }
}
