/**
 * Calendar-date helpers for the Finance range presets.
 *
 * 2026-10-21 audit CA-23 (D-05): the presets used to build a LOCAL Date
 * and then call `toISOString().slice(0, 10)`, which re-reads it in UTC.
 * East of UTC (Tashkent is UTC+5) local midnight is still "yesterday"
 * in UTC, so "this month" started on the last day of the previous month
 * and "today" between 00:00–05:00 resolved to yesterday. Everything here
 * reads the calendar Y/M/D directly instead.
 *
 * `timeZone` defaults to the device's zone (what the UI wants); tests pass
 * one explicitly, since mutating process.env.TZ is not reliable once other
 * code in the same process has already touched Date.
 */

export type FinanceRangePreset = 'today' | 'yesterday' | 'thisMonth' | 'lastMonth';

interface Ymd {
  y: number;
  /** 1-based month */
  m: number;
  d: number;
}

function ymdOf(date: Date, timeZone?: string): Ymd {
  if (!timeZone) {
    return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() };
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

/** Normalises an out-of-range Y/M/D (e.g. day 0) via UTC date arithmetic. */
function fmt(y: number, m: number, d: number): string {
  const dt = new Date(Date.UTC(y, m - 1, d));
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

/** `YYYY-MM-DD` of `date` on the local (or given) calendar — no UTC shift. */
export function localDateValue(date: Date, timeZone?: string): string {
  const { y, m, d } = ymdOf(date, timeZone);
  return fmt(y, m, d);
}

/** Inclusive [startDate, endDate] for a Finance preset, local calendar. */
export function financePresetRange(
  preset: FinanceRangePreset,
  now: Date = new Date(),
  timeZone?: string,
): { startDate: string; endDate: string } {
  const { y, m, d } = ymdOf(now, timeZone);
  switch (preset) {
    case 'today': {
      const t = fmt(y, m, d);
      return { startDate: t, endDate: t };
    }
    case 'yesterday': {
      const t = fmt(y, m, d - 1);
      return { startDate: t, endDate: t };
    }
    case 'thisMonth':
      return { startDate: fmt(y, m, 1), endDate: fmt(y, m, d) };
    case 'lastMonth':
      return {
        startDate: fmt(y, m - 1, 1),
        // Day 0 of this month = last day of the previous one.
        endDate: fmt(y, m, 0),
      };
  }
}

/**
 * 2026-10-21 FE-07 (F6-01): the maintenance "reset today" / targeted-purge
 * default date. It used `toISOString().slice(0, 10)` (UTC), so between
 * local 00:00 and 05:00 in Tashkent "today" was YESTERDAY — and the purge
 * is irreversible. No server business date is loaded on that page, so
 * this is the device's local calendar date (staff devices run in the
 * org's timezone; the dry-run preview still shows the date before commit).
 */
export function maintenanceToday(now: Date = new Date(), timeZone?: string): string {
  return localDateValue(now, timeZone);
}
