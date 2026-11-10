import type { useDateFormat, useI18n } from '../hooks/useI18n';

/** "1 h 20 min" in the UI language. */
export function minutesText(i18n: ReturnType<typeof useI18n>, minutes: number): string {
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
  i18n: ReturnType<typeof useI18n>,
  dates: Pick<ReturnType<typeof useDateFormat>, 'calendarDay'>,
  punch: { kind: 'in' | 'out'; date: string },
  rowDate: string,
): string {
  const kind = i18n.t(punch.kind === 'in' ? 'attendance.kind.in' : 'attendance.kind.out');
  if (punch.date === rowDate) return kind;
  return i18n.t('attendance.sheet.madeOn', { label: kind, date: dates.calendarDay(punch.date) });
}
