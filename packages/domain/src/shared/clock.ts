/**
 * Injectable clock. The aggregates take the time from the Clock their
 * caller passes (tests a fixed instant, production `systemClock`) and
 * never read the system time themselves. The date helpers further down
 * serve the API's routers, and default to the current instant (review
 * ORD-17: this said no domain code reads the time, under a helper that
 * does).
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export function fixedClock(at: Date): Clock {
  return { now: () => new Date(at) };
}

/**
 * Today's date as `YYYY-MM-DD` in the given IANA timezone — D.1 (M3.39,
 * 2026-05-20). Replaces the UTC-only placeholders in API routers that
 * caused day rollover to land at midnight UTC (5am Tashkent local).
 *
 * The Intl.DateTimeFormat instance is cached per-tz because formatters
 * are expensive to construct; the order router's `todaySession` hits
 * this on every page load. Cache is unbounded but realistic load
 * (≤ a few dozen unique IANA strings across an entire orgs table) is
 * fine — no eviction.
 *
 * `en-CA` is intentional: it produces ISO-8601-style `YYYY-MM-DD` for
 * the `{ year: 'numeric', month: '2-digit', day: '2-digit' }` options
 * across every browser + Node + Bun. `en-US` would emit `MM/DD/YYYY`.
 */
const dateFmtCache = new Map<string, Intl.DateTimeFormat>();
function getDateFmt(tz: string): Intl.DateTimeFormat {
  const cached = dateFmtCache.get(tz);
  if (cached) return cached;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  dateFmtCache.set(tz, fmt);
  return fmt;
}

export function todayInTz(tz: string, now: Date = new Date()): string {
  return getDateFmt(tz).format(now);
}

/**
 * Format ANY instant as `YYYY-MM-DD` in the given IANA tz. Used when a
 * caller already has a Date in hand (e.g., for filter ranges with an
 * "as of yesterday" offset). For "today right now", prefer
 * `todayInTz(tz)`.
 */
export function dateInTz(at: Date, tz: string): string {
  return getDateFmt(tz).format(at);
}

const MINUTE = 60_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const wallClockFmtCache = new Map<string, Intl.DateTimeFormat>();
function getWallClockFmt(tz: string): Intl.DateTimeFormat {
  const cached = wallClockFmtCache.get(tz);
  if (cached) return cached;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  wallClockFmtCache.set(tz, fmt);
  return fmt;
}

/** Offset of `tz` from UTC at `at`, in minutes (Asia/Tashkent → +300). */
function offsetMinutes(tz: string, at: Date): number {
  const parts = getWallClockFmt(tz).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - at.getTime()) / MINUTE);
}

/**
 * `YYYY-MM-DD` + `HH:MM` wall-clock time in `tz` → the instant; `'00:00'`
 * gives the start of that business day. Review CONF-16: sales and
 * attendance each had their own copy, so a DST fix in one would have
 * missed the other.
 */
export function zonedTimeToUtc(date: string, time: string, tz: string): Date {
  const d = DATE_RE.exec(date);
  const t = TIME_RE.exec(time);
  if (!d || !t) throw new Error(`bad local time ${date} ${time}`);
  const guess = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  // Two passes settle the offset across a DST change.
  let at = guess - offsetMinutes(tz, new Date(guess)) * MINUTE;
  at = guess - offsetMinutes(tz, new Date(at)) * MINUTE;
  return new Date(at);
}

/** The date `days` after `date` (`YYYY-MM-DD`); a negative count goes back. */
export function nextDate(date: string, days = 1): string {
  const d = DATE_RE.exec(date);
  if (!d) throw new Error(`bad date ${date}`);
  const at = new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]) + days));
  return at.toISOString().slice(0, 10);
}
