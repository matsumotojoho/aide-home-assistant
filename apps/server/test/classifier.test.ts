import { describe, expect, it } from 'vitest';
import { classify } from '../src/router/classifier.js';
import { TEST_DEVICES } from './helpers.js';

describe('Router classifier', () => {
  it('明確な家電命令 (部屋+デバイス+ON) は home_direct', () => {
    const intent = classify('寝室の電気つけて', TEST_DEVICES);
    expect(intent.kind).toBe('home_direct');
    if (intent.kind === 'home_direct') {
      expect(intent.entityId).toBe('light.bedroom');
      expect(intent.service).toBe('turn_on');
    }
  });

  it('OFF命令も home_direct', () => {
    const intent = classify('寝室の電気消して', TEST_DEVICES);
    expect(intent.kind).toBe('home_direct');
    if (intent.kind === 'home_direct') expect(intent.service).toBe('turn_off');
  });

  it('エイリアス指定 (テレビつけて) は home_direct', () => {
    const intent = classify('テレビつけて', TEST_DEVICES);
    expect(intent.kind).toBe('home_direct');
    if (intent.kind === 'home_direct') expect(intent.entityId).toBe('media_player.living_tv');
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

  it('部屋未指定でも default_room 設定で一意になれば home_direct', () => {
    const intent = classify('電気つけて', TEST_DEVICES, 'リビング');
    expect(intent.kind).toBe('home_direct');
    if (intent.kind === 'home_direct') expect(intent.entityId).toBe('light.living');
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
