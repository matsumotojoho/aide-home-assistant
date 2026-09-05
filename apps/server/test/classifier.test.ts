import { describe, expect, it } from 'vitest';
import { classify, type DeviceInfo } from '../src/router/classifier.js';
import { TEST_DEVICES } from './helpers.js';

describe('Router classifier', () => {
  it('明確な家電命令 (部屋+デバイス+ON) は home_direct', () => {
    const intent = classify('寝室の電気つけて', TEST_DEVICES);
    expect(intent.kind).toBe('home_direct');
    if (intent.kind === 'home_direct') {
      expect(intent.entityIds).toEqual(['light.bedroom']);
      expect(intent.service).toBe('turn_on');
    }
  });

  it('OFF命令も home_direct', () => {
    const intent = classify('寝室の電気消して', TEST_DEVICES);
    expect(intent.kind).toBe('home_direct');
    if (intent.kind === 'home_direct') expect(intent.service).toBe('turn_off');
  });

  it('HAドメインは種別ではなくentity_idから決める (赤外線照明は switch.*)', () => {
    // 赤外線リモコン経由の照明: 分類のため type=light だが entity_id は switch.*
    const irLight = [
      { entityId: 'switch.dining_light', name: 'ダイニングの電気', room: 'ダイニング', type: 'light', aliases: [] },
    ];
    const intent = classify('ダイニングの電気つけて', irLight);
    expect(intent.kind).toBe('home_direct');
    if (intent.kind === 'home_direct') {
      // light.turn_on を switch.* に投げるとHAは200を返しつつ何もしない
      expect(intent.domain).toBe('switch');
      expect(intent.service).toBe('turn_on');
    }
  });

  it('テレビ (media_player.*) もentity_idのドメインを使う', () => {
    const intent = classify('テレビつけて', TEST_DEVICES);
    expect(intent.kind).toBe('home_direct');
    if (intent.kind === 'home_direct') expect(intent.domain).toBe('media_player');
  });

  it('エイリアス指定 (テレビつけて) は home_direct', () => {
    const intent = classify('テレビつけて', TEST_DEVICES);
    expect(intent.kind).toBe('home_direct');
    if (intent.kind === 'home_direct') expect(intent.entityIds).toEqual(['media_player.living_tv']);
  });

  it('温度指定 (エアコン26度) は climate.set_temperature', () => {
    const intent = classify('エアコン26度にして', TEST_DEVICES);
    expect(intent.kind).toBe('home_direct');
    if (intent.kind === 'home_direct') {
      expect(intent.service).toBe('set_temperature');
      expect(intent.data?.temperature).toBe(26);
    }
  });

  it('冷房指定は hvac_mode を含む', () => {
    const intent = classify('冷房25度にして', TEST_DEVICES);
    expect(intent.kind).toBe('home_direct');
    if (intent.kind === 'home_direct') expect(intent.data?.hvac_mode).toBe('cool');
  });

  it('曖昧な家電命令 (いい感じ) は home_ambiguous', () => {
    expect(classify('部屋いい感じにして', TEST_DEVICES).kind).toBe('home_ambiguous');
    expect(classify('エアコン快適にして', TEST_DEVICES).kind).toBe('home_ambiguous');
    expect(classify('ちょっと暗くして', TEST_DEVICES).kind).toBe('home_ambiguous');
  });

  it('部屋未指定で同種デバイスが複数 → home_ambiguous', () => {
    expect(classify('電気つけて', TEST_DEVICES).kind).toBe('home_ambiguous');
  });

  it('部屋指定は汎用エイリアスより優先される (別部屋の機器を誤操作しない)', () => {
    // 実環境で発生: 寝室の機器に「電気」という汎用エイリアスが付いていると
    // 「リビングの電気消して」が寝室の電気を消してしまった
    const devs = [
      { entityId: 'light.bedroom', name: '寝室の電気', room: '寝室', type: 'light', aliases: ['電気', '照明'] },
      { entityId: 'light.living1', name: 'リビング1', room: 'リビング', type: 'light', aliases: [] },
      { entityId: 'light.living2', name: 'リビング2', room: 'リビング', type: 'light', aliases: [] },
    ];
    const intent = classify('リビングの電気消して', devs);
    expect(intent.kind).toBe('home_direct');
    if (intent.kind === 'home_direct') {
      expect(intent.entityIds).toEqual(['light.living1', 'light.living2']);
      expect(intent.entityIds).not.toContain('light.bedroom');
    }
  });

  it('同じ部屋の同種デバイスはまとめて1回で操作する (リビング4灯)', () => {
    // 実環境: リビングにTRÅDFRIの電球が4つある
    const livingLights = [
      { entityId: 'light.living1', name: 'リビング1', room: 'リビング', type: 'light', aliases: [] },
      { entityId: 'light.living2', name: 'リビング2', room: 'リビング', type: 'light', aliases: [] },
      { entityId: 'light.living3', name: 'リビング3', room: 'リビング', type: 'light', aliases: [] },
      { entityId: 'light.living4', name: 'リビング4', room: 'リビング', type: 'light', aliases: [] },
    ];
    const intent = classify('リビングの電気つけて', livingLights);
    expect(intent.kind).toBe('home_direct'); // Claudeを経由せず即実行できる
    if (intent.kind === 'home_direct') {
      expect(intent.entityIds).toHaveLength(4);
      expect(intent.service).toBe('turn_on');
      // 応答は1台ずつ読み上げずまとめて呼ぶ
      expect(intent.speak).toBe('リビングの照明をつけました');
    }
  });

  it('まとめ操作は同じ部屋のものだけを対象にする', () => {
    const mixed = [
      { entityId: 'light.living1', name: 'リビング1', room: 'リビング', type: 'light', aliases: [] },
      { entityId: 'light.living2', name: 'リビング2', room: 'リビング', type: 'light', aliases: [] },
      { entityId: 'light.bedroom', name: '寝室の電気', room: '寝室', type: 'light', aliases: [] },
    ];
    const intent = classify('リビングの電気消して', mixed);
    expect(intent.kind).toBe('home_direct');
    if (intent.kind === 'home_direct') {
      expect(intent.entityIds).toEqual(['light.living1', 'light.living2']);
    }
  });

  it('HAドメインが混在する場合はまとめず Claude に回す', () => {
    // 赤外線(switch.*)とZigbee(light.*)が同じ部屋に混在するケース
    const mixedDomains = [
      { entityId: 'light.living1', name: 'リビング1', room: 'リビング', type: 'light', aliases: [] },
      { entityId: 'switch.living_ir', name: 'リビング2', room: 'リビング', type: 'light', aliases: [] },
    ];
    expect(classify('リビングの電気つけて', mixedDomains).kind).toBe('home_ambiguous');
  });

  it('部屋未指定でも default_room 設定で一意になれば home_direct', () => {
    const intent = classify('電気つけて', TEST_DEVICES, 'リビング');
    expect(intent.kind).toBe('home_direct');
    if (intent.kind === 'home_direct') expect(intent.entityIds).toEqual(['light.living']);
  });

  it('時間指定を含む依頼は schedule', () => {
    expect(classify('今日19時に帰るから快適にしといて', TEST_DEVICES).kind).toBe('schedule');
    expect(classify('30分後にエアコンつけといて', TEST_DEVICES).kind).toBe('schedule');
  });

  it('PC操作は mac', () => {
    expect(classify('デスクトップのファイル整理して', TEST_DEVICES).kind).toBe('mac');
  });

  it('検索・相談は consult', () => {
    expect(classify('明日の天気どう?', TEST_DEVICES).kind).toBe('consult');
    expect(classify('この前調べたやつ何だっけ', TEST_DEVICES).kind).toBe('consult');
  });

  it('空文字は consult', () => {
    expect(classify('', TEST_DEVICES).kind).toBe('consult');
  });
});

describe('状態確認の高速パス (Alexaの8秒制限対策)', () => {
  it('天気・室温・時刻の問い合わせは status になる', () => {
    for (const [text, topic] of [
      ['天気を教えて', 'weather'],
      ['今の気温は', 'weather'],
      ['室温は', 'indoor'],
      ['今何度', 'indoor'],
      ['湿度どれくらい', 'indoor'],
      ['今何時', 'time'],
      ['家の状況を教えて', 'home'],
    ] as const) {
      const intent = classify(text, TEST_DEVICES);
      expect(intent.kind, text).toBe('status');
      if (intent.kind === 'status') expect(intent.topic, text).toBe(topic);
    }
  });

  it('操作指示は status に取られない', () => {
    // 「26度にして」は状態確認ではなく操作
    expect(classify('エアコン26度にして', TEST_DEVICES).kind).toBe('home_direct');
    expect(classify('ちょっと暗くして', TEST_DEVICES).kind).toBe('home_ambiguous');
    expect(classify('寝室の電気つけて', TEST_DEVICES).kind).toBe('home_direct');
  });

  it('時間指定のある依頼は status でなく schedule のまま', () => {
    expect(classify('今日19時に帰るから快適にしといて', TEST_DEVICES).kind).toBe('schedule');
  });

  it('一般的な相談は consult のまま', () => {
    expect(classify('この前調べたやつ何だっけ', TEST_DEVICES).kind).toBe('consult');
  });

  it('予報 (明日の天気など) は現在値で答えられないのでClaudeへ回す', () => {
    // 現在の天気しか持っていないため、未来の話を高速パスで答えてはいけない
    for (const text of ['明日の天気どう?', '今夜は雨降る?', '週末の天気教えて', '午後の気温は']) {
      expect(classify(text, TEST_DEVICES).kind, text).not.toBe('status');
    }
    // 現在の天気は高速パスのまま
    expect(classify('今の天気は', TEST_DEVICES).kind).toBe('status');
  });
});

describe('カーテン (cover)', () => {
  const devs: DeviceInfo[] = [
    { entityId: 'cover.bedroom_curtain', name: '寝室のカーテン', room: '寝室', type: 'cover', aliases: ['カーテン'] },
    { entityId: 'light.dian_qi', name: '寝室の電気', room: '寝室', type: 'light', aliases: ['電気'] },
  ];

  it('「カーテン開けて」で open_cover を呼ぶ', () => {
    const r = classify('寝室のカーテン開けて', devs);
    expect(r.kind).toBe('home_direct');
    if (r.kind !== 'home_direct') return;
    expect(r.service).toBe('open_cover');
    expect(r.domain).toBe('cover');
    expect(r.speak).toContain('開けました');
  });

  it('「カーテン閉めて」で close_cover を呼ぶ', () => {
    const r = classify('カーテン閉めて', devs);
    expect(r.kind).toBe('home_direct');
    if (r.kind !== 'home_direct') return;
    expect(r.service).toBe('close_cover');
  });

  // カーテンに「つけて」とは言わない。取り違えて照明を操作しないこと
  it('「電気つけて」はカーテンに当たらない', () => {
    const r = classify('寝室の電気つけて', devs);
    expect(r.kind).toBe('home_direct');
    if (r.kind !== 'home_direct') return;
    expect(r.entityIds).toEqual(['light.dian_qi']);
    expect(r.service).toBe('turn_on');
  });

  // 「ちょっとだけ開けて」のような曖昧表現はClaudeへ
  it('曖昧な開閉はClaudeへ回す', () => {
    expect(classify('カーテン少しだけ開けて', devs).kind).toBe('home_ambiguous');
  });
});
