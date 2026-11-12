import { isTimeZone } from '@compass/contracts';
import { todayInTz } from '@compass/domain';

/**
 * The time zone a store's business day runs in: its own when it is a real
 * zone, else the organisation's. CLS-7 (2026-10-30): a store saved with an
 * unknown zone made every business-date read for it fail (no daily close,
 * no sales list); input is validated now, and rows saved before still work.
 */
export function storeTimeZone(storeZone: string | null | undefined, orgZone: string): string {
  return storeZone && isTimeZone(storeZone) ? storeZone : orgZone;
}

/**
 * Today as YYYY-MM-DD in the caller's organisation's time zone (the session
 * carries it, from organizations.timezone); UTC without a session. D.1
 * (M3.39, 2026-05-20): it was UTC's date, so in Tashkent (UTC+5) an order
 * or a run made before 05:00 landed on the day before. Review RUNAPI-13
 * (2026-11-12): the order and run routers each had a copy.
 */
export function orgToday(session: { orgTimezone: string } | null): string {
  return todayInTz(session?.orgTimezone ?? 'UTC');
}
