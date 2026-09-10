import { describe, expect, it } from 'vitest';
import { expandByMemory } from '../src/orchestrator.js';
import { classify, type DeviceInfo } from '../src/router/classifier.js';
import { makeTestEnv } from './helpers.js';

// home_direct はClaudeを通らない高速パスなので、記憶を効かせる場所がここしかない。
// 「この機器はこれらと必ずまとめて操作する」という好みだけを決定的に反映する。
const devices: DeviceInfo[] = [
  { entityId: 'light.dian_qi', name: '寝室の電気', room: '寝室', type: 'light', aliases: [] },
  { entityId: 'light.tradfri_bulb_6', name: '寝室の電球6', room: '寝室', type: 'light', aliases: [] },
  { entityId: 'switch.bedroom_ir', name: '寝室の赤外線', room: '寝室', type: 'light', aliases: [] },
  { entityId: 'light.rihinku1', name: 'リビング1', room: 'リビング', type: 'light', aliases: [] },
];

describe('記憶による操作対象の補正 (home_directの高速パス)', () => {
  it('まとめ操作の記憶があれば対象が広がる', () => {
    const groups = [['light.dian_qi', 'light.tradfri_bulb_6']];
    expect(expandByMemory(['light.dian_qi'], groups, devices).sort()).toEqual([
      'light.dian_qi',
      'light.tradfri_bulb_6',
    ]);
  });

  it('記憶が無ければそのまま', () => {
    expect(expandByMemory(['light.dian_qi'], [], devices)).toEqual(['light.dian_qi']);
  });

  it('関係のない組では広がらない', () => {
    const groups = [['light.rihinku1', 'light.rihinku2']];
    expect(expandByMemory(['light.dian_qi'], groups, devices)).toEqual(['light.dian_qi']);
  });

  it('登録されていない機器には広げない', () => {
    const groups = [['light.dian_qi', 'light.unknown_bulb']];
    expect(expandByMemory(['light.dian_qi'], groups, devices)).toEqual(['light.dian_qi']);
  });

  it('HAドメインが違う機器には広げない (light.turn_off を switch.* に投げると何も起きない)', () => {
    const groups = [['light.dian_qi', 'switch.bedroom_ir']];
    expect(expandByMemory(['light.dian_qi'], groups, devices)).toEqual(['light.dian_qi']);
  });

  it('別の部屋には広げない', () => {
    const groups = [['light.dian_qi', 'light.rihinku1']];
    expect(expandByMemory(['light.dian_qi'], groups, devices)).toEqual(['light.dian_qi']);
  });

  it('対象が複数の部屋にまたがっているときは何もしない', () => {
    const groups = [['light.dian_qi', 'light.tradfri_bulb_6']];
    const targets = ['light.dian_qi', 'light.rihinku1'];
    expect(expandByMemory(targets, groups, devices)).toEqual(targets);
  });
});

describe('実環境の再現: 「寝室の電気を全部消して」で4灯すべて消える', () => {
  // 9/3〜9/10のあいだに同じ指摘を5回受け、同じ記憶が5件保存されていたケース。
  const real: DeviceInfo[] = [
    { entityId: 'light.dian_qi', name: '寝室の電気', room: '寝室', type: 'light', aliases: [] },
    { entityId: 'light.dian_qiu_5', name: '寝室の電球5', room: '寝室', type: 'light', aliases: [] },
    { entityId: 'light.tradfri_bulb_6', name: '寝室の電球6', room: '寝室', type: 'light', aliases: [] },
    { entityId: 'light.tradfri_bulb_7', name: '寝室の電球7', room: '寝室', type: 'light', aliases: [] },
    { entityId: 'switch.taininkunodian_qi', name: 'ダイニングの電気', room: 'ダイニング', type: 'light', aliases: ['ダイニングの照明'] },
    { entityId: 'light.rihinku1', name: 'リビング1', room: 'リビング', type: 'light', aliases: [] },
    { entityId: 'light.rihinku2', name: 'リビング2', room: 'リビング', type: 'light', aliases: [] },
  ];

  for (const text of ['寝室の電気を全部消して', '寝室の電気消して', '寝室の電気を消して']) {
    it(`「${text}」→ 寝室の照明4つ`, () => {
      const env = makeTestEnv();
      // 実際に保存されていた記憶
      env.memory.write({
        kind: 'preference',
        title: '「寝室の電気」が指す対象',
        content:
          '「寝室の電気(照明)」は寝室の照明すべてを指す: light.dian_qi / light.dian_qiu_5 / ' +
          'light.tradfri_bulb_6 / light.tradfri_bulb_7。一部だけ操作すると「全部消えていない」と' +
          '指摘されるため、寝室の照明操作は必ず4つまとめて実行する。',
      });

      const intent = classify(text, real);
      expect(intent.kind).toBe('home_direct');
      if (intent.kind !== 'home_direct') return;

      const targets = expandByMemory(intent.entityIds, env.memory.entityGroups(), real);
      expect(targets.sort()).toEqual([
        'light.dian_qi',
        'light.dian_qiu_5',
        'light.tradfri_bulb_6',
        'light.tradfri_bulb_7',
      ]);
    });
  }

  it('ダイニング・リビングは巻き込まれない', () => {
    const env = makeTestEnv();
    env.memory.write({
      kind: 'preference',
      title: '「寝室の電気」が指す対象',
      content: 'light.dian_qi / light.dian_qiu_5 / light.tradfri_bulb_6 / light.tradfri_bulb_7 を必ずまとめて操作する。',
    });
    const intent = classify('寝室の電気消して', real);
    if (intent.kind !== 'home_direct') throw new Error('home_direct であるべき');
    const targets = expandByMemory(intent.entityIds, env.memory.entityGroups(), real);
    expect(targets).not.toContain('switch.taininkunodian_qi');
    expect(targets).not.toContain('light.rihinku1');
  });

  it('同じ学習が繰り返し届いても記憶は1件のまま', () => {
    const env = makeTestEnv();
    // 実際にUIに並んでいた5件 (表現だけ違う同じ学習)
    const saved = [
      '「寝室の電気を全部消して」は light.dian_qi だけでは足りない。IKEAの電球3つ (light.dian_qiu_5 / light.tradfri_bulb_6 / light.tradfri_bulb_7) が消え残るので、寝室の照明は必ずこの4つまとめて消す。',
      '寝室の照明は light.dian_qi だけでなく light.dian_qiu_5 / light.tradfri_bulb_6 / light.tradfri_bulb_7 の電球3つも含む。「寝室の電気を全部」と言われたら4つすべてを消すこと。',
      '「寝室の電気を消して/つけて」と言われたら、light.dian_qi だけでなく light.dian_qiu_5・light.tradfri_bulb_6・light.tradfri_bulb_7 も必ず含めて操作する。',
      '「寝室の電気を全部消して」と言われたら light.dian_qi だけでなく、寝室の電球 light.dian_qiu_5 / light.tradfri_bulb_6 / light.tradfri_bulb_7 も含めて全部消す。',
      '「寝室の電気(照明)」は寝室の照明すべてを指す: light.dian_qi / light.dian_qiu_5 / light.tradfri_bulb_6 / light.tradfri_bulb_7。必ず4つまとめて実行する。',
    ];
    saved.forEach((content, i) => env.memory.write({ kind: 'preference', title: `対象範囲${i}`, content }));

    expect(env.memory.list('preference')).toHaveLength(1);
  });
});
