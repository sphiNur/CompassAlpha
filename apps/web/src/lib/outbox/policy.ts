/**
 * The offline outbox's rules, as pure functions: whose entry it is, when a
 * failed one is tried again, and what a failure means for it (drop it or
 * try again). engine.ts applies them; pages use hooks/useOfflineQueue.ts.
 *
 * Review COREWEB2-14 (2026-11-11): split out of hooks/useOfflineQueue.ts,
 * which held the whole engine.
 */
import type { OutboxEntry } from '../idb';
import { isLikelyNetworkError } from '../networkError';
import type { ReplayedProcedure } from './replayHandlers';

/** Who is signed in now: the person and the organisation they work in. */
export interface OutboxOwner {
  userId: string | undefined;
  orgId: string | undefined;
}

/**
 * How long an entry this session cannot replay is kept: one queued by
 * someone else on this device (or in another organisation), kept for
 * their own session, or one whose procedure has no replay handler. Every
 * procedure this bundle queues has one from app start (CMP-FE-3), so such
 * an entry was queued by another version of the app. Past this age either
 * kind is discarded, so it cannot stay in the queue for ever.
 *
 * Review COREWEB2-23: this used to say the owning page was "not mounted
 * yet", from before the handlers were registered at app level.
 */
const STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Should the signed-in session replay this entry? Only its author, in the
 * organisation it was made in. A field the entry lacks (queued before it
 * was recorded) does not count against it, as before.
 */
export function isOwnEntry(
  entry: Pick<OutboxEntry, 'ownerUserId' | 'ownerOrgId'>,
  owner: OutboxOwner,
): boolean {
  if (!owner.userId) return false;
  if (entry.ownerUserId !== undefined && entry.ownerUserId !== owner.userId) return false;
  return entry.ownerOrgId === undefined || entry.ownerOrgId === owner.orgId;
}

/** The tRPC error code of a failed call, if the server answered with one. */
export function trpcErrorCode(err: unknown): string | undefined {
  return (err as { data?: { code?: string } } | undefined)?.data?.code;
}

/**
 * Does a write-ahead send that failed leave its entry queued? The
 * replay's rule (countsTowardGiveUp): no answer, or an answer about the
 * session rather than the write. Pages keep such a change on screen.
 *
 * COREWEB2-02 (2026-11-09): the send used to delete the entry on
 * UNAUTHORIZED (the refresh token was refused; the person is signed in
 * again at once), which the replay deliberately keeps.
 */
export function staysQueued(err: unknown): boolean {
  return isLikelyNetworkError(err) || !countsTowardGiveUp(trpcErrorCode(err));
}

/**
 * Does this failure say anything about the entry itself? No code means
 * the request never got an answer, UNAUTHORIZED is about the session, and
 * SERVICE_UNAVAILABLE about the server (its database could not be reached,
 * COREAPI-15). None is a reason to move an entry toward being abandoned.
 */
export function countsTowardGiveUp(code: string | undefined): boolean {
  return code !== undefined && code !== 'UNAUTHORIZED' && code !== 'SERVICE_UNAVAILABLE';
}

const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

/**
 * Has enough time passed to try a previously failed entry again? Flushes
 * run often (every new write, reconnecting, coming back to the app, a
 * 15-second timer), and without a wait a server outage used up the whole
 * retry budget in seconds.
 */
export function isRetryDue(
  retries: number,
  lastAttemptAt: number | undefined,
  now: number,
): boolean {
  if (retries === 0 || lastAttemptAt === undefined) return true;
  const wait = Math.min(RETRY_BASE_MS * 2 ** (retries - 1), RETRY_MAX_MS);
  return now - lastAttemptAt >= wait;
}

export type EntryAction = 'replay' | 'skip' | 'expire';

/**
 * Decide what flush() should do with a queued entry. Pure so the C1
 * regression (unknown procedure must NOT be deleted on sight) can be
 * pinned in a unit test without a DOM/IDB harness.
 *   - live handler present            → 'replay'
 *   - no handler, still fresh          → 'skip'  (kept: see STALE_TTL_MS)
 *   - no handler, older than TTL       → 'expire' (discarded)
 */
export function classifyEntry(
  hasHandler: boolean,
  ageMs: number,
  staleTtlMs: number = STALE_TTL_MS,
): EntryAction {
  if (hasHandler) return 'replay';
  return ageMs > staleTtlMs ? 'expire' : 'skip';
}

export type ReplayErrorAction = 'drop' | 'retry';

/**
 * Per-procedure exceptions to classifyReplayError's terminal codes
 * (2026-10-21 audit CA-25). order.adjustItem / order.setSessionExtras CONFLICT is the
 * (streamId, seq) collision of two writers on the same draft — nothing
 * is wrong with the queued change, and on replay it typically collides
 * with the user's own live taps (or a second tab) landing at the same
 * moment. Dropping it lost a real edit; retry it a couple of times with
 * the usual backoff instead. The cap keeps a genuinely stuck entry from
 * blocking the queue.
 */
export const REPLAY_RETRYABLE_OVERRIDES: {
  readonly [P in ReplayedProcedure]?: ReadonlySet<string>;
} = {
  'order.adjustItem': new Set(['CONFLICT']),
  'order.setSessionExtras': new Set(['CONFLICT']),
  // R2 (2026-10-30): a run has one event stream for every buyer and
  // store, so a replay racing someone else's write was dropped as
  // "rejected" — a real purchase or confirmation lost. The server now
  // retries such races itself; a CONFLICT that still gets through is
  // retried here too, not discarded.
  'run.purchaseItem': new Set(['CONFLICT']),
  'run.markUnavailable': new Set(['CONFLICT']),
  'run.addPurchaserItem': new Set(['CONFLICT']),
  'run.addExpense': new Set(['CONFLICT']),
  'run.deliverToStore': new Set(['CONFLICT']),
  'run.confirmStoreItem': new Set(['CONFLICT']),
  'run.markStoreItemsOk': new Set(['CONFLICT']),
  'run.confirmStore': new Set(['CONFLICT']),
};
/** The same map by any name: a queued entry may come from another bundle. */
const overridesByName: Readonly<Record<string, ReadonlySet<string> | undefined>> =
  REPLAY_RETRYABLE_OVERRIDES;
export const MAX_OVERRIDE_RETRIES = 2;

/**
 * Classify a replay failure (H3). Terminal codes can never succeed on
 * retry, so we drop rather than loop:
 *   - CONFLICT / BAD_REQUEST / NOT_FOUND — bad or superseded input.
 *   - PRECONDITION_FAILED — the run was finished/cancelled (runFrozen);
 *     a queued purchase can never apply. Retrying it forever also
 *     head-of-line-blocks every later queued write — the H3 bug.
 *   - FORBIDDEN — the actor lost permission for this store/action.
 * UNAUTHORIZED is deliberately NOT terminal: authFetch refreshes the token
 * and a later flush (post re-login) can still succeed — dropping a money
 * write just because the 15-minute access token lapsed would be wrong.
 */
export function classifyReplayError(
  code: string | undefined,
  procedure?: string,
  retries = 0,
): ReplayErrorAction {
  if (code !== undefined && procedure !== undefined && overridesByName[procedure]?.has(code)) {
    return retries < MAX_OVERRIDE_RETRIES ? 'retry' : 'drop';
  }
  if (
    code === 'CONFLICT' ||
    code === 'BAD_REQUEST' ||
    code === 'NOT_FOUND' ||
    code === 'PRECONDITION_FAILED' ||
    code === 'FORBIDDEN'
  )
    return 'drop';
  return 'retry';
}

/** Cap on transient retries before an entry is abandoned (mirrors the
 *  server-side outbox worker's MAX_RETRIES). Stops an endlessly-failing
 *  entry from blocking the queue forever. */
export const MAX_REPLAY_RETRIES = 8;

export function shouldGiveUp(retries: number, max: number = MAX_REPLAY_RETRIES): boolean {
  return retries >= max;
}

/** A queued write as a page needs it to show it as pending. */
export type PendingWrite = Pick<OutboxEntry, 'clientSeq' | 'procedure' | 'input' | 'enqueuedAt'>;

/**
 * Same queued writes as before? An entry's clientSeq is unique and its
 * procedure, input and enqueuedAt never change while it is queued (a retry
 * only bumps `retries`), so comparing the clientSeq lists is enough.
 * Used to keep the previous array when the outbox did not change: the
 * backlog timer re-reads the outbox every 15 s, and a new `[]` each time
 * re-rendered every page that overlays pending writes (P-3).
 */
export function samePendingWrites(a: readonly PendingWrite[], b: readonly PendingWrite[]): boolean {
  return a.length === b.length && a.every((e, i) => e.clientSeq === b[i]?.clientSeq);
}
