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

// ON/OFFのサービス名。HAのドメインは種別ではなく entity_id から決まる点に注意
// (例: 赤外線リモコンの照明は type=light でも entity_id は switch.* になる)。
const SERVICE_BY_TYPE: Record<string, { on: string; off: string }> = {
  light: { on: 'turn_on', off: 'turn_off' },
  tv: { on: 'turn_on', off: 'turn_off' },
  switch: { on: 'turn_on', off: 'turn_off' },
  climate: { on: 'turn_on', off: 'turn_off' },
};

/** HAのサービス呼び出しは対象エンティティ自身のドメインに向ける必要がある */
function domainOf(entityId: string): string {
  return entityId.split('.')[0];
}

/**
 * 応答での呼び名。1台ならその名前、複数台なら「リビングの照明」とまとめて呼ぶ
 * (「リビング1をつけました」を4回言われても意味がないため)。
 */
const TYPE_LABEL: Record<string, string> = {
  light: '照明',
  climate: 'エアコン',
  tv: 'テレビ',
  switch: 'スイッチ',
};

function groupLabel(candidates: DeviceInfo[], room: string | null): string {
  if (candidates.length === 1) return candidates[0].name;
  const type = TYPE_LABEL[candidates[0].type] ?? '機器';
  return room ? `${room}の${type}` : type;
}

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

// 「〜して」のような操作指示。状態確認と区別するために使う
const COMMAND_RE = /(つけて|付けて|点けて|消して|けして|切って|オンに|オフに|にして|して|開けて|閉めて|変えて|下げて|上げて|お願い|しといて|しておいて)/;
// 状態を聞かれているだけのパターン (Claude不要で即答する)
const WEATHER_RE = /(天気|気温|外.*(何度|温度)|雨.*(降|ふ))/;
const INDOOR_RE = /(室温|湿度|部屋.*(何度|温度)|今何度|何度ある|暑い\?|寒い\?)/;
const HOME_STATUS_RE = /(家.*(状況|状態|どう)|今.*状況|状況(を)?教え|状態(を)?教え|全部.*(ついて|消えて)|ついてる\?|消えてる\?|閉まってる|開いてる)/;
const TIME_RE = /^(今)?何時|今の時間|時間(を)?教え/;
// 未来・過去の話は現在値では答えられない
const FORECAST_RE = /(明日|あした|明後日|あさって|今週|来週|週末|今夜|今晩|夕方|午後|午前|これから|さっき|昨日|きのう|予報)/;

export function classify(rawText: string, devices: DeviceInfo[], defaultRoom = ''): Intent {
  const text = norm(rawText);
  if (!text) return { kind: 'consult' };

  const hasHomeContext = HOME_CONTEXT_RE.test(text);
  const hasSchedule = SCHEDULE_RE.test(text);

  // 状態確認 (操作指示でも予約でもないもの) はClaudeを経由せず即答する。
  // Alexaは8秒で打ち切られるため、頻出の問い合わせをここで捌くことが体感を大きく変える。
  // ただし「明日の天気」のような予報はここでは答えられない (現在値しか持たない) のでClaudeへ回す。
  if (!hasSchedule && !COMMAND_RE.test(text) && !FORECAST_RE.test(text)) {
    if (TIME_RE.test(text)) return { kind: 'status', topic: 'time' };
    if (WEATHER_RE.test(text)) return { kind: 'status', topic: 'weather' };
    if (INDOOR_RE.test(text)) return { kind: 'status', topic: 'indoor' };
    if (HOME_STATUS_RE.test(text)) return { kind: 'status', topic: 'home' };
  }

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

    // 部屋が明示されていれば必ずその部屋に絞る。
    // (「リビングの電気」が、汎用エイリアス「電気」を持つ寝室の機器に当たる事故を防ぐ。
    //  絞った結果0件なら、エイリアス一致は部屋違いだったので種別から取り直す)
    if (room && candidates.length > 0) {
      candidates = candidates.filter((d) => d.room === room);
    }

    if (candidates.length === 0 && typeHit) {
      candidates = devices.filter((d) => d.type === typeHit.type);
      if (room) candidates = candidates.filter((d) => d.room === room);
      else if (candidates.length > 1 && defaultRoom) {
        const inDefault = candidates.filter((d) => d.room === defaultRoom);
        if (inDefault.length > 0) candidates = inDefault;
      }
    }

    // 複数台をまとめて操作してよいのは「部屋が特定でき、全候補が同じ部屋」のときだけ。
    // (「電気つけて」で家中の照明が点く事故を防ぐ)
    const candidateRooms = new Set(candidates.map((c) => c.room));
    const groupable = candidates.length === 1 || (room !== null && candidateRooms.size === 1);
    if (!groupable) return { kind: 'home_ambiguous' };

    // 温度指定 (エアコン26度 など)
    const tempMatch = text.match(TEMP_RE);
    if (tempMatch && candidates.length > 0 && candidates.every((c) => c.type === 'climate')) {
      const temp = Number(tempMatch[1]);
      if (temp >= 16 && temp <= 32) {
        const modeMatch = text.match(MODE_RE);
        const hvacMode = modeMatch ? { 冷房: 'cool', 暖房: 'heat', 除湿: 'dry' }[modeMatch[1]] : undefined;
        const data: Record<string, unknown> = { temperature: temp };
        if (hvacMode) data.hvac_mode = hvacMode;
        const label = groupLabel(candidates, room);
        return {
          kind: 'home_direct',
          entityIds: candidates.map((c) => c.entityId),
          domain: 'climate',
          service: 'set_temperature',
          data,
          speak: `${label}を${temp}度にしました`,
          description: `${label} → ${temp}℃${modeMatch ? ` (${modeMatch[1]})` : ''}`,
        };
      }
    }

    // ON/OFF
    const isOn = ON_RE.test(text);
    const isOff = OFF_RE.test(text);
    if ((isOn || isOff) && !(isOn && isOff) && candidates.length > 0) {
      // まとめて操作するには、HAのドメインとサービス名が全候補で一致している必要がある
      const domains = new Set(candidates.map((c) => domainOf(c.entityId)));
      const svcs = candidates.map((c) => SERVICE_BY_TYPE[c.type]);
      if (domains.size === 1 && svcs.every((v) => v)) {
        const svc = svcs[0]!;
        const label = groupLabel(candidates, room);
        return {
          kind: 'home_direct',
          entityIds: candidates.map((c) => c.entityId),
          domain: [...domains][0],
          service: isOn ? svc.on : svc.off,
          data: {},
          speak: isOn ? `${label}をつけました` : `${label}を消しました`,
          description: `${label} → ${isOn ? 'ON' : 'OFF'}`,
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
