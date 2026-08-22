// ログイン試行のレートリミット。
// 公開URLで運用しており、ログインできる=玄関の解錠まで承認できてしまうため、
// 総当たりを実用的な速度で試せないようにする。
//
// 単一ユーザー・単一プロセス運用のためメモリ上で管理する
// (Railway再起動でリセットされるが、総当たりの速度を落とす目的は達成できる)。

interface Attempt {
  failures: number;
  firstFailureAt: number;
  lockedUntil: number;
}

const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
const MAX_TRACKED = 1000;

export class LoginRateLimiter {
  private attempts = new Map<string, Attempt>();

  constructor(private now: () => number = Date.now) {}

  /** ロック中なら残り秒数を返す */
  lockedFor(key: string): number {
    const a = this.attempts.get(key);
    if (!a) return 0;
    const remain = a.lockedUntil - this.now();
    return remain > 0 ? Math.ceil(remain / 1000) : 0;
  }

  recordFailure(key: string): void {
    const now = this.now();
    this.gc(now);
    const a = this.attempts.get(key);
    if (!a || now - a.firstFailureAt > WINDOW_MS) {
      this.attempts.set(key, { failures: 1, firstFailureAt: now, lockedUntil: 0 });
      return;
    }
    a.failures++;
    if (a.failures >= MAX_FAILURES) {
      a.lockedUntil = now + LOCK_MS;
      a.failures = 0;
      a.firstFailureAt = now;
    }
  }

  recordSuccess(key: string): void {
    this.attempts.delete(key);
  }

  private gc(now: number): void {
    if (this.attempts.size < MAX_TRACKED) return;
    for (const [k, v] of this.attempts) {
      if (v.lockedUntil < now && now - v.firstFailureAt > WINDOW_MS) this.attempts.delete(k);
    }
  }
}

/** プロキシ配下 (Railway) では X-Forwarded-For の先頭が実クライアント */
export function clientKey(headers: { get(name: string): string | null }): string {
  const fwd = headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return headers.get('x-real-ip') ?? 'unknown';
}
