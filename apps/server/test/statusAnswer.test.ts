import { describe, expect, it, vi, afterEach } from 'vitest';
import { v4 as uuid } from 'uuid';
import { makeTestEnv } from './helpers.js';
import { devices } from '../src/db/schema.js';
import { answerStatus } from '../src/statusAnswer.js';
import type { HomeAssistantClient } from '../src/ha/client.js';

afterEach(() => vi.unstubAllGlobals());

function seed(env: ReturnType<typeof makeTestEnv>, rows: Array<[string, string, string | null, string]>) {
  for (const [entityId, name, room, type] of rows) {
    env.db
      .insert(devices)
      .values({
        id: uuid(),
        userId: env.userId,
        entityId,
        name,
        room,
        type,
        aliases: '[]',
        createdAt: new Date().toISOString(),
      })
      .run();
  }
}

const deps = (env: ReturnType<typeof makeTestEnv>, location = '') => ({
  db: env.db,
  userId: env.userId,
  ha: env.ha as unknown as HomeAssistantClient,
  location,
});

describe('状態確認の即答', () => {
  it('室温と湿度を答える', async () => {
    const env = makeTestEnv();
    seed(env, [
      ['sensor.temp', '室温', null, 'sensor'],
      ['sensor.hum', '湿度', null, 'sensor'],
    ]);
    env.ha.states.set('sensor.temp', {
      entity_id: 'sensor.temp',
      state: '24.8',
      attributes: { device_class: 'temperature' },
    });
    env.ha.states.set('sensor.hum', {
      entity_id: 'sensor.hum',
      state: '59',
      attributes: { device_class: 'humidity' },
    });

    const answer = await answerStatus('indoor', deps(env));
    expect(answer).toBe('室温は24.8度、湿度は59%です。');
  });

  it('センサーが無ければその旨を伝える (誤った数字を言わない)', async () => {
    const env = makeTestEnv();
    const answer = await answerStatus('indoor', deps(env));
    expect(answer).toContain('見つかりませんでした');
  });

  it('同じ部屋の照明はまとめて読み上げる', async () => {
    const env = makeTestEnv();
    seed(env, [
      ['light.l1', 'リビング1', 'リビング', 'light'],
      ['light.l2', 'リビング2', 'リビング', 'light'],
      ['light.l3', 'リビング3', 'リビング', 'light'],
      ['light.bed', '寝室の電気', '寝室', 'light'],
    ]);
    for (const id of ['light.l1', 'light.l2', 'light.l3', 'light.bed']) {
      env.ha.states.set(id, { entity_id: id, state: 'on', attributes: {} });
    }
    const answer = await answerStatus('home', deps(env));
    // 「リビング1とリビング2と…」ではなく「リビングの照明」にまとめる
    expect(answer).toContain('リビングの照明');
    expect(answer).not.toContain('リビング1と');
    // 1個だけの部屋は個別名のまま
    expect(answer).toContain('寝室の電気');
  });

  it('鍵とエアコンの状態を含める', async () => {
    const env = makeTestEnv();
    seed(env, [
      ['climate.living', 'リビングのエアコン', 'リビング', 'climate'],
      ['lock.front', '玄関の鍵', '玄関', 'lock'],
    ]);
    env.ha.states.set('climate.living', {
      entity_id: 'climate.living',
      state: 'cool',
      attributes: { temperature: 26 },
    });
    env.ha.states.set('lock.front', { entity_id: 'lock.front', state: 'locked', attributes: {} });

    const answer = await answerStatus('home', deps(env));
    expect(answer).toContain('冷房26度');
    expect(answer).toContain('玄関の鍵は閉まっています');
  });

  it('鍵が開いていればそう伝える', async () => {
    const env = makeTestEnv();
    seed(env, [['lock.front', '玄関の鍵', '玄関', 'lock']]);
    env.ha.states.set('lock.front', { entity_id: 'lock.front', state: 'unlocked', attributes: {} });
    expect(await answerStatus('home', deps(env))).toContain('開いています');
  });

  it('時刻はJSTで答える', async () => {
    const env = makeTestEnv();
    expect(await answerStatus('time', deps(env))).toMatch(/^今は\d{1,2}:\d{2}です。$/);
  });

  it('天気は外気温と室内をあわせて答える', async () => {
    const env = makeTestEnv();
    seed(env, [['sensor.temp', '室温', null, 'sensor']]);
    env.ha.states.set('sensor.temp', {
      entity_id: 'sensor.temp',
      state: '24.8',
      attributes: { device_class: 'temperature' },
    });
    vi.stubGlobal('fetch', async () =>
      new Response(JSON.stringify({ current: { temperature_2m: 18.9, weather_code: 51 } }), { status: 200 }),
    );
    const answer = await answerStatus('weather', deps(env, '35.0,135.0'));
    expect(answer).toContain('18.9度');
    expect(answer).toContain('小雨');
    expect(answer).toContain('24.8度');
  });

  it('天気が取れなくても室内は答える (全体を落とさない)', async () => {
    const env = makeTestEnv();
    seed(env, [['sensor.temp', '室温', null, 'sensor']]);
    env.ha.states.set('sensor.temp', {
      entity_id: 'sensor.temp',
      state: '24.8',
      attributes: { device_class: 'temperature' },
    });
    vi.stubGlobal('fetch', async () => new Response('', { status: 500 }));
    const answer = await answerStatus('weather', deps(env, '35.0,135.0'));
    expect(answer).toContain('取得できませんでした');
    expect(answer).toContain('24.8度');
  });
});

describe('状態取得が遅いとき', () => {
  it('待たされ続けず、取得できなかった旨を返す (音声応答が目的のため)', async () => {
    const env = makeTestEnv();
    // HAが応答しない状況を作る
    env.ha.getStates = () => new Promise(() => undefined);
    const started = Date.now();
    const answer = await answerStatus('indoor', deps(env));
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(6000);
    expect(answer).toContain('見つかりませんでした');
  }, 10_000);
});
