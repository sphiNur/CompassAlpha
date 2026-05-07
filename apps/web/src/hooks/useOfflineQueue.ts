/**
 * Offline command replay.
 *
 * Mutations the user fires while offline get appended to an IDB outbox.
 * On `navigator.online` (or initial mount with backlog), we replay them
 * in order. Each entry carries a unique `clientSeq` so the server can
 * idempotency-key on it (M2 work — for now the server just dedupes via
 * its existing `(streamId, seq)` UNIQUE constraint, so duplicate replays
 * are safe but produce CONFLICTs we silently drop).
 *
 * The hook returns:
 *   - `pendingCount`     — how many writes are waiting offline
 *   - `enqueue(proc, input)` — enqueue a write directly (used by host)
 *   - `flush()`          — trigger an immediate replay attempt
 *
 * Pages call `enqueue()` from their mutation onError when the error
 * looks like a network drop. Callers can keep using the regular tRPC
 * mutation; this is an opt-in offline path, not a universal wrapper.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { nextSeq, outbox, type OutboxEntry } from '../lib/idb';

type ReplayFn = (entry: OutboxEntry) => Promise<void>;

interface UseOfflineQueueResult {
  pendingCount: number;
  enqueue<P>(procedure: string, input: P): Promise<number>;
  flush(): Promise<void>;
  online: boolean;
}

/** Pages register a per-procedure replay fn. The hook calls them in order
 *  when flushing the queue. Anything that throws stays in the queue with
 *  retries++ and is tried again on the next online event. */
export function useOfflineQueue(replayMap: Record<string, ReplayFn>): UseOfflineQueueResult {
  const [pendingCount, setPendingCount] = useState(0);
  const [online, setOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  const flushingRef = useRef(false);
  // Keep a stable ref to the latest replayMap so the flush loop doesn't capture stale.
  const replayRef = useRef(replayMap);
  replayRef.current = replayMap;

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
        const fn = replayRef.current[entry.procedure];
        if (!fn) {
          // Unknown procedure — drop so we don't loop on something the
          // current bundle doesn't know how to handle.
          await outbox.remove(entry.clientSeq);
          continue;
        }
        try {
          await fn(entry);
          await outbox.remove(entry.clientSeq);
        } catch (err) {
          const code = (err as { data?: { code?: string } } | undefined)?.data?.code;
          if (code === 'CONFLICT' || code === 'BAD_REQUEST' || code === 'NOT_FOUND') {
            // Server-side rejection — keeping it in the queue won't help.
            await outbox.remove(entry.clientSeq);
            continue;
          }
          // Likely a transient network issue. Bump retries; leave in queue.
          await outbox.add({ ...entry, retries: entry.retries + 1 });
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
