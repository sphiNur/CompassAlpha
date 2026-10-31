/**
 * Offline command replay.
 *
 * Mutations the user fires while offline get appended to a single shared
 * IDB outbox. On `navigator.online` (or initial mount with backlog), we
 * replay them in order.
 *
 * P0 C1 (2026-07-03) — cross-page data loss:
 * The outbox is GLOBAL but only one page is mounted at a time (Shell),
 * and each page registered replay handlers for ONLY its own procedures.
 * flush() used to permanently delete any entry whose procedure the
 * *current* page didn't recognise — so a purchase queued on RunPage was
 * silently destroyed the moment the user switched to the Order/Confirm
 * tab before connectivity returned (the user had already been told
 * "saved offline"). We now merge every page's handlers into a
 * module-level registry that SURVIVES page unmounts, flush against that
 * union, and NEVER delete an unrecognised entry on sight — we skip it (a
 * still-unmounted page can replay it on a later flush) and only discard
 * entries old enough to be from a retired bundle (STALE_TTL_MS).
 *
 * KNOWN GAP (H2 follow-up): replayed mutations still mint a fresh
 * idempotency key per attempt (see lib/trpc.ts), so a replay of a request
 * the server already committed (lost-response case) can double-apply.
 * Deriving a stable key from `clientSeq` is tracked separately — do NOT
 * rely on this path being duplicate-safe for money mutations yet.
 *
 * CMP-FE-3 (2026-10-31): the registry is now filled once, at app level,
 * with every procedure (lib/outboxReplay.ts), and the flushes run there
 * too; pages only enqueue and read the queue.
 *
 * The hook returns:
 *   - `pendingCount`     — how many writes are waiting offline
 *   - `pendingEntries`   — those writes (procedure + input), so a page can
 *                          show the queued change on the item it touches
 *   - `enqueue(proc, input)` — enqueue a write directly (used by host)
 *   - `flush()`          — trigger an immediate replay attempt
 *   - `online`           — current connectivity
 */
import { useCallback, useEffect, useState } from 'react';
import { nextSeq, outbox, type OutboxEntry } from '../lib/idb';
import { isLikelyNetworkError } from '../lib/networkError';
import { useAuthStore } from '../stores/authStore';

type ReplayFn = (entry: OutboxEntry) => Promise<void>;

/**
 * Union of every page's replay handlers, keyed by procedure. Populated as
 * pages mount and RETAINED across unmounts so a flush triggered from any
 * page can replay a procedure that a different page enqueued. The handlers
 * close over the app-global tRPC client / query cache (via `trpc.useUtils`),
 * which stay valid after the registering page unmounts.
 */
const globalReplay: Record<string, ReplayFn> = {};

/**
 * CMP-FE-3 (2026-10-31): the replay handlers are registered once, at app
 * level (lib/outboxReplay.ts), for every procedure any page queues. Before,
 * each page registered its own when it mounted, so after a reload on the
 * order tab a purchase queued offline waited until someone opened the
 * purchase tab. Returns a function that removes them again.
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

/** Told when a queued write is dropped without being applied (app level). */
let dropHandler: ((info: OfflineDropInfo) => void) | null = null;
export function setOfflineDropHandler(fn: ((info: OfflineDropInfo) => void) | null): void {
  dropHandler = fn;
}

/** Every mounted useOfflineQueue re-reads the outbox when it changes. */
const outboxListeners = new Set<() => void>();
function notifyOutboxChanged(): void {
  for (const l of outboxListeners) l();
}

/**
 * Only discard an entry whose procedure NO live handler recognises after
 * it has sat this long. Below the threshold we assume the owning page is
 * simply not mounted yet and keep the entry; past it, the procedure was
 * almost certainly removed by a newer bundle and would loop forever.
 */
const STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * One flush at a time for the whole app. Order, Run and Confirm each
 * mount this hook over the SAME IndexedDB store, and a flush started by
 * one page keeps running after that page unmounts; a per-instance guard
 * let the next page start a second loop over the same entries.
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
      ownerUserId: useAuthStore.getState().session?.user.id,
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
      if (isLikelyNetworkError(err)) queued = true;
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
 * Replay the outbox in order, for the signed-in person (CMP-FE-3: one
 * function for the whole app, run by lib/outboxReplay.ts on reconnect and
 * by pages that need the queue drained).
 */
export function flushOutbox(): Promise<void> {
  // A caller that needs the queue drained (Submit) must be able to wait
  // for a flush someone else already started, not return straight away.
  if (flushInFlight) return flushInFlight;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return Promise.resolve();
  const currentUserId = useAuthStore.getState().session?.user.id;
  if (!currentUserId) return Promise.resolve();
  flushInFlight = (async () => {
    try {
      const all = (await outbox.list()).sort((a, b) => a.clientSeq - b.clientSeq);
      for (const entry of all) {
        const ageMs = Date.now() - entry.enqueuedAt;
        if (!isOwnEntry(entry.ownerUserId, currentUserId)) {
          // Queued by someone else on this device. Never send it under
          // this session; keep it for its author unless it has gone stale.
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
          // leave it for a later flush. Only discard entries old enough to be from a
          // retired bundle, so a truly orphaned entry can't loop forever.
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
          const code = (err as { data?: { code?: string } } | undefined)?.data?.code;
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
          // No answer, or a lapsed session: the entry is not at fault.
          // Leave it untouched and stop, preserving order for next time.
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
    } finally {
      flushInFlight = null;
      notifyOutboxChanged();
    }
  })();
  return flushInFlight;
}

/** While the outbox holds entries, how often to try again on our own:
 *  a server that was unreachable while the browser stayed "online" never
 *  fires an `online` event, so the backlog used to wait for a remount. */
const BACKLOG_RETRY_MS = 15_000;

/** Should the signed-in user replay this entry? Unstamped (older) entries
 *  keep their previous behaviour and replay for whoever is signed in. */
export function isOwnEntry(
  ownerUserId: string | undefined,
  currentUserId: string | undefined,
): boolean {
  if (!currentUserId) return false;
  return ownerUserId === undefined || ownerUserId === currentUserId;
}

/**
 * Does this failure say anything about the entry itself? No code means
 * the request never got an answer, and UNAUTHORIZED is about the session.
 * Neither is a reason to move an entry toward being abandoned.
 */
export function countsTowardGiveUp(code: string | undefined): boolean {
  return code !== undefined && code !== 'UNAUTHORIZED';
}

const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

/**
 * Has enough time passed to try a previously failed entry again? Flushes
 * fire on every page mount, so without a wait a few tab switches during
 * a server outage spent the whole retry budget in seconds.
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
 *   - no handler, still fresh          → 'skip'  (owning page not mounted yet)
 *   - no handler, older than TTL       → 'expire' (retired-bundle orphan)
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
/**
 * Per-procedure exceptions to the terminal codes above (2026-10-21 audit
 * CA-25). order.adjustItem / order.setSessionExtras CONFLICT is the
 * (streamId, seq) collision of two writers on the same draft — nothing
 * is wrong with the queued change, and on replay it typically collides
 * with the user's own live taps (or a second tab) landing at the same
 * moment. Dropping it lost a real edit; retry it a couple of times with
 * the usual backoff instead. The cap keeps a genuinely stuck entry from
 * blocking the queue.
 */
export const REPLAY_RETRYABLE_OVERRIDES: Readonly<Record<string, ReadonlySet<string>>> = {
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
export const MAX_OVERRIDE_RETRIES = 2;

export function classifyReplayError(
  code: string | undefined,
  procedure?: string,
  retries = 0,
): ReplayErrorAction {
  if (
    code !== undefined &&
    procedure !== undefined &&
    REPLAY_RETRYABLE_OVERRIDES[procedure]?.has(code)
  ) {
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

/** Device-local calendar date as YYYY-MM-DD. */
export function localDateString(now: Date): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

/**
 * The business date to FREEZE into an offline-queued order write
 * (2026-10-21 audit CA-25). Without it the server resolved "today" at
 * REPLAY time, so a change made offline last night landed in this
 * morning's order. Prefer the date of the session the page is showing
 * (server truth, org timezone); before any session exists fall back to
 * the device's local date (staff devices run in the org's timezone).
 */
export function frozenOrderDate(
  cached: { id: string; orderDate: string } | null | undefined,
  now: Date = new Date(),
): string {
  return cached && cached.id !== 'optimistic' ? cached.orderDate : localDateString(now);
}

/** Cap on transient retries before an entry is abandoned (mirrors the
 *  server-side outbox worker's MAX_RETRIES). Stops an endlessly-failing
 *  entry from blocking the queue forever. */
export const MAX_REPLAY_RETRIES = 8;

export function shouldGiveUp(retries: number, max: number = MAX_REPLAY_RETRIES): boolean {
  return retries >= max;
}

export interface OfflineDropInfo {
  procedure: string;
  /** Why the entry was permanently removed without being applied. */
  reason: 'rejected' | 'gaveup' | 'stale';
  /** For 'rejected': the server's error message (usually an i18n key such
   *  as order.errors.staleOfflineEdit) so the host can say WHY. */
  message?: string;
}

/** A queued write as a page needs it to show it as pending. */
export type PendingWrite = Pick<OutboxEntry, 'clientSeq' | 'procedure' | 'input' | 'enqueuedAt'>;

interface UseOfflineQueueResult {
  pendingCount: number;
  /** A write has been waiting more than SLOW_WRITE_MS for its answer. */
  savingSlow: boolean;
  /**
   * Send a write with its outbox entry stored FIRST (write-ahead,
   * R2-ORD-5). On success the entry is removed; on a network failure it
   * stays queued (the caller must not enqueue again); on a server
   * rejection it is removed and the error rethrown. Closing the page
   * while the request hangs no longer loses the change: the next start
   * replays it — with `idempotencyKey`, or for absolute-value writes
   * like order.adjustItem, without doubling it.
   */
  sendQueued<P, R>(
    procedure: string,
    input: P,
    send: () => Promise<R>,
    idempotencyKey?: string,
  ): Promise<R>;
  /** R2-INT-1 (2026-10-31): the queued writes, oldest first. */
  pendingEntries: readonly PendingWrite[];
  /** `idempotencyKey`: pass the SAME key the first attempt used so the
   *  replay dedupes server-side (H2). Omit for non-idempotent procedures. */
  enqueue<P>(procedure: string, input: P, idempotencyKey?: string): Promise<number>;
  flush(): Promise<void>;
  online: boolean;
}

/**
 * The outbox as a page sees it: how many writes wait, which ones (to show
 * them on their rows), and enqueue / write-ahead send. Replaying is not
 * the page's job any more (CMP-FE-3): lib/outboxReplay.ts registers every
 * procedure's handler and runs the flushes for the whole app, so a write
 * queued on one tab syncs whichever tab is open.
 */
export function useOfflineQueue(): UseOfflineQueueResult {
  const [pendingCount, setPendingCount] = useState(0);
  const [savingSlow, setSavingSlow] = useState(slowWrites > 0);
  const [pendingEntries, setPendingEntries] = useState<readonly PendingWrite[]>([]);
  const [online, setOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );

  const refresh = useCallback(async () => {
    try {
      const all = await outbox.list();
      const userId = useAuthStore.getState().session?.user.id;
      // In-flight write-ahead entries are not "waiting" yet (R2-ORD-5).
      const waiting = all.filter((e) => !isLiveEntry(e.clientSeq));
      setPendingCount(waiting.length);
      setPendingEntries(
        waiting
          .filter((entry) => isOwnEntry(entry.ownerUserId, userId))
          .sort((a, b) => a.clientSeq - b.clientSeq)
          .map(({ clientSeq, procedure, input, enqueuedAt }) => ({
            clientSeq,
            procedure,
            input,
            enqueuedAt,
          })),
      );
    } catch {
      /* IDB unavailable */
    }
  }, []);

  const flush = flushOutbox;

  const enqueue = useCallback(
    async <P,>(procedure: string, input: P, idempotencyKey?: string): Promise<number> => {
      const clientSeq = await nextSeq();
      await outbox.add({
        clientSeq,
        procedure,
        input,
        enqueuedAt: Date.now(),
        retries: 0,
        idempotencyKey,
        ownerUserId: useAuthStore.getState().session?.user.id,
      });
      notifyOutboxChanged();
      // Try immediately if we're online — if we're offline this will no-op.
      void flushOutbox();
      return clientSeq;
    },
    [],
  );

  const sendQueued = useCallback(
    <P, R>(procedure: string, input: P, send: () => Promise<R>, idempotencyKey?: string) =>
      sendWriteAhead(procedure, input, send, idempotencyKey, (queued) => {
        notifyOutboxChanged();
        // Now an ordinary queued write: try it again as enqueue() would.
        if (queued) void flushOutbox();
      }),
    [],
  );

  useEffect(() => {
    const onSlowChange = (n: number) => setSavingSlow(n > 0);
    slowListeners.add(onSlowChange);
    onSlowChange(slowWrites);
    return () => {
      slowListeners.delete(onSlowChange);
    };
  }, []);

  useEffect(() => {
    const onChange = () => void refresh();
    outboxListeners.add(onChange);
    onChange();
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      outboxListeners.delete(onChange);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [refresh]);

  return { pendingCount, pendingEntries, savingSlow, enqueue, sendQueued, flush, online };
}

/**
 * The app-level replay loop (CMP-FE-3), mounted once by lib/outboxReplay.
 * Flushes on start, when the browser comes back online, when the app
 * returns from the background, after sign-in, and every BACKLOG_RETRY_MS
 * (a server that was down while the browser stayed "online" fires no
 * event).
 */
export function useOutboxFlushTriggers(): void {
  useEffect(() => {
    const onOnline = () => void flushOutbox();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void flushOutbox();
    };
    let userId = useAuthStore.getState().session?.user.id;
    const unsubscribe = useAuthStore.subscribe((state) => {
      const next = state.session?.user.id;
      if (next === userId) return;
      userId = next;
      // Signed in (or switched person): their backlog, and what others
      // see as pending, changes.
      notifyOutboxChanged();
      if (next) void flushOutbox();
    });
    const backlogTimer = window.setInterval(() => void flushOutbox(), BACKLOG_RETRY_MS);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    // Backlog from a previous visit.
    void flushOutbox();
    return () => {
      unsubscribe();
      window.clearInterval(backlogTimer);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
}
