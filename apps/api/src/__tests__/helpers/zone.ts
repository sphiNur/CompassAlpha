/**
 * A time zone where it is midday now (review TEST1-08, 2026-11-10).
 *
 * Tests that count hours back from the real clock (a shift that ended an
 * hour ago, a clock-in five hours ago) and then look at "that day" took
 * those hours to fall on one calendar day. In Tashkent they did not
 * between midnight and 05:00, so a test failed only on the CI runs that
 * started in that window. Where it is midday, a date changes eleven hours
 * away at the nearest.
 */

/**
 * `Etc/GMT±N` (whole hours, no daylight saving) at which `at` falls
 * between 12:00 and 13:00, or `UTC`. The IANA names count the other way
 * round: Etc/GMT-5 is five hours ahead of UTC.
 */
export function middayZone(at: Date): string {
  const ahead = ((12 - at.getUTCHours() + 36) % 24) - 12; // −12 … +11
  if (ahead === 0) return 'UTC';
  return `Etc/GMT${ahead > 0 ? '-' : '+'}${Math.abs(ahead)}`;
}
