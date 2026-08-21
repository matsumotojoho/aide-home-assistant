import { eq } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { actions, undoRecords } from './db/schema.js';
import type { HomeAssistantClient } from './ha/client.js';

/** actions.undo_record_id を辿って直前状態へ復元する */
export async function applyUndo(
  db: Db,
  ha: HomeAssistantClient,
  actionId: string,
): Promise<{ ok: boolean; message: string }> {
  const action = db.select().from(actions).where(eq(actions.id, actionId)).get();
  if (!action) return { ok: false, message: '対象の操作が見つかりません' };
  if (!action.undoRecordId) return { ok: false, message: 'この操作は元に戻せません' };

  const record = db.select().from(undoRecords).where(eq(undoRecords.id, action.undoRecordId)).get();
  if (!record) return { ok: false, message: 'Undo情報が見つかりません' };
  if (record.usedAt) return { ok: false, message: 'この操作はすでに元に戻されています' };

  const restore = JSON.parse(record.restore) as Record<string, unknown>;

  if (record.kind === 'home_state') {
    const entityId = String(restore.entity_id);
    const domain = String(restore.domain);
    const prevState = String(restore.state);
    const attrs = (restore.attributes as Record<string, unknown>) ?? {};

    if (prevState === 'off' || prevState === 'standby') {
      await ha.callService(domain, 'turn_off', { entity_id: entityId });
    } else if (domain === 'climate') {
      const data: Record<string, unknown> = { entity_id: entityId };
      if (attrs.temperature !== undefined) data.temperature = attrs.temperature;
      if (attrs.hvac_mode !== undefined) data.hvac_mode = attrs.hvac_mode;
      else if (prevState && prevState !== 'unavailable') data.hvac_mode = prevState;
      // モードは set_temperature では反映されない統合があるため先に単独で戻す
      if (data.hvac_mode !== undefined) {
        await ha.callService('climate', 'set_hvac_mode', {
          entity_id: entityId,
          hvac_mode: data.hvac_mode,
        });
      }
      if (data.temperature !== undefined) {
        await ha.callService('climate', 'set_temperature', data);
      }
    } else if (domain === 'light') {
      const data: Record<string, unknown> = { entity_id: entityId };
      if (attrs.brightness !== undefined) data.brightness = attrs.brightness;
      if (attrs.color_temp_kelvin !== undefined) data.color_temp_kelvin = attrs.color_temp_kelvin;
      await ha.callService('light', 'turn_on', data);
    } else {
      await ha.callService(domain, 'turn_on', { entity_id: entityId });
    }
  } else if (record.kind === 'memory') {
    return { ok: false, message: 'メモリのUndoは未対応です (Memoryタブから編集してください)' };
  } else {
    return { ok: false, message: `Undo未対応の種別です: ${record.kind}` };
  }

  db.update(undoRecords).set({ usedAt: new Date().toISOString() }).where(eq(undoRecords.id, record.id)).run();
  return { ok: true, message: '元に戻しました' };
}
