/**
 * Injectable clock. Tests pass a fixed instant; production passes Date.now().
 * Domain code never calls Date.now() / new Date() directly.
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
