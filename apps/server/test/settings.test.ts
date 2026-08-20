import { describe, expect, it } from 'vitest';
import { makeTestEnv } from './helpers.js';

describe('Settings', () => {
  it('未設定キーはデフォルト値を返す', () => {
    const env = makeTestEnv();
    expect(env.settings.get('ai.provider')).toBe('auto');
    expect(env.settings.get('ai.paid_api_fallback')).toBe('off'); // 有料API初期OFF (仕様書31)
    expect(env.settings.get('notifications.level')).toBe('important');
    expect(env.settings.get('memory.retention')).toBe('unlimited');
  });

  it('set → get で値が永続化される', () => {
    const env = makeTestEnv();
    env.settings.set('notifications.level', 'failure');
    expect(env.settings.get('notifications.level')).toBe('failure');
    env.settings.set('alexa.verbosity', 'short');
    expect(env.settings.get('alexa.verbosity')).toBe('short');
  });

  it('getAll はデフォルト+上書きをマージして返す', () => {
    const env = makeTestEnv();
    env.settings.set('router.default_room', 'リビング');
    const all = env.settings.getAll();
    expect(all['router.default_room']).toBe('リビング');
    expect(all['ai.provider']).toBe('auto');
  });
});
