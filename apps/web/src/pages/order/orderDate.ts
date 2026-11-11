/**
 * The order's business date, as the page sends it (2026-11-11, moved here
 * from hooks/useOfflineQueue.ts with COREWEB2-21).
 */
import { orgToday } from '../../lib/calendarDate';

/**
 * The business date to FREEZE into an offline-queued order write
 * (2026-10-21 audit CA-25). Without it the server resolved "today" at
 * REPLAY time, so a change made offline last night landed in this
 * morning's order. Prefer the date of the session the page is showing
 * (server truth); before any session exists, today on the org's calendar
 * (`orgTimeZone` = the session's `member.timezone`). COREWEB2-21: that was
 * the phone's date, on the assumption that staff phones run in the org's
 * time zone.
 */
export function frozenOrderDate(
  cached: { id: string; orderDate: string } | null | undefined,
  orgTimeZone: string | undefined,
  now: Date = new Date(),
): string {
  return cached && cached.id !== 'optimistic' ? cached.orderDate : orgToday(orgTimeZone, now);
}
