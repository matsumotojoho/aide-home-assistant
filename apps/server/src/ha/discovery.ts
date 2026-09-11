// Home Assistantの全エンティティから、Aideに登録できる機器を洗い出す。
// 登録は手入力しかなく、カーテンのように後から増えた機器が登録漏れになっていたため。
// 推定は純関数に切り出してテストできるようにする。

import type { HaState } from './client.js';

/** HAのドメイン → Aideの種別。ここに無いドメインは登録候補にしない */
const DOMAIN_TYPE: Record<string, string> = {
  light: 'light',
  switch: 'switch',
  climate: 'climate',
  cover: 'cover',
  media_player: 'tv',
  fan: 'switch', // fan.turn_on / fan.turn_off で操作できる
  humidifier: 'switch',
  lock: 'lock',
  sensor: 'sensor',
  binary_sensor: 'sensor',
};

/**
 * センサーはHAに数十〜数百あるため、家の様子として意味のあるものだけ候補にする。
 * (電池残量や電波強度まで並ぶと、本当に登録したい機器が埋もれる)
 */
const SENSOR_CLASSES = new Set(['temperature', 'humidity', 'door', 'window', 'opening', 'motion', 'occupancy']);

const DEFAULT_ROOMS = [
  'リビング', 'ダイニング', 'キッチン', '台所', '寝室', '玄関', '洗面所', '浴室', '風呂',
  'トイレ', '書斎', '子供部屋', '廊下', '和室', '洋室', '階段', 'ベランダ', '物置', '車庫',
];

export interface DeviceCandidate {
  entityId: string;
  name: string;
  room: string | null;
  type: string;
  state: string;
  /** 操作できる機器か。センサーは既定でチェックを外すために使う */
  controllable: boolean;
}

/** 登録候補にする種別か。対象外なら null */
export function inferType(entityId: string, attributes: Record<string, unknown>): string | null {
  const domain = entityId.split('.')[0];
  const type = DOMAIN_TYPE[domain];
  if (!type) return null;
  if (domain === 'sensor' || domain === 'binary_sensor') {
    if (!SENSOR_CLASSES.has(String(attributes.device_class ?? ''))) return null;
  }
  return type;
}

/**
 * 部屋の推定。HAのREST API (/api/states) はエリア情報を返さないため表示名から拾う。
 * この家では「寝室の電気」「ダイニングのエアコン」のように名前へ部屋が入っている。
 * 既に登録済みの部屋名を優先し、長い名前から照合する (「寝室2」と「寝室」の混在対策)。
 * 外した場合は登録後に編集できるので、推定できなければ空のままにする。
 */
export function guessRoom(name: string, knownRooms: string[]): string | null {
  const rooms = [...new Set([...knownRooms, ...DEFAULT_ROOMS])]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const room of rooms) {
    if (name.includes(room)) return room;
  }
  return null;
}

export function toCandidate(s: HaState, knownRooms: string[]): DeviceCandidate | null {
  const type = inferType(s.entity_id, s.attributes ?? {});
  if (!type) return null;
  const name = String(s.attributes?.friendly_name ?? '').trim() || s.entity_id;
  return {
    entityId: s.entity_id,
    name,
    room: guessRoom(name, knownRooms),
    type,
    state: s.state,
    controllable: type !== 'sensor',
  };
}

/** 部屋ごと・名前順に並べた登録候補。部屋が分からないものは末尾へ */
export function discover(states: HaState[], knownRooms: string[]): DeviceCandidate[] {
  return states
    .map((s) => toCandidate(s, knownRooms))
    .filter((c): c is DeviceCandidate => c !== null)
    .sort((a, b) => {
      if (Boolean(a.room) !== Boolean(b.room)) return a.room ? -1 : 1;
      return (a.room ?? '').localeCompare(b.room ?? '', 'ja') || a.name.localeCompare(b.name, 'ja');
    });
}
