// 繰り返しタスクの次回実行時刻計算。
// 形式: "daily@HH:MM" / "weekly:MON@HH:MM" (時刻はAsia/Tokyo)
// 日本はDSTが無いため固定オフセット(+9h)で計算する。

const DOW: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
const JST_OFFSET_MS = 9 * 3600_000;

export const RECURRENCE_RE = /^(daily|weekly:(SUN|MON|TUE|WED|THU|FRI|SAT))@(\d{1,2}):(\d{2})$/;

export function isValidRecurrence(recurrence: string): boolean {
  const m = recurrence.match(RECURRENCE_RE);
  if (!m) return false;
  const hh = Number(m[3]);
  const mm = Number(m[4]);
  return hh <= 23 && mm <= 59;
}

/** afterより後の、次の実行時刻 (UTC) を返す。形式不正ならnull。 */
export function nextOccurrence(recurrence: string, after: Date = new Date()): Date | null {
  const m = recurrence.match(RECURRENCE_RE);
  if (!m) return null;
  const hh = Number(m[3]);
  const mm = Number(m[4]);
  if (hh > 23 || mm > 59) return null;

  // JSTの壁時計で読めるよう+9hずらし、UTCゲッターで日付を取り出す
  const jst = new Date(after.getTime() + JST_OFFSET_MS);
  const y = jst.getUTCFullYear();
  const mo = jst.getUTCMonth();
  const d = jst.getUTCDate();

  const buildUtc = (dayOffset: number) => new Date(Date.UTC(y, mo, d + dayOffset, hh, mm) - JST_OFFSET_MS);

  if (m[1] === 'daily') {
    const today = buildUtc(0);
    return today > after ? today : buildUtc(1);
  }

  const targetDow = DOW[m[2]];
  const currentDow = jst.getUTCDay();
  let offset = (targetDow - currentDow + 7) % 7;
  let candidate = buildUtc(offset);
  if (candidate <= after) candidate = buildUtc(offset + 7);
  return candidate;
}
