import type { useI18n } from '../hooks/useI18n';

/** "1 h 20 min" in the UI language. */
export function minutesText(i18n: ReturnType<typeof useI18n>, minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return i18n.t('attendance.duration.minutes', { m });
  if (m === 0) return i18n.t('attendance.duration.hours', { h });
  return i18n.t('attendance.duration.hoursMinutes', { h, m });
}
