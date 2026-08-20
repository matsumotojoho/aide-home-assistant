import { and, eq } from 'drizzle-orm';
import {
  DEFAULT_PERMISSION_MODES,
  type PermissionMode,
  type RiskCategory,
} from '@aide/shared';
import type { Db } from '../db/index.js';
import { permissions } from '../db/schema.js';

export type PermissionDecision = 'allow' | 'need_approval' | 'deny';

export class PermissionService {
  constructor(private db: Db, private userId: string) {}

  getMode(category: RiskCategory): { mode: PermissionMode; grantedOnce: boolean } {
    const row = this.db
      .select()
      .from(permissions)
      .where(and(eq(permissions.userId, this.userId), eq(permissions.category, category)))
      .get();
    if (!row) {
      return { mode: DEFAULT_PERMISSION_MODES[category] ?? 'ask_once', grantedOnce: false };
    }
    return { mode: row.mode as PermissionMode, grantedOnce: row.grantedOnce === 1 };
  }

  setMode(category: RiskCategory, mode: PermissionMode): void {
    const now = new Date().toISOString();
    this.db
      .insert(permissions)
      .values({ userId: this.userId, category, mode, grantedOnce: 0, updatedAt: now })
      .onConflictDoUpdate({
        target: [permissions.userId, permissions.category],
        set: { mode, updatedAt: now },
      })
      .run();
  }

  /** ask_once カテゴリで初回承認された時に呼ぶ → 以後は自動許可 */
  markGrantedOnce(category: RiskCategory): void {
    const now = new Date().toISOString();
    const current = this.getMode(category);
    this.db
      .insert(permissions)
      .values({ userId: this.userId, category, mode: current.mode, grantedOnce: 1, updatedAt: now })
      .onConflictDoUpdate({
        target: [permissions.userId, permissions.category],
        set: { grantedOnce: 1, updatedAt: now },
      })
      .run();
  }

  check(category: RiskCategory): PermissionDecision {
    const { mode, grantedOnce } = this.getMode(category);
    switch (mode) {
      case 'deny':
        return 'deny';
      case 'always_allow':
        return 'allow';
      case 'always_ask':
        return 'need_approval';
      case 'ask_once':
        return grantedOnce ? 'allow' : 'need_approval';
    }
  }

  listAll(): Array<{ category: string; mode: PermissionMode; grantedOnce: boolean }> {
    const stored = new Map(
      this.db
        .select()
        .from(permissions)
        .where(eq(permissions.userId, this.userId))
        .all()
        .map((r) => [r.category, r]),
    );
    return (Object.keys(DEFAULT_PERMISSION_MODES) as RiskCategory[]).map((category) => {
      const row = stored.get(category);
      return {
        category,
        mode: (row?.mode as PermissionMode) ?? DEFAULT_PERMISSION_MODES[category],
        grantedOnce: row?.grantedOnce === 1,
      };
    });
  }
}
