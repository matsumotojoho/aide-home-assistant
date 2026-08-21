import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { ToolDef } from './registry.js';
import { devices } from '../db/schema.js';

// Undoのために保存する属性 (ドメイン別)
const UNDO_ATTRS: Record<string, string[]> = {
  light: ['brightness', 'color_temp_kelvin'],
  climate: ['temperature', 'hvac_mode', 'fan_mode'],
  media_player: [],
  switch: [],
};

export const homeGetState: ToolDef = {
  name: 'home.get_state',
  description: '家全体または特定デバイスの現在状態を取得する (Home Assistant)',
  inputSchema: z.object({ entity_id: z.string().optional() }),
  inputDoc: '{"entity_id"?: "light.bedroom"} 省略時は登録デバイス全体',
  async execute(ctx, input) {
    if (!ctx.ha.configured()) {
      return { ok: false, error: 'Home Assistantが未接続です' };
    }
    const entityId = input.entity_id as string | undefined;
    if (entityId) {
      const state = await ctx.ha.getState(entityId);
      if (!state) return { ok: false, error: `デバイス ${entityId} が見つかりません` };
      return { ok: true, data: state, summary: `${entityId}: ${state.state}` };
    }
    const registered = ctx.db.select().from(devices).where(eq(devices.userId, ctx.userId)).all();
    const all = await ctx.ha.getStates();
    const ids = new Set(registered.map((d) => d.entityId));
    const filtered = ids.size > 0 ? all.filter((s) => ids.has(s.entity_id)) : all.slice(0, 50);
    const summary = filtered.map((s) => ({
      entity_id: s.entity_id,
      state: s.state,
      attributes: pickAttrs(s.attributes),
    }));
    return { ok: true, data: summary, summary: `${filtered.length}件のデバイス状態を取得` };
  },
};

export const homeExecute: ToolDef = {
  name: 'home.execute',
  description: '家電を操作する (Home Assistantのサービス呼び出し)。実行前状態を保存しUndo可能。',
  inputSchema: z.object({
    entity_id: z.string().min(1),
    domain: z.string().optional(),
    service: z.string().min(1),
    data: z.record(z.unknown()).optional(),
  }),
  inputDoc:
    '{"entity_id":"light.bedroom","service":"turn_on","data"?:{"brightness_pct":40}} domainは省略時entity_idから推定',
  async execute(ctx, input) {
    if (!ctx.ha.configured()) {
      return { ok: false, error: 'Home Assistantが未接続です' };
    }
    const entityId = String(input.entity_id);
    // ドメインは必ず entity_id から決める。呼び出し側が別ドメインを指定しても従わない。
    // (例: light.turn_off を switch.* に対して呼ぶと、HAは200を返しつつ何もしない)
    const domain = entityId.split('.')[0];
    const requestedDomain = input.domain as string | undefined;
    if (requestedDomain && requestedDomain !== domain) {
      console.warn(`[home.execute] domain=${requestedDomain} は ${entityId} と不一致のため ${domain} で実行します`);
    }
    const service = String(input.service);
    const data = { entity_id: entityId, ...((input.data as Record<string, unknown>) ?? {}) };

    // Undo用に実行前状態を取得。あわせて実行可否を確認する。
    // HAは対象が unavailable でもサービス呼び出しに200を返し、実際には何もしない
    // (ログに warning が出るだけ)。そのまま成功扱いにすると「つけました」と言って
    // 実際は何も起きていない、という最悪の誤報告になるため事前に弾く。
    const before = await ctx.ha.getState(entityId);
    if (!before) {
      return { ok: false, error: 'その機器が見つかりませんでした', target: entityId };
    }
    if (before.state === 'unavailable') {
      return {
        ok: false,
        error: '機器がオフラインのため操作できませんでした。電源とネットワークを確認してください',
        target: entityId,
      };
    }

    // SwitchBot Cloud等の一部統合は set_temperature に同梱した hvac_mode を無視するため、
    // モード変更を伴う場合は set_hvac_mode を先に単独で呼ぶ。
    // (AI側は「冷房26℃にして」を1回の呼び出しで表現できるままにする)
    if (domain === 'climate' && service === 'set_temperature' && data.hvac_mode) {
      await ctx.ha.callService('climate', 'set_hvac_mode', {
        entity_id: entityId,
        hvac_mode: data.hvac_mode,
      });
    }
    const response = await ctx.ha.callService(domain, service, data);

    // HAはサービス呼び出しで変化した状態の配列を返す。対象が含まれていれば確実に届いている。
    // 含まれない場合は「元々その状態だった(冪等)」か「オフラインで飛ばされた」かの
    // どちらかなので、状態を取り直して判別する。
    if (!responseIncludes(response, entityId)) {
      const after = await ctx.ha.getState(entityId);
      if (!after || after.state === 'unavailable') {
        return {
          ok: false,
          error: '機器がオフラインのため操作できませんでした。電源とネットワークを確認してください',
          target: entityId,
        };
      }
    }

    const undo = before
      ? {
          kind: 'home_state',
          restore: {
            entity_id: entityId,
            domain,
            state: before.state,
            attributes: pickForUndo(domain, before.attributes),
          },
        }
      : undefined;

    return {
      ok: true,
      data: { executed: `${domain}.${service}`, entity_id: entityId },
      summary: `${entityId} → ${domain}.${service}`,
      target: entityId,
      undo,
    };
  },
};

/** HAのサービス応答 (変化した状態の配列) に対象エンティティが含まれるか */
function responseIncludes(response: unknown, entityId: string): boolean {
  if (!Array.isArray(response)) return false;
  return response.some((s) => (s as { entity_id?: string })?.entity_id === entityId);
}

function pickAttrs(attrs: Record<string, unknown>): Record<string, unknown> {
  const keep = ['friendly_name', 'temperature', 'current_temperature', 'hvac_mode', 'brightness', 'media_title'];
  const out: Record<string, unknown> = {};
  for (const k of keep) if (attrs[k] !== undefined) out[k] = attrs[k];
  return out;
}

function pickForUndo(domain: string, attrs: Record<string, unknown>): Record<string, unknown> {
  const keys = UNDO_ATTRS[domain] ?? [];
  const out: Record<string, unknown> = {};
  for (const k of keys) if (attrs[k] !== undefined) out[k] = attrs[k];
  return out;
}
