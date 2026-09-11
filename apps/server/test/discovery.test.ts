import { describe, expect, it } from 'vitest';
import { discover, guessRoom, inferType, toCandidate } from '../src/ha/discovery.js';
import type { HaState } from '../src/ha/client.js';

const st = (entity_id: string, attributes: Record<string, unknown> = {}, state = 'off'): HaState => ({
  entity_id,
  state,
  attributes,
});

describe('登録候補の種別判定', () => {
  it('操作できるドメインは候補になる', () => {
    expect(inferType('light.dian_qi', {})).toBe('light');
    expect(inferType('cover.bedroom_curtain', {})).toBe('cover');
    expect(inferType('climate.eakon', {})).toBe('climate');
    expect(inferType('switch.dining', {})).toBe('switch');
    expect(inferType('lock.xuan_guan', {})).toBe('lock');
    // HAのドメインとAideの種別は一致しないものがある
    expect(inferType('media_player.living_tv', {})).toBe('tv');
    expect(inferType('fan.bedroom', {})).toBe('switch');
  });

  it('操作対象にならないドメインは候補にしない', () => {
    for (const id of [
      'automation.morning',
      'script.goodnight',
      'scene.relax',
      'person.yuhi',
      'sun.sun',
      'weather.home',
      'device_tracker.iphone',
      'update.hacs',
      'button.restart',
    ]) {
      expect(inferType(id, {}), id).toBeNull();
    }
  });

  it('センサーは家の様子として意味のあるものだけ', () => {
    expect(inferType('sensor.rimotorimokon_temperature', { device_class: 'temperature' })).toBe('sensor');
    expect(inferType('sensor.rimotorimokon_humidity', { device_class: 'humidity' })).toBe('sensor');
    expect(inferType('binary_sensor.xuan_guan_nojian_door', { device_class: 'door' })).toBe('sensor');
    // 電池残量や電波強度まで並ぶと、本当に登録したい機器が埋もれる
    expect(inferType('sensor.bulb_battery', { device_class: 'battery' })).toBeNull();
    expect(inferType('sensor.wifi_signal', { device_class: 'signal_strength' })).toBeNull();
    expect(inferType('sensor.nazo', {})).toBeNull();
  });
});

describe('部屋の推定', () => {
  it('表示名に含まれる部屋名を拾う', () => {
    expect(guessRoom('寝室の電気', [])).toBe('寝室');
    expect(guessRoom('ダイニングのエアコン', [])).toBe('ダイニング');
    expect(guessRoom('玄関の鍵', [])).toBe('玄関');
  });

  it('登録済みの部屋名も候補にする', () => {
    expect(guessRoom('書斎のデスクライト', ['書斎'])).toBe('書斎');
    expect(guessRoom('離れの照明', ['離れ'])).toBe('離れ');
  });

  it('長い部屋名を優先する (「寝室2」と「寝室」の混在対策)', () => {
    expect(guessRoom('寝室2のカーテン', ['寝室', '寝室2'])).toBe('寝室2');
  });

  it('分からなければ空にする (登録後に編集できる)', () => {
    expect(guessRoom('よくわからない機器', [])).toBeNull();
  });
});

describe('候補の組み立て', () => {
  it('表示名・部屋・種別を埋める', () => {
    const c = toCandidate(st('cover.qin_shi_nokaten', { friendly_name: '寝室のカーテン' }, 'closed'), []);
    expect(c).toEqual({
      entityId: 'cover.qin_shi_nokaten',
      name: '寝室のカーテン',
      room: '寝室',
      type: 'cover',
      state: 'closed',
      controllable: true,
    });
  });

  it('friendly_nameが無ければentity_idを名前にする', () => {
    expect(toCandidate(st('light.nazo'), [])?.name).toBe('light.nazo');
  });

  it('センサーは操作対象ではないと分かるようにする', () => {
    const c = toCandidate(st('sensor.a', { friendly_name: '室温', device_class: 'temperature' }, '26.5'), []);
    expect(c?.controllable).toBe(false);
  });
});

describe('一覧の洗い出し (実環境に近い構成)', () => {
  const states: HaState[] = [
    st('light.dian_qi', { friendly_name: '寝室の電気' }, 'on'),
    st('light.tradfri_bulb_6', { friendly_name: '寝室の電球6' }, 'on'),
    st('cover.qin_shi_nokaten', { friendly_name: '寝室のカーテン' }, 'open'),
    st('cover.rihinkunoburaindo', { friendly_name: 'リビングのブラインド' }, 'closed'),
    st('climate.eakon', { friendly_name: '寝室のエアコン' }, 'cool'),
    st('light.nazo_no_raito', {}, 'off'),
    st('sensor.shitsuon', { friendly_name: '室温', device_class: 'temperature' }, '26'),
    st('sensor.batt', { friendly_name: '電池', device_class: 'battery' }, '80'),
    st('automation.asa', { friendly_name: '朝の自動化' }, 'on'),
    st('sun.sun', {}, 'above_horizon'),
  ];

  it('カーテンが候補に出る (登録漏れていた機器)', () => {
    const found = discover(states, []);
    const covers = found.filter((c) => c.type === 'cover');
    expect(covers.map((c) => c.entityId)).toEqual([
      'cover.rihinkunoburaindo',
      'cover.qin_shi_nokaten',
    ]);
    expect(covers.every((c) => c.controllable)).toBe(true);
  });

  it('対象外のエンティティは混ざらない', () => {
    const ids = discover(states, []).map((c) => c.entityId);
    expect(ids).not.toContain('automation.asa');
    expect(ids).not.toContain('sun.sun');
    expect(ids).not.toContain('sensor.batt');
    expect(ids).toContain('sensor.shitsuon');
  });

  it('部屋が分からないものは末尾に並ぶ', () => {
    const found = discover(states, []);
    const noRoom = found.filter((c) => c.room === null);
    expect(noRoom.length).toBeGreaterThan(0);
    expect(found.slice(-noRoom.length).every((c) => c.room === null)).toBe(true);
  });

  it('部屋ごとにまとまる', () => {
    const found = discover(states, []).filter((c) => c.room);
    const rooms = found.map((c) => c.room);
    expect(rooms).toEqual([...rooms].sort((a, b) => (a ?? '').localeCompare(b ?? '', 'ja')));
  });
});
