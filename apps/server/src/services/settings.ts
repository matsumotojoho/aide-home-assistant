import { eq, and } from 'drizzle-orm';
import { DEFAULT_SETTINGS, type SettingKey, type SettingsMap } from '@aide/shared';
import type { Db } from '../db/index.js';
import { settings } from '../db/schema.js';

export class SettingsService {
  constructor(private db: Db, private userId: string) {}

  get<K extends SettingKey>(key: K): SettingsMap[K] {
    const row = this.db
      .select()
      .from(settings)
      .where(and(eq(settings.userId, this.userId), eq(settings.key, key)))
      .get();
    if (!row) return DEFAULT_SETTINGS[key];
    try {
      return JSON.parse(row.value) as SettingsMap[K];
    } catch {
      return DEFAULT_SETTINGS[key];
    }
  }

  set<K extends SettingKey>(key: K, value: SettingsMap[K]): void {
    const now = new Date().toISOString();
    this.db
      .insert(settings)
      .values({ userId: this.userId, key, value: JSON.stringify(value), updatedAt: now })
      .onConflictDoUpdate({
        target: [settings.userId, settings.key],
        set: { value: JSON.stringify(value), updatedAt: now },
      })
      .run();
  }

  getAll(): SettingsMap {
    const rows = this.db.select().from(settings).where(eq(settings.userId, this.userId)).all();
    const map: Record<string, unknown> = { ...DEFAULT_SETTINGS };
    for (const row of rows) {
      try {
        map[row.key] = JSON.parse(row.value);
      } catch {
        /* keep default */
      }
    }
    return map as unknown as SettingsMap;
  }
}
