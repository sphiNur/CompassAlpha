/**
 * Calendar dates as the server writes them, `YYYY-MM-DD` (COREWEB2-21,
 * 2026-11-11: one home for what the offline queue, the finance presets and
 * three attendance pages each wrote for themselves).
 *
 * Read straight off a calendar, never through UTC. 2026-10-21 audit CA-23
 * (D-05): `toISOString().slice(0, 10)` re-reads a local Date in UTC, and
 * east of UTC (Tashkent is UTC+5) local midnight is still the day before
 * there, so between 00:00 and 05:00 "today" was yesterday.
 *
 * Business dates (orders, runs, the daily close, attendance) are days of
 * the org's calendar: the server dates them in the org's time zone, or in a
 * store's own where it has one. The session carries the org's zone
 * (HIS-13), so "today" is read in it; a phone set to another zone must not
 * move the day. A session from an older server has no zone, and then the
 * phone's calendar stands in.
 *
 * Pure: no React, no store. Tests pass the zone and the instant (changing
 * process.env.TZ is unreliable once other code in the process has used
 * Date).
 */

/**
 * Year, month (1–12) and day of `date` on the zone's calendar, or on the
 * phone's without one. A zone the runtime does not know reads the phone's
 * calendar too, rather than failing the page that asked.
 */
export function calendarParts(date: Date, timeZone?: string): { y: number; m: number; d: number } {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
      }).formatToParts(date);
      const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
      return { y: get('year'), m: get('month'), d: get('day') };
    } catch {
      // RangeError: not a zone this runtime knows. Fall through.
    }
  }
  return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
}

/**
 * `YYYY-MM-DD` of a year, month (1–12) and day. One out of range rolls
 * over: day 0 is the last day of the month before.
 */
export function isoDate(y: number, m: number, d: number): string {
  const dt = new Date(Date.UTC(y, m - 1, d));
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

/** `YYYY-MM-DD` of `date` on the zone's calendar, or on the phone's. */
export function localDateValue(date: Date, timeZone?: string): string {
  const { y, m, d } = calendarParts(date, timeZone);
  return isoDate(y, m, d);
}

/**
 * Today on the org's calendar. Pass the session's zone
 * (`session.member.timezone`); without one it is the phone's today.
 */
export function orgToday(timeZone: string | undefined, now: Date = new Date()): string {
  return localDateValue(now, timeZone);
}

/** This month (`YYYY-MM`) on the org's calendar, as `orgToday`. */
export function orgMonth(timeZone: string | undefined, now: Date = new Date()): string {
  return orgToday(timeZone, now).slice(0, 7);
}
