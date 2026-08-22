import { describe, expect, it } from 'vitest';
import { LoginRateLimiter, clientKey } from '../src/rateLimit.js';

describe('ログイン試行のレートリミット', () => {
  it('5回失敗するとロックされる', () => {
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < 4; i++) limiter.recordFailure('1.2.3.4');
    expect(limiter.lockedFor('1.2.3.4')).toBe(0); // 4回目まではまだ試せる
    limiter.recordFailure('1.2.3.4');
    expect(limiter.lockedFor('1.2.3.4')).toBeGreaterThan(0);
  });

  it('ロックは15分で解ける', () => {
    let now = 1_000_000;
    const limiter = new LoginRateLimiter(() => now);
    for (let i = 0; i < 5; i++) limiter.recordFailure('1.2.3.4');
    expect(limiter.lockedFor('1.2.3.4')).toBeGreaterThan(0);
    now += 15 * 60_000 + 1000;
    expect(limiter.lockedFor('1.2.3.4')).toBe(0);
  });

  it('成功したら失敗カウントは消える', () => {
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < 4; i++) limiter.recordFailure('1.2.3.4');
    limiter.recordSuccess('1.2.3.4');
    for (let i = 0; i < 4; i++) limiter.recordFailure('1.2.3.4');
    expect(limiter.lockedFor('1.2.3.4')).toBe(0);
  });

  it('別のIPは巻き込まれない', () => {
    const limiter = new LoginRateLimiter();
    for (let i = 0; i < 5; i++) limiter.recordFailure('1.2.3.4');
    expect(limiter.lockedFor('5.6.7.8')).toBe(0);
  });

  it('失敗が15分以上あくとカウントはリセットされる', () => {
    let now = 1_000_000;
    const limiter = new LoginRateLimiter(() => now);
    for (let i = 0; i < 4; i++) limiter.recordFailure('1.2.3.4');
    now += 16 * 60_000;
    limiter.recordFailure('1.2.3.4');
    expect(limiter.lockedFor('1.2.3.4')).toBe(0);
  });

  it('プロキシ配下ではX-Forwarded-Forの先頭を使う', () => {
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.5, 10.0.0.1' });
    expect(clientKey(headers)).toBe('203.0.113.5');
  });
});
