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
 * The hook returns:
 *   - `pendingCount`     — how many writes are waiting offline
 *   - `enqueue(proc, input)` — enqueue a write directly (used by host)
 *   - `flush()`          — trigger an immediate replay attempt
 *   - `online`           — current connectivity
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { nextSeq, outbox, type OutboxEntry } from '../lib/idb';
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

interface UseOfflineQueueOptions {
  /**
   * Called when an entry is permanently removed WITHOUT being applied —
   * a terminal server rejection ('rejected'), the retry cap being reached
   * ('gaveup'), or stale-bundle expiry ('stale'). Lets the host surface
   * "a saved change didn't sync" instead of the write vanishing silently
   * after the user was told it was saved. NOT called on successful replay.
   */
  onDrop?: (info: OfflineDropInfo) => void;
}

interface UseOfflineQueueResult {
  pendingCount: number;
  /** `idempotencyKey`: pass the SAME key the first attempt used so the
   *  replay dedupes server-side (H2). Omit for non-idempotent procedures. */
  enqueue<P>(procedure: string, input: P, idempotencyKey?: string): Promise<number>;
  flush(): Promise<void>;
  online: boolean;
}

/** Pages register a per-procedure replay fn. The hook merges them into the
 *  shared registry and calls them in order when flushing. Anything that
 *  throws (transiently) stays in the queue with retries++ for the next
 *  online event, up to MAX_REPLAY_RETRIES. */
export function useOfflineQueue(
  replayMap: Record<string, ReplayFn>,
  options: UseOfflineQueueOptions = {},
): UseOfflineQueueResult {
  const [pendingCount, setPendingCount] = useState(0);
  const [online, setOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  // Keep the latest onDrop in a ref so the stable flush callback always
  // calls the current handler without needing it in its dep list.
  const onDropRef = useRef(options.onDrop);
  onDropRef.current = options.onDrop;

  // Merge this page's handlers into the shared registry, retained across
  // unmounts. Pages pass inline object literals so identity changes every
  // render; Object.assign is idempotent and cheap. (Mirrors the pre-existing
  // pattern of refreshing handler refs during render.)
  Object.assign(globalReplay, replayMap);

  const refresh = useCallback(async () => {
    try {
      setPendingCount(await outbox.size());
    } catch {
      /* IDB unavailable */
    }
  }, []);

  const flush = useCallback((): Promise<void> => {
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
          const fn = globalReplay[entry.procedure];
          if (!fn) {
            // No live handler for this procedure. Do NOT delete on sight —
            // that was the C1 data-loss bug. It is almost always a procedure
            // owned by a page that isn't mounted right now; leave it for a
            // later flush. Only discard entries old enough to be from a
            // retired bundle, so a truly orphaned entry can't loop forever.
            if (classifyEntry(false, ageMs) === 'expire') {
              await outbox.remove(entry.clientSeq);
              onDropRef.current?.({ procedure: entry.procedure, reason: 'stale' });
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
              onDropRef.current?.({
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
              onDropRef.current?.({ procedure: entry.procedure, reason: 'gaveup' });
              continue;
            }
            await outbox.add({ ...entry, retries: nextRetries, lastAttemptAt: Date.now() });
            // Stop the loop on first transient — preserves order on next attempt.
            break;
          }
        }
      } finally {
        flushInFlight = null;
        await refresh();
      }
    })();
    return flushInFlight;
  }, [refresh]);

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
      await refresh();
      // Try immediately if we're online — if we're offline this will no-op.
      void flush();
      return clientSeq;
    },
    [flush, refresh],
  );

  useEffect(() => {
    void refresh();
    const onOnline = () => {
      setOnline(true);
      void flush();
    };
    const onOffline = () => setOnline(false);
    // Back from the background (Telegram minimised) or a server that came
    // back without the browser ever going offline: retry the backlog.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void flush();
    };
    const backlogTimer = window.setInterval(() => void flush(), BACKLOG_RETRY_MS);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);
    // Try once on mount in case there's backlog from a previous visit.
    void flush();
    return () => {
      window.clearInterval(backlogTimer);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [flush, refresh]);

  return { pendingCount, enqueue, flush, online };
}
