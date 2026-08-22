// 状態確認の即答 (Claude不使用)。
// Claude CLIはプロセス起動を伴い9〜12秒かかるため、Alexaの8秒制限に収まらない。
// 天気・室温・家の状態といった頻出の問い合わせはここで組み立てて即答する。

import { eq } from 'drizzle-orm';
import type { Db } from './db/index.js';
import { devices } from './db/schema.js';
import type { HomeAssistantClient, HaState } from './ha/client.js';

const WEATHER_CODES: Record<number, string> = {
  0: '快晴',
  1: 'おおむね晴れ',
  2: '所により曇り',
  3: '曇り',
  45: '霧',
  48: '霧',
  51: '小雨',
  53: '雨',
  55: '強い雨',
  61: '小雨',
  63: '雨',
  65: '強い雨',
  71: '雪',
  73: '雪',
  75: '大雪',
  80: 'にわか雨',
  81: 'にわか雨',
  82: '激しいにわか雨',
  95: '雷雨',
};

export interface StatusDeps {
  db: Db;
  userId: string;
  ha: HomeAssistantClient;
  location: string; // "lat,lon"
}

export async function answerStatus(
  topic: 'weather' | 'indoor' | 'home' | 'time',
  deps: StatusDeps,
): Promise<string> {
  if (topic === 'time') {
    const now = new Date().toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      hour: 'numeric',
      minute: '2-digit',
      hour12: false,
    });
    return `今は${now}です。`;
  }

  if (topic === 'weather') {
    const [weather, indoor] = await Promise.all([fetchWeather(deps.location), readIndoor(deps)]);
    const parts: string[] = [];
    if (weather) {
      parts.push(`外は${weather.temp}度で${weather.description}です`);
    } else {
      parts.push('外の天気は取得できませんでした');
    }
    if (indoor.temperature !== null) {
      parts.push(
        `室内は${indoor.temperature}度${indoor.humidity !== null ? `、湿度${indoor.humidity}%` : ''}です`,
      );
    }
    return `${parts.join('。')}。`;
  }

  if (topic === 'indoor') {
    const indoor = await readIndoor(deps);
    if (indoor.temperature === null && indoor.humidity === null) {
      return '室温を測れるセンサーが見つかりませんでした。';
    }
    const parts: string[] = [];
    if (indoor.temperature !== null) parts.push(`室温は${indoor.temperature}度`);
    if (indoor.humidity !== null) parts.push(`湿度は${indoor.humidity}%`);
    return `${parts.join('、')}です。`;
  }

  // home: 家全体のサマリ
  const [indoor, summary] = await Promise.all([readIndoor(deps), readHomeSummary(deps)]);
  const parts: string[] = [];
  if (indoor.temperature !== null) {
    parts.push(`室温${indoor.temperature}度${indoor.humidity !== null ? `、湿度${indoor.humidity}%` : ''}`);
  }
  // 音声で読み上げるため、点いている照明は部屋単位でまとめる
  // (「リビング1とリビング2と…」と7個並べても聞き取れない)
  if (summary.onLights.length > 0) parts.push(`${summarizeLights(summary.onLights)}が点いています`);
  else if (summary.hasLights) parts.push('照明は消えています');
  if (summary.climates.length > 0) parts.push(summary.climates.join('、'));
  if (summary.lock) parts.push(summary.lock);
  return parts.length > 0 ? `${parts.join('。')}。` : '家の状態を取得できませんでした。';
}

async function fetchWeather(
  location: string,
): Promise<{ temp: number; description: string } | null> {
  if (!location) return null;
  const [lat, lon] = location.split(',').map((s) => s.trim());
  if (!lat || !lon) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&timezone=Asia%2FTokyo`,
      { signal: ctrl.signal },
    );
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as { current?: { temperature_2m?: number; weather_code?: number } };
    const temp = data.current?.temperature_2m;
    if (temp === undefined) return null;
    return {
      temp: Math.round(temp * 10) / 10,
      description: WEATHER_CODES[data.current?.weather_code ?? -1] ?? '天気は不明',
    };
  } catch {
    return null;
  }
}

// 音声で即答するのが目的なので、家電の状態取得が遅い場合は待たずに諦める。
// (Mac Agent再接続中などにHA経由の取得が十数秒かかることがある)
const STATE_READ_TIMEOUT_MS = 4000;

async function loadStates(deps: StatusDeps): Promise<HaState[]> {
  if (!deps.ha.configured()) return [];
  try {
    return await Promise.race([
      deps.ha.getStates(),
      new Promise<HaState[]>((resolve) => setTimeout(() => resolve([]), STATE_READ_TIMEOUT_MS)),
    ]);
  } catch {
    return [];
  }
}

async function readIndoor(deps: StatusDeps): Promise<{ temperature: number | null; humidity: number | null }> {
  const states = await loadStates(deps);
  const registered = deps.db.select().from(devices).where(eq(devices.userId, deps.userId)).all();
  const byEntity = new Map(states.map((s) => [s.entity_id, s]));

  const pick = (deviceClass: string): number | null => {
    // 登録済みのセンサーを優先し、なければHA全体から探す
    for (const d of registered) {
      const s = byEntity.get(d.entityId);
      if (s?.attributes?.device_class === deviceClass) {
        const v = Number(s.state);
        if (Number.isFinite(v)) return v;
      }
    }
    for (const s of states) {
      if (s.attributes?.device_class === deviceClass && s.entity_id.startsWith('sensor.')) {
        const v = Number(s.state);
        if (Number.isFinite(v)) return v;
      }
    }
    return null;
  };

  return { temperature: pick('temperature'), humidity: pick('humidity') };
}

/** 部屋ごとにまとめる。同じ部屋に複数あれば「リビングの照明」と1つにする */
function summarizeLights(lights: Array<{ name: string; room: string | null }>): string {
  const byRoom = new Map<string, string[]>();
  for (const l of lights) {
    const key = l.room ?? '';
    byRoom.set(key, [...(byRoom.get(key) ?? []), l.name]);
  }
  const phrases = [...byRoom.entries()].map(([room, names]) =>
    names.length === 1 ? names[0] : room ? `${room}の照明` : `照明${names.length}個`,
  );
  return phrases.join('と');
}

async function readHomeSummary(deps: StatusDeps): Promise<{
  onLights: Array<{ name: string; room: string | null }>;
  hasLights: boolean;
  climates: string[];
  lock: string | null;
}> {
  const states = await loadStates(deps);
  const byEntity = new Map(states.map((s) => [s.entity_id, s]));
  const registered = deps.db.select().from(devices).where(eq(devices.userId, deps.userId)).all();

  const onLights: Array<{ name: string; room: string | null }> = [];
  const climates: string[] = [];
  let lock: string | null = null;
  let hasLights = false;

  for (const d of registered) {
    const s = byEntity.get(d.entityId);
    if (!s) continue;
    if (d.type === 'light') {
      hasLights = true;
      if (!['off', 'unavailable', 'unknown'].includes(s.state)) onLights.push({ name: d.name, room: d.room });
    } else if (d.type === 'climate') {
      if (!['off', 'unavailable', 'unknown'].includes(s.state)) {
        const temp = s.attributes?.temperature;
        const mode = { cool: '冷房', heat: '暖房', dry: '除湿', fan_only: '送風' }[s.state] ?? s.state;
        climates.push(`${d.name}は${mode}${temp !== undefined ? `${temp}度` : ''}`);
      }
    } else if (d.type === 'lock') {
      lock = s.state === 'locked' ? `${d.name}は閉まっています` : `${d.name}が開いています`;
    }
  }
  return { onLights, hasLights, climates, lock };
}
