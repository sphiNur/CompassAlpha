/**
 * "Has this order moved on since the client last looked?" — pure helpers
 * shared by the order router's stale-input guards (2026-10-21 audit
 * follow-ups CA-43 and CA-25).
 */
import type { OrderEvent } from './events';

/**
 * CA-43 "approve what you saw": did anyone OTHER than `userId` append
 * to the stream after `sinceSeq`?
 *
 * The approver's own events are deliberately ignored. Claiming bumps the
 * seq, and so do the approver's in-place quantity edits — they already
 * saw those, and the list they read `lastSeq` from may not have
 * refetched yet. Anything else (the staff withdrawing, editing and
 * re-submitting; another approver's claim or release; a system event
 * with no actor) means the order on screen is not the order on disk.
 *
 * One system event is also ignored: a timeout release of the caller's
 * own claim that is immediately followed by the caller re-claiming (see
 * `isOwnTimeoutReclaim`).
 *
 * Compared on `actorUserId`, not `actorMemberId`: the event store
 * persists the acting user (`domain.events.actor_id`) but returns
 * `actorMemberId: null` on read (eventStore.readStream), so a member-id
 * comparison would treat the approver's own claim as someone else's.
 */
export function changedByOthersSince(
  events: ReadonlyArray<StaleCheckEvent>,
  sinceSeq: number,
  userId: string,
): boolean {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  return ordered.some(
    (e, i) =>
      e.seq > sinceSeq && e.actorUserId !== userId && !isOwnTimeoutReclaim(ordered, i, userId),
  );
}

/**
 * The slice of an event the stale check reads. `type` / `payload` are
 * optional so callers that only know seq + actor still work; without
 * them no event is treated as a timeout release.
 */
export type StaleCheckEvent = Pick<OrderEvent, 'seq' | 'actorUserId'> & {
  type?: OrderEvent['type'];
  payload?: unknown;
};

/**
 * True when `ordered[i]` is the worker's timeout `ClaimReleased` of a
 * claim `userId` held, and the very next event is `userId` claiming the
 * order again. Neither event changes the order's content and nobody else
 * acted in between, so for "approve what you saw" the pair is a no-op:
 * an approver who sat on the review past CLAIM_TIMEOUT_MINUTES and
 * re-claimed is still looking at the order on disk.
 */
function isOwnTimeoutReclaim(
  ordered: ReadonlyArray<StaleCheckEvent>,
  i: number,
  userId: string,
): boolean {
  const release = ordered[i]!;
  if (release.type !== 'ClaimReleased' || release.actorUserId !== null) return false;
  if ((release.payload as { reason?: unknown } | undefined)?.reason !== 'timeout') return false;

  const next = ordered[i + 1];
  if (!next || next.type !== 'Claimed' || next.actorUserId !== userId) return false;

  // The claim that timed out must also have been this user's.
  for (let j = i - 1; j >= 0; j--) {
    const prev = ordered[j]!;
    if (prev.type === 'Claimed') return prev.actorUserId === userId;
    if (prev.type === 'ClaimReleased') return false;
  }
  return false;
}

/**
 * CA-25 offline replay: is `date` (the business day frozen into a queued
 * write) earlier than `today` (both YYYY-MM-DD in the org timezone)?
 * ISO calendar dates order correctly as plain strings.
 */
export function isPastBusinessDate(date: string, today: string): boolean {
  return date < today;
}
