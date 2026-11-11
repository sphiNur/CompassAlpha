/**
 * Date presets for the Finance range picker.
 *
 * The calendar helpers they are built on, and why they read the calendar
 * directly (CA-23), live in lib/calendarDate.ts (COREWEB2-21).
 * `localDateValue` is re-exported for the callers that import it from here.
 */
import { calendarParts, isoDate, localDateValue } from '../../../lib/calendarDate';

export { localDateValue };

export type FinanceRangePreset = 'today' | 'yesterday' | 'thisMonth' | 'lastMonth';

/** Inclusive [startDate, endDate] for a Finance preset, local calendar. */
export function financePresetRange(
  preset: FinanceRangePreset,
  now: Date = new Date(),
  timeZone?: string,
): { startDate: string; endDate: string } {
  const { y, m, d } = calendarParts(now, timeZone);
  switch (preset) {
    case 'today': {
      const t = isoDate(y, m, d);
      return { startDate: t, endDate: t };
    }
    case 'yesterday': {
      const t = isoDate(y, m, d - 1);
      return { startDate: t, endDate: t };
    }
    case 'thisMonth':
      return { startDate: isoDate(y, m, 1), endDate: isoDate(y, m, d) };
    case 'lastMonth':
      return {
        startDate: isoDate(y, m - 1, 1),
        // Day 0 of this month = last day of the previous one.
        endDate: isoDate(y, m, 0),
      };
  }
}

/**
 * 2026-10-21 FE-07 (F6-01): the maintenance "reset today" / targeted-purge
 * default date. It used `toISOString().slice(0, 10)` (UTC), so between
 * local 00:00 and 05:00 in Tashkent "today" was YESTERDAY — and the purge
 * is irreversible. ADM2-28 (2026-11-11): the page passes the org's time
 * zone from the session, as Finance does (HIS-13); without one (a session
 * from an older server) this is the device's calendar date. The dry-run
 * preview still shows the date before anything is deleted.
 */
export function maintenanceToday(now: Date = new Date(), timeZone?: string): string {
  return localDateValue(now, timeZone);
}
