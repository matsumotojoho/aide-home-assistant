import { v4 as uuid } from 'uuid';
import { createDb, type Db } from '../src/db/index.js';
import { users } from '../src/db/schema.js';
import { SettingsService } from '../src/services/settings.js';
import { MemoryService } from '../src/services/memory.js';
import { PermissionService } from '../src/services/permissions.js';
import { createRegistry, type ToolContext } from '../src/tools/index.js';
import type { HomeAssistantClient, HaState } from '../src/ha/client.js';
import type { AgentGateway } from '../src/agentGateway.js';
import type { PushService } from '../src/push.js';

export class FakeHa {
  states = new Map<string, HaState>();
  calls: Array<{ domain: string; service: string; data: Record<string, unknown> }> = [];
  failNext = false;

  configured() {
    return true;
  }
  async getStates(): Promise<HaState[]> {
    return [...this.states.values()];
  }
  async getState(entityId: string): Promise<HaState | null> {
    return this.states.get(entityId) ?? null;
  }
  /** trueにすると、HAが「オフラインで飛ばした」時と同じ空応答を返す */
  skipNext = false;

  async callService(domain: string, service: string, data: Record<string, unknown>): Promise<unknown> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('HA接続エラー(テスト)');
    }
    this.calls.push({ domain, service, data });
    if (this.skipNext) {
      this.skipNext = false;
      return [];
    }
    // 実機同様、変化した状態の配列を返す
    const entityId = String(data.entity_id ?? '');
    const prev = this.states.get(entityId);
    const next: HaState = {
      entity_id: entityId,
      state: service.includes('off') ? 'off' : (prev?.state ?? 'on'),
      attributes: { ...(prev?.attributes ?? {}), ...data },
    };
    this.states.set(entityId, next);
    return [next];
  }
}

export interface TestEnv {
  db: Db;
  userId: string;
  settings: SettingsService;
  memory: MemoryService;
  permissions: PermissionService;
  registry: ReturnType<typeof createRegistry>;
  ha: FakeHa;
  notifications: Array<{ level: string; title: string }>;
  ctx: ToolContext;
}

export function makeTestEnv(): TestEnv {
  const db = createDb(':memory:');
  const userId = uuid();
  db.insert(users)
    .values({ id: userId, email: `${userId}@test`, displayName: 'test', createdAt: new Date().toISOString() })
    .run();

  const settings = new SettingsService(db, userId);
  const memory = new MemoryService(db, userId);
  const permissions = new PermissionService(db, userId);
  const registry = createRegistry();
  const ha = new FakeHa();
  const notifications: Array<{ level: string; title: string }> = [];

  const gateway = {
    connected: () => false,
    status: () => ({ connected: false, lastSeenAt: null, agent: null }),
    call: async () => {
      throw new Error('agent not connected');
    },
  } as unknown as AgentGateway;

  const push = {
    vapidPublicKey: () => '',
    saveSubscription: () => undefined,
    notify: async (_u: string, _s: unknown, level: string, title: string) => {
      notifications.push({ level, title });
    },
  } as unknown as PushService;

  const ctx: ToolContext = {
    db,
    userId,
    source: 'web',
    ha: ha as unknown as HomeAssistantClient,
    gateway,
    push,
    settings,
    memory,
    permissions,
  };

  return { db, userId, settings, memory, permissions, registry, ha, notifications, ctx };
}

export const TEST_DEVICES = [
  { entityId: 'light.bedroom', name: '寝室の照明', room: '寝室', type: 'light', aliases: ['寝室ライト'] },
  { entityId: 'light.living', name: 'リビングの照明', room: 'リビング', type: 'light', aliases: [] },
  { entityId: 'climate.living', name: 'リビングのエアコン', room: 'リビング', type: 'climate', aliases: [] },
  { entityId: 'media_player.living_tv', name: 'リビングのテレビ', room: 'リビング', type: 'tv', aliases: ['テレビ'] },
];
