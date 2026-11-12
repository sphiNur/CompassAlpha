import type { I18n } from '@compass/i18n';
import type { DateFormatters } from './dateFormat';

/** "1 h 20 min" in the UI language. */
export function minutesText(i18n: I18n, minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return i18n.t('attendance.duration.minutes', { m });
  if (m === 0) return i18n.t('attendance.duration.hours', { h });
  return i18n.t('attendance.duration.hoursMinutes', { h, m });
}

/**
 * "Out", or "Out (Nov 10)" for a clock-in made on another day than the row
 * it is listed under: an overnight shift's clock-out (2026-11-10). The
 * catalog sets brackets and spacing (Chinese: 下班（11月10日）).
 */
export function punchKindText(
  i18n: I18n,
  dates: Pick<DateFormatters, 'calendarDay'>,
  punch: { kind: 'in' | 'out'; date: string },
  rowDate: string,
): string {
  const kind = i18n.t(punch.kind === 'in' ? 'attendance.kind.in' : 'attendance.kind.out');
  if (punch.date === rowDate) return kind;
  return i18n.t('attendance.sheet.madeOn', { label: kind, date: dates.calendarDay(punch.date) });
}

/**
 * The order the attendance screens list a sheet's people in: those with
 * attendance switched on first, then by name in the UI language. The
 * server sorts in its own collation, which put Chinese names in code-point
 * order instead of pinyin.
 */
export function sheetMemberOrder(
  locale: string,
): (a: { enabled: boolean; name: string }, b: { enabled: boolean; name: string }) => number {
  return (a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name, locale);
}

/**
 * The badge tone of a punch's face check (2026-11-05). The day sheet and
 * the review queue both show it; it lived in the day sheet's page (review
 * ATT-23).
 */
export const FACE_TONE = {
  match: 'success',
  mismatch: 'danger',
  enrolled: 'info',
  unchecked: 'warn',
} as const;

/** The badge tone of a punch's liveness check (2026-11-06), as FACE_TONE. */
export const LIVE_TONE = {
  pass: 'success',
  passive: 'success',
  fail: 'danger',
  unchecked: 'warn',
} as const;
