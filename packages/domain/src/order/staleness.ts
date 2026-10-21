/**
 * "Has this order moved on since the client last looked?" — pure helpers
 * shared by the order router's stale-input guards (2026-10-21 audit
 * follow-ups CA-43 and CA-25).
 */
import type { OrderEvent } from './events';

/**
 * CA-43 "approve what you saw": did anyone OTHER than `memberId` append
 * to the stream after `sinceSeq`?
 *
 * The approver's own events are deliberately ignored. Claiming bumps the
 * seq, and so do the approver's in-place quantity edits — they already
 * saw those, and the list they read `lastSeq` from may not have
 * refetched yet. Anything else (the staff withdrawing, editing and
 * re-submitting; another approver's claim or release; a system event
 * with no member) means the order on screen is not the order on disk.
 */
export function changedByOthersSince(
  events: ReadonlyArray<Pick<OrderEvent, 'seq' | 'actorMemberId'>>,
  sinceSeq: number,
  memberId: string,
): boolean {
  return events.some((e) => e.seq > sinceSeq && e.actorMemberId !== memberId);
}

/**
 * CA-25 offline replay: is `date` (the business day frozen into a queued
 * write) earlier than `today` (both YYYY-MM-DD in the org timezone)?
 * ISO calendar dates order correctly as plain strings.
 */
export function isPastBusinessDate(date: string, today: string): boolean {
  return date < today;
}
