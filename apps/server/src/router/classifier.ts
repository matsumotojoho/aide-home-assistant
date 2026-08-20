// Router: ユーザー指示の高速分類。
// A. 明確な家電命令 → Claudeを経由せず即実行 (目標1〜2秒)
// B. 曖昧な家電命令 / C. 複雑な依頼 / D. 検索・相談 / E. PC操作 → Claudeへ
// 純関数として実装しテスト可能にする。

import type { Intent } from '@aide/shared';

export interface DeviceInfo {
  entityId: string;
  name: string;
  room: string | null;
  type: string; // light | climate | tv | switch | ...
  aliases: string[];
}

const norm = (s: string) => s.normalize('NFKC').trim();

const TYPE_KEYWORDS: Array<{ re: RegExp; type: string }> = [
  { re: /エアコン|クーラー|冷房|暖房|除湿/, type: 'climate' },
  { re: /テレビ|TV/i, type: 'tv' },
  { re: /電気|照明|ライト|明かり|あかり/, type: 'light' },
];

const ON_RE = /(つけて|付けて|点けて|オンに|ONに|入れて|起動して)/i;
const OFF_RE = /(消して|けして|切って|オフに|OFFに|止めて|停止して)/i;
const TEMP_RE = /(\d{2})\s*(度|℃)/;
const MODE_RE = /(冷房|暖房|除湿)/;

// 相対調整・情緒的表現 → 曖昧 (Claude行き)
const AMBIGUOUS_HOME_RE =
  /いい感じ|快適|ちょっと|少し|もう少し|強め|弱め|明るく|暗く|上げて|下げて|寒い|暑い|涼し|暖か|準備|おやすみ|寝る/;

// 予約・時間指定 → 複雑 (Claude + タスク化)
const SCHEDULE_RE =
  /(\d{1,2})\s*時(\s*(\d{1,2})\s*分)?\s*(に|まで|から|頃)|時間後|分後|帰る|帰宅|出かけ|出発|起きたら|寝る前に|後で|あとで|しといて|しておいて/;

// PC操作
const MAC_RE = /(Mac|マック|PC|パソコン|ターミナル|ファイル|フォルダ|デスクトップ|ブラウザで|アプリ(を|で)|ダウンロード|整理して|スクリーンショット|リポジトリ|コード)/i;

// 家電関連語 (曖昧でも家電文脈と判断する手がかり)
const HOME_CONTEXT_RE =
  /部屋|家|リビング|寝室|エアコン|クーラー|冷房|暖房|除湿|照明|電気|ライト|明かり|テレビ|温度|湿度|室温|明るく|暗く/;

const SERVICE_BY_TYPE: Record<string, { domain: string; on: string; off: string }> = {
  light: { domain: 'light', on: 'turn_on', off: 'turn_off' },
  tv: { domain: 'media_player', on: 'turn_on', off: 'turn_off' },
  switch: { domain: 'switch', on: 'turn_on', off: 'turn_off' },
  climate: { domain: 'climate', on: 'turn_on', off: 'turn_off' },
};

function findRoom(text: string, devices: DeviceInfo[]): string | null {
  const rooms = [...new Set(devices.map((d) => d.room).filter((r): r is string => Boolean(r)))];
  // 長い部屋名を優先してマッチ (「寝室2」と「寝室」の混在対策)
  rooms.sort((a, b) => b.length - a.length);
  for (const room of rooms) {
    if (text.includes(room)) return room;
  }
  return null;
}

function findByAlias(text: string, devices: DeviceInfo[]): DeviceInfo[] {
  const hits: DeviceInfo[] = [];
  for (const d of devices) {
    for (const alias of [d.name, ...d.aliases]) {
      if (alias && alias.length >= 2 && text.includes(alias)) {
        hits.push(d);
        break;
      }
    }
  }
  return hits;
}

export function classify(rawText: string, devices: DeviceInfo[], defaultRoom = ''): Intent {
  const text = norm(rawText);
  if (!text) return { kind: 'consult' };

  const hasHomeContext = HOME_CONTEXT_RE.test(text);
  const hasSchedule = SCHEDULE_RE.test(text);

  // 時間指定を含む依頼はタスク化が必要 → Claude
  if (hasSchedule && (hasHomeContext || /快適|いい感じ/.test(text))) {
    return { kind: 'schedule' };
  }

  // PC操作 (家電文脈が無い場合)
  if (MAC_RE.test(text) && !hasHomeContext) {
    return { kind: 'mac' };
  }

  if (hasHomeContext || findByAlias(text, devices).length > 0) {
    // 曖昧表現を含む → Claude
    if (AMBIGUOUS_HOME_RE.test(text)) {
      return { kind: 'home_ambiguous' };
    }

    // 候補デバイスの解決: エイリアス直接指定 > 部屋+種別 > 種別のみ
    let candidates = findByAlias(text, devices);
    const room = findRoom(text, devices);
    const typeHit = TYPE_KEYWORDS.find((t) => t.re.test(text));

    if (candidates.length === 0 && typeHit) {
      candidates = devices.filter((d) => d.type === typeHit.type);
      if (room) candidates = candidates.filter((d) => d.room === room);
      else if (candidates.length > 1 && defaultRoom) {
        const inDefault = candidates.filter((d) => d.room === defaultRoom);
        if (inDefault.length === 1) candidates = inDefault;
      }
    } else if (candidates.length > 1 && room) {
      candidates = candidates.filter((d) => d.room === room);
    }

    // 温度指定 (エアコン26度 など)
    const tempMatch = text.match(TEMP_RE);
    if (tempMatch && candidates.length === 1 && candidates[0].type === 'climate') {
      const temp = Number(tempMatch[1]);
      if (temp >= 16 && temp <= 32) {
        const modeMatch = text.match(MODE_RE);
        const hvacMode = modeMatch ? { 冷房: 'cool', 暖房: 'heat', 除湿: 'dry' }[modeMatch[1]] : undefined;
        const data: Record<string, unknown> = { entity_id: candidates[0].entityId, temperature: temp };
        if (hvacMode) data.hvac_mode = hvacMode;
        return {
          kind: 'home_direct',
          entityId: candidates[0].entityId,
          domain: 'climate',
          service: 'set_temperature',
          data,
          speak: `${candidates[0].name}を${temp}度にしました`,
          description: `${candidates[0].name} → ${temp}℃${modeMatch ? ` (${modeMatch[1]})` : ''}`,
        };
      }
    }

    // ON/OFF
    const isOn = ON_RE.test(text);
    const isOff = OFF_RE.test(text);
    if ((isOn || isOff) && !(isOn && isOff) && candidates.length === 1) {
      const d = candidates[0];
      const svc = SERVICE_BY_TYPE[d.type];
      if (svc) {
        return {
          kind: 'home_direct',
          entityId: d.entityId,
          domain: svc.domain,
          service: isOn ? svc.on : svc.off,
          data: { entity_id: d.entityId },
          speak: isOn ? `${d.name}をつけました` : `${d.name}を消しました`,
          description: `${d.name} → ${isOn ? 'ON' : 'OFF'}`,
        };
      }
    }

    // 家電文脈だが一意に決まらない → Claude
    return { kind: 'home_ambiguous' };
  }

  if (hasSchedule) return { kind: 'schedule' };

  // それ以外は検索・相談としてClaudeへ
  return { kind: 'consult' };
}
