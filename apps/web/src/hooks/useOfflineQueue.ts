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
export function classifyReplayError(code: string | undefined): ReplayErrorAction {
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

export interface OfflineDropInfo {
  procedure: string;
  /** Why the entry was permanently removed without being applied. */
  reason: 'rejected' | 'gaveup' | 'stale';
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
  enqueue<P>(procedure: string, input: P): Promise<number>;
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
  const flushingRef = useRef(false);
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

  const flush = useCallback(async () => {
    if (flushingRef.current) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) return;
    flushingRef.current = true;
    try {
      const all = (await outbox.list()).sort((a, b) => a.clientSeq - b.clientSeq);
      for (const entry of all) {
        const fn = globalReplay[entry.procedure];
        if (!fn) {
          // No live handler for this procedure. Do NOT delete on sight —
          // that was the C1 data-loss bug. It is almost always a procedure
          // owned by a page that isn't mounted right now; leave it for a
          // later flush. Only discard entries old enough to be from a
          // retired bundle, so a truly orphaned entry can't loop forever.
          if (classifyEntry(false, Date.now() - entry.enqueuedAt) === 'expire') {
            await outbox.remove(entry.clientSeq);
            onDropRef.current?.({ procedure: entry.procedure, reason: 'stale' });
          }
          continue;
        }
        try {
          await fn(entry);
          await outbox.remove(entry.clientSeq);
        } catch (err) {
          const code = (err as { data?: { code?: string } } | undefined)?.data?.code;
          if (classifyReplayError(code) === 'drop') {
            // Server-side rejection — keeping it in the queue won't help.
            await outbox.remove(entry.clientSeq);
            onDropRef.current?.({ procedure: entry.procedure, reason: 'rejected' });
            continue;
          }
          const nextRetries = entry.retries + 1;
          if (shouldGiveUp(nextRetries)) {
            // Transient failures exhausted — abandon this entry so it can't
            // block the queue forever, but surface the loss (H3).
            await outbox.remove(entry.clientSeq);
            onDropRef.current?.({ procedure: entry.procedure, reason: 'gaveup' });
            continue;
          }
          // Likely a transient network issue. Bump retries; leave in queue.
          await outbox.add({ ...entry, retries: nextRetries });
          // Stop the loop on first transient — preserves order on next attempt.
          break;
        }
      }
    } finally {
      flushingRef.current = false;
      await refresh();
    }
  }, [refresh]);

  const enqueue = useCallback(
    async <P,>(procedure: string, input: P): Promise<number> => {
      const clientSeq = await nextSeq();
      await outbox.add({ clientSeq, procedure, input, enqueuedAt: Date.now(), retries: 0 });
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
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    // Try once on mount in case there's backlog from a previous visit.
    void flush();
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [flush, refresh]);

  return { pendingCount, enqueue, flush, online };
}
