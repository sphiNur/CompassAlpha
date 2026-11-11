/**
 * The offline outbox as a page sees it (the outbox itself is
 * lib/outbox/engine.ts). The hook returns:
 *   - `pendingEntries`   — the signed-in person's writes waiting offline
 *                          (procedure + input), so a page can show the
 *                          queued change on the item it touches
 *   - `enqueue(proc, input)` — enqueue a write directly (used by host)
 *   - `sendQueued(…)`    — send a write with its entry stored first
 *   - `flush()`          — trigger an immediate replay attempt
 *   - `savingSlow`       — a write has waited long for its answer
 *   - `online`           — current connectivity
 *
 * Review COREWEB2-14 (2026-11-11): the engine used to live in this file.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  enqueueWrite,
  flushOutbox,
  readPendingWrites,
  sendQueuedWrite,
  slowWriteCount,
  subscribeOutbox,
  subscribeSlowWrites,
} from '../lib/outbox/engine';
import { samePendingWrites, type PendingWrite } from '../lib/outbox/policy';
import type { ReplayedProcedure } from '../lib/outbox/replayHandlers';

interface UseOfflineQueueResult {
  /** A write has been waiting more than SLOW_WRITE_MS for its answer. */
  savingSlow: boolean;
  /**
   * Send a write with its outbox entry stored FIRST (write-ahead,
   * R2-ORD-5). On success the entry is removed; on a failure that
   * `staysQueued` (no answer, or signed out) it stays queued and the
   * error is rethrown (the caller must not enqueue again); on a server
   * rejection it is removed and the error rethrown. Closing the page
   * while the request hangs no longer loses the change: the next start
   * replays it — with `idempotencyKey`, or for absolute-value writes
   * like order.adjustItem, without doubling it.
   */
  sendQueued<P, R>(
    procedure: ReplayedProcedure,
    input: P,
    send: () => Promise<R>,
    idempotencyKey?: string,
  ): Promise<R>;
  /** R2-INT-1 (2026-10-31): the queued writes, oldest first. */
  pendingEntries: readonly PendingWrite[];
  /** `idempotencyKey`: pass the SAME key the first attempt used so the
   *  replay dedupes server-side (H2). Omit for non-idempotent procedures.
   *  Rejects when the device could not store the write (IndexedDB
   *  unavailable): nothing is queued, so tell the person it was not saved
   *  and keep what they typed (COREWEB2-04). */
  enqueue<P>(procedure: ReplayedProcedure, input: P, idempotencyKey?: string): Promise<number>;
  flush(): Promise<void>;
  online: boolean;
}

/**
 * The outbox as a page sees it: how many writes wait, which ones (to show
 * them on their rows), and enqueue / write-ahead send. Replaying is not
 * the page's job any more (CMP-FE-3): hooks/useOutboxReplay.ts registers
 * every procedure's handler and runs the flushes for the whole app, so a
 * write queued on one tab syncs whichever tab is open.
 */
export function useOfflineQueue(): UseOfflineQueueResult {
  const [savingSlow, setSavingSlow] = useState(slowWriteCount() > 0);
  const [pendingEntries, setPendingEntries] = useState<readonly PendingWrite[]>([]);
  const [online, setOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );

  const refresh = useCallback(async () => {
    try {
      const next = await readPendingWrites();
      // Unchanged outbox: keep the old array so nothing re-renders.
      setPendingEntries((prev) => (samePendingWrites(prev, next) ? prev : next));
    } catch {
      /* IDB unavailable */
    }
  }, []);

  useEffect(() => {
    const onSlowChange = (n: number) => setSavingSlow(n > 0);
    const unsubscribe = subscribeSlowWrites(onSlowChange);
    onSlowChange(slowWriteCount());
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeOutbox(() => void refresh());
    void refresh();
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      unsubscribe();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [refresh]);

  return {
    pendingEntries,
    savingSlow,
    enqueue: enqueueWrite,
    sendQueued: sendQueuedWrite,
    flush: flushOutbox,
    online,
  };
}
