/**
 * The offline outbox: writes kept in IndexedDB and replayed in order when
 * the connection returns.
 *
 * P0 C1 (2026-07-03) — cross-page data loss: flush() used to permanently
 * delete any entry whose procedure the page on screen did not replay, so a
 * purchase queued on the purchase tab was silently destroyed the moment
 * the person switched to the order or receiving tab before connectivity
 * returned (they had already been told "saved offline"). An entry without
 * a handler is never deleted on sight: it is skipped, and discarded only
 * once it is old enough to be from a retired bundle (policy.ts,
 * STALE_TTL_MS).
 *
 * Idempotency (H2): a write queued with the key its first attempt sent
 * (hooks/useOfflineWrite.ts) is replayed with that key
 * (replayHandlers.ts), so a request the server already committed before
 * its answer was lost dedupes instead of applying twice. A write queued
 * without a key is sent with a fresh one, so only writes that are safe to
 * repeat may be queued that way.
 *
 * CMP-FE-3 (2026-10-31): the handlers for every procedure are registered
 * once, at app level, and the flushes run there too
 * (hooks/useOutboxReplay.ts); pages only enqueue and read the queue
 * (hooks/useOfflineQueue.ts). The rules applied here are pure functions
 * in policy.ts.
 *
 * Review COREWEB2-14 (2026-11-11): this was the body of
 * hooks/useOfflineQueue.ts.
 */
import { nextSeq, outbox, type OutboxEntry } from '../idb';
import { useAuthStore } from '../../stores/authStore';
import {
  classifyEntry,
  classifyReplayError,
  countsTowardGiveUp,
  isOwnEntry,
  isRetryDue,
  shouldGiveUp,
  staysQueued,
  trpcErrorCode,
  type OutboxOwner,
  type PendingWrite,
} from './policy';
import type { ReplayedProcedure } from './replayHandlers';

/** Sends one queued entry; rejects with the server's or the network's error. */
export type ReplayFn = (entry: OutboxEntry) => Promise<void>;

/** Who is signed in now, read from the auth store. */
export function currentOwner(): OutboxOwner {
  const session = useAuthStore.getState().session;
  return { userId: session?.user.id, orgId: session?.member.orgId };
}

/** The owner fields every new entry carries. */
function ownerStamp(): Pick<OutboxEntry, 'ownerUserId' | 'ownerOrgId'> {
  const { userId, orgId } = currentOwner();
  return { ownerUserId: userId, ownerOrgId: orgId };
}

/**
 * The replay handler for each procedure. Filled once at app start
 * (hooks/useOutboxReplay.ts) with every procedure a page may queue, so a
 * flush replays a write whichever page queued it. The handlers close over
 * the app-global tRPC client and query cache (`trpc.useUtils`).
 *
 * Review COREWEB2-23: this used to say the handlers were added as pages
 * mounted, from before CMP-FE-3.
 */
const globalReplay: Record<string, ReplayFn> = {};

/**
 * CMP-FE-3 (2026-10-31): the replay handlers are registered once, at app
 * level (hooks/useOutboxReplay.ts), for every procedure any page queues.
 * Before, each page registered its own when it mounted, so after a reload
 * on the order tab a purchase queued offline waited until someone opened
 * the purchase tab. Returns a function that removes them again.
 */
export function registerReplayHandlers(map: Record<string, ReplayFn>): () => void {
  Object.assign(globalReplay, map);
  return () => {
    for (const [procedure, fn] of Object.entries(map)) {
      if (globalReplay[procedure] === fn) delete globalReplay[procedure];
    }
  };
}

/** Is there a replay handler for this procedure? (tests, diagnostics) */
export function hasReplayHandler(procedure: string): boolean {
  return procedure in globalReplay;
}

/** A queued write that was removed without being applied. */
export interface OfflineDropInfo {
  procedure: string;
  /** Why the entry was permanently removed without being applied. */
  reason: 'rejected' | 'gaveup' | 'stale';
  /** For 'rejected': the server's error message (usually an i18n key such
   *  as order.errors.staleOfflineEdit) so the host can say WHY. */
  message?: string;
}

/** Told when a queued write is dropped without being applied (app level). */
let dropHandler: ((info: OfflineDropInfo) => void) | null = null;
export function setOfflineDropHandler(fn: ((info: OfflineDropInfo) => void) | null): void {
  dropHandler = fn;
}

/** Every mounted useOfflineQueue re-reads the outbox when it changes. */
const outboxListeners = new Set<() => void>();
export function notifyOutboxChanged(): void {
  for (const l of outboxListeners) l();
}

/** Be told when the outbox may have changed. Returns the unsubscribe. */
export function subscribeOutbox(listener: () => void): () => void {
  outboxListeners.add(listener);
  return () => {
    outboxListeners.delete(listener);
  };
}

/**
 * One flush at a time for the whole app. Flushes start from several places
 * over the same IndexedDB store (the app-level triggers, every new write,
 * a page that needs the queue drained); a second loop over the same
 * entries would send them twice.
 */
let flushInFlight: Promise<void> | null = null;

/**
 * Write-ahead entries (R2-ORD-5, 2026-10-31) whose request this page
 * lifetime is sending right now. flush() must not send them a second
 * time, and they are not "waiting to sync" — unless the page closes
 * mid-request, when the set is gone and the next start replays them.
 */
const liveSeqs = new Set<number>();

/** After this long without an answer a write shows "saving…". */
export const SLOW_WRITE_MS = 3_000;
let slowWrites = 0;
const slowListeners = new Set<(n: number) => void>();
function setSlowWrites(n: number): void {
  slowWrites = n;
  for (const l of slowListeners) l(n);
}

/** How many writes have waited more than SLOW_WRITE_MS for an answer. */
export function slowWriteCount(): number {
  return slowWrites;
}

/** Be told when that number changes. Returns the unsubscribe. */
export function subscribeSlowWrites(listener: (n: number) => void): () => void {
  slowListeners.add(listener);
  return () => {
    slowListeners.delete(listener);
  };
}

/**
 * Should flush() stop at this entry? A live entry is being sent by its
 * page; replaying it (or anything after it, which would overtake it)
 * would send the same write twice.
 */
export function isLiveEntry(clientSeq: number, live: ReadonlySet<number> = liveSeqs): boolean {
  return live.has(clientSeq);
}

/**
 * The write-ahead send behind `sendQueued` (R2-ORD-5). `settled(queued)`
 * runs once the request is over; `queued` = it failed on the network and
 * its entry stays in the outbox for replay.
 */
export async function sendWriteAhead<P, R>(
  procedure: string,
  input: P,
  send: () => Promise<R>,
  idempotencyKey: string | undefined,
  settled: (queued: boolean) => void,
  store: Pick<typeof outbox, 'add' | 'remove'> & { nextSeq: () => Promise<number> } = {
    add: outbox.add,
    remove: outbox.remove,
    nextSeq,
  },
): Promise<R> {
  let clientSeq: number | null = null;
  try {
    clientSeq = await store.nextSeq();
    await store.add({
      clientSeq,
      procedure,
      input,
      enqueuedAt: Date.now(),
      retries: 0,
      idempotencyKey,
      ...ownerStamp(),
    });
    liveSeqs.add(clientSeq);
  } catch {
    clientSeq = null; // IndexedDB unavailable: send as before, unprotected
  }
  let slow = false;
  const slowTimer = setTimeout(() => {
    slow = true;
    setSlowWrites(slowWrites + 1);
  }, SLOW_WRITE_MS);
  let queued = false;
  try {
    const result = await send();
    if (clientSeq !== null) await store.remove(clientSeq).catch(() => undefined);
    return result;
  } catch (err) {
    if (clientSeq !== null) {
      if (staysQueued(err)) queued = true;
      else await store.remove(clientSeq).catch(() => undefined);
    }
    throw err;
  } finally {
    clearTimeout(slowTimer);
    if (slow) setSlowWrites(Math.max(0, slowWrites - 1));
    if (clientSeq !== null) liveSeqs.delete(clientSeq);
    settled(queued);
  }
}

/**
 * A page's write-ahead send (useOfflineQueue's `sendQueued`): once it is
 * over, the queue is re-read, and a write left queued is tried again as
 * enqueueWrite would.
 */
export function sendQueuedWrite<P, R>(
  procedure: ReplayedProcedure,
  input: P,
  send: () => Promise<R>,
  idempotencyKey?: string,
): Promise<R> {
  return sendWriteAhead(procedure, input, send, idempotencyKey, (queued) => {
    notifyOutboxChanged();
    // Now an ordinary queued write: try it again as enqueue() would.
    if (queued) void flushOutbox();
  });
}

/**
 * Replay the outbox in order, for the signed-in person (CMP-FE-3: one
 * function for the whole app, run by hooks/useOutboxReplay.ts on reconnect
 * and by pages that need the queue drained).
 */
export function flushOutbox(): Promise<void> {
  // A caller that needs the queue drained (Submit) must be able to wait
  // for a flush someone else already started, not return straight away.
  if (flushInFlight) return flushInFlight;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return Promise.resolve();
  const owner = currentOwner();
  if (!owner.userId) return Promise.resolve();
  flushInFlight = (async () => {
    try {
      const all = (await outbox.list()).sort((a, b) => a.clientSeq - b.clientSeq);
      for (const entry of all) {
        const ageMs = Date.now() - entry.enqueuedAt;
        if (!isOwnEntry(entry, owner)) {
          // Queued by someone else on this device, or by this person in
          // another organisation (COREWEB2-03). Never send it under this
          // session, where its ids do not exist and the refusal would
          // delete it; keep it for its own session unless it has gone
          // stale.
          if (classifyEntry(false, ageMs) === 'expire') {
            await outbox.remove(entry.clientSeq);
          }
          continue;
        }
        // Its page is sending it right now (write-ahead): stop, so it is
        // neither sent twice nor overtaken by a later write.
        if (isLiveEntry(entry.clientSeq)) break;
        const fn = globalReplay[entry.procedure];
        if (!fn) {
          // No handler for this procedure. Do NOT delete on sight — that
          // was the C1 data-loss bug. Since CMP-FE-3 every procedure has an
          // app-level handler, so this is an entry from another bundle;
          // leave it for a later flush. Only discard entries old enough to
          // be from a retired bundle, so a truly orphaned entry can't loop
          // forever.
          if (classifyEntry(false, ageMs) === 'expire') {
            await outbox.remove(entry.clientSeq);
            dropHandler?.({ procedure: entry.procedure, reason: 'stale' });
          }
          continue;
        }
        // Still backing off from its last failure: stop here rather than
        // skip ahead, so later writes can't overtake it.
        if (!isRetryDue(entry.retries, entry.lastAttemptAt, Date.now())) break;
        try {
          await fn(entry);
          await outbox.remove(entry.clientSeq);
        } catch (err) {
          const code = trpcErrorCode(err);
          if (classifyReplayError(code, entry.procedure, entry.retries) === 'drop') {
            // Server-side rejection — keeping it in the queue won't help.
            await outbox.remove(entry.clientSeq);
            const message = (err as { message?: unknown } | undefined)?.message;
            dropHandler?.({
              procedure: entry.procedure,
              reason: 'rejected',
              ...(typeof message === 'string' ? { message } : {}),
            });
            continue;
          }
          // No answer, a lapsed session or a server that is down: the entry
          // is not at fault. Leave it untouched and stop, preserving order
          // for next time.
          if (!countsTowardGiveUp(code)) break;
          const nextRetries = entry.retries + 1;
          if (shouldGiveUp(nextRetries)) {
            // Transient failures exhausted — abandon this entry so it can't
            // block the queue forever, but surface the loss (H3).
            await outbox.remove(entry.clientSeq);
            dropHandler?.({ procedure: entry.procedure, reason: 'gaveup' });
            continue;
          }
          await outbox.add({ ...entry, retries: nextRetries, lastAttemptAt: Date.now() });
          // Stop the loop on first transient — preserves order on next attempt.
          break;
        }
      }
    } catch {
      // COREWEB2-04: the outbox itself could not be read or written
      // (IndexedDB unavailable). Nothing to replay now; the next flush
      // tries again. This used to surface as an unhandled rejection on
      // every timer tick.
    } finally {
      flushInFlight = null;
      notifyOutboxChanged();
    }
  })();
  return flushInFlight;
}

/**
 * How often the app tries the outbox again on its own: a server that was
 * unreachable while the browser stayed "online" fires no `online` event,
 * so the backlog used to wait for a remount. The timer runs all the time;
 * with nothing queued a try is one IndexedDB read (review COREWEB2-23:
 * this said it ran only while entries were waiting).
 */
export const BACKLOG_RETRY_MS = 15_000;

/**
 * How many of the signed-in session's writes wait to be sent, not counting
 * the ones being sent right now. Asked before switching organisation:
 * they stay queued for this one (COREWEB2-03). 0 when the outbox cannot be
 * read.
 */
export async function waitingWriteCount(): Promise<number> {
  try {
    const owner = currentOwner();
    const all = await outbox.list();
    return all.filter((e) => !isLiveEntry(e.clientSeq) && isOwnEntry(e, owner)).length;
  } catch {
    return 0;
  }
}

/**
 * The signed-in session's queued writes, oldest first, as a page shows
 * them. Writes being sent right now are not waiting yet (R2-ORD-5).
 * Rejects when the outbox cannot be read.
 */
export async function readPendingWrites(): Promise<PendingWrite[]> {
  const all = await outbox.list();
  const owner = currentOwner();
  return all
    .filter((entry) => !isLiveEntry(entry.clientSeq) && isOwnEntry(entry, owner))
    .sort((a, b) => a.clientSeq - b.clientSeq)
    .map(({ clientSeq, procedure, input, enqueuedAt }) => ({
      clientSeq,
      procedure,
      input,
      enqueuedAt,
    }));
}

/**
 * Put a write in the outbox and try to send it at once (a no-op while
 * offline). Rejects when the device could not store it (IndexedDB
 * unavailable): nothing is queued then (COREWEB2-04). Review TEST3-06
 * (2026-11-10): only a procedure with a replay handler
 * (replayHandlers.ts) may be queued.
 */
export async function enqueueWrite<P>(
  procedure: ReplayedProcedure,
  input: P,
  idempotencyKey?: string,
): Promise<number> {
  const clientSeq = await nextSeq();
  await outbox.add({
    clientSeq,
    procedure,
    input,
    enqueuedAt: Date.now(),
    retries: 0,
    idempotencyKey,
    ...ownerStamp(),
  });
  notifyOutboxChanged();
  void flushOutbox();
  return clientSeq;
}
