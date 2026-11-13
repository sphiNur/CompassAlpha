/**
 * Which of the day's batches the order page shows, and how it moves
 * between them (review ORD-10, step 2: moved out of OrderPage as it was).
 *
 *  - The default pick is the server's (`order.todaySession`): the open
 *    draft, else the latest rejected batch, else the latest sent one. A
 *    sent one is shown as its receipt.
 *  - "Place another order" (new-batch mode) hides the sent batch and
 *    offers an empty catalog; the first tap lazily creates the draft.
 *  - A batch picked from today's list is shown read-only through its own
 *    query, so the draft's cache and its optimistic edits are untouched.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { focusAfter } from '@compass/ui';
import { trpc } from '../../lib/trpc';
import { useTelegramBackButton } from '../../hooks/useTelegram';
import { isLockedStatus } from './batchStatus';

export function useBatchView(storeId: string | null) {
  const utils = trpc.useUtils();
  /**
   * "I want to start a fresh batch" (2026-07-30).
   *
   * `todaySession` returns the open draft if there is one, else the most
   * recent submitted batch — so once you've submitted, the page has a
   * non-draft session and goes read-only. M3.32 supports several batches
   * per (member, store, day), and the server lazy-creates the next draft
   * on the first AdjustItem, but nothing in the UI ever asked for one.
   *
   * This flag says "ignore the submitted session, show me an empty
   * editable catalog". `startNewBatch` also nulls the cached session so
   * handleQtyChange takes its `if (!old)` path and builds a fresh
   * optimistic draft instead of appending to the submitted one.
   */
  const [newBatch, setNewBatch] = useState(false);
  // 2026-10-21 audit CA-24: mirrors `newBatch` for callbacks (setData
  // updaters) that must not close over a stale render.
  const newBatchRef = useRef(false);
  useEffect(() => {
    newBatchRef.current = newBatch;
  }, [newBatch]);

  // 2026-10-21 audit CA-24: while starting a new batch, any refetch
  // (realtime order.changed, staleTime) still returns the previous
  // SUBMITTED batch until the first tap lazy-creates the new draft.
  // Showing it made the catalog editable on top of the old quantities,
  // so the first + wrote previous+step into the new batch. Hide sent
  // batches in this mode; a draft/rejected session still shows.
  const hideSentWhileNewBatch = useCallback(
    <T extends { status: string } | null>(d: T): T | null =>
      newBatch && d && isLockedStatus(d.status) ? null : d,
    [newBatch],
  );
  const sessionQuery = trpc.order.todaySession.useQuery(
    { storeId: storeId ?? '' },
    { enabled: !!storeId, select: hideSentWhileNewBatch },
  );
  // Every batch this member started today at this store — drives the
  // "今日 N 批" strip and the receipt's batch list.
  const batchesQuery = trpc.order.todayBatches.useQuery(
    { storeId: storeId ?? '' },
    { enabled: !!storeId },
  );
  /**
   * ORD-4 (2026-10-30): a batch picked from today's list. The page's own
   * session stays the default pick (draft > rejected > latest submitted);
   * a picked one is read through its own query, so the draft's cache and
   * its optimistic edits are never touched. Shown read-only.
   */
  const [viewBatchId, setViewBatchId] = useState<string | null>(null);
  const viewQuery = trpc.order.todaySession.useQuery(
    { storeId: storeId ?? '', sessionId: viewBatchId ?? undefined },
    { enabled: !!storeId && !!viewBatchId },
  );
  useEffect(() => {
    setViewBatchId(null);
  }, [storeId]);
  // Switching stores must not carry new-batch mode across — the other
  // store has its own session and its own answer to "am I editing?".
  useEffect(() => {
    setNewBatch(false);
  }, [storeId]);

  /**
   * Leave the receipt and start the next batch. Nulling the cached session
   * is what makes handleQtyChange build a fresh optimistic draft rather
   * than appending to the submitted one; the server lazy-creates the real
   * draft on the first AdjustItem.
   */
  const startNewBatch = useCallback(() => {
    if (!storeId) return;
    setNewBatch(true);
    newBatchRef.current = true;
    utils.order.todaySession.setData({ storeId }, null);
    // DX-IX-4 (2026-11-01): the button goes away with the receipt; start
    // keyboard focus at the top of the new order (the page heading), not
    // in the search field, which would raise the keyboard.
    focusAfter('#main-content h1');
  }, [storeId, utils.order.todaySession]);

  /**
   * DX-ORD-10 (2026-11-01): a way back out of 再下一单. With one batch today
   * the "今日 N 批" button is hidden, so the empty catalog had no exit but
   * switching tabs. Until the first tap creates the new draft, going back
   * shows the receipt again. Telegram's back button does the same, and
   * also closes a batch opened from today's list.
   */
  const canLeaveNewBatch = newBatch && !sessionQuery.data;
  const leaveNewBatch = useCallback(() => {
    setNewBatch(false);
    newBatchRef.current = false;
    if (storeId) void utils.order.todaySession.invalidate({ storeId });
  }, [storeId, utils.order.todaySession]);

  /** The batch picked from today's list, when it is not the page's own. */
  const otherBatch =
    viewBatchId && viewQuery.data && viewQuery.data.id !== sessionQuery.data?.id
      ? viewQuery.data
      : null;
  const closeOtherBatch = useCallback(() => setViewBatchId(null), []);
  useTelegramBackButton(leaveNewBatch, canLeaveNewBatch && !otherBatch);
  useTelegramBackButton(closeOtherBatch, !!otherBatch);

  /** Open a batch from the day's list (the page's own one closes the view). */
  const openBatch = (id: string) => setViewBatchId(id === sessionQuery.data?.id ? null : id);

  /**
   * After a submit: leave new-batch mode — the batch just sent is now the
   * receipt — and stay on it (ORD-4); the default pick would show an older
   * rejected batch instead.
   */
  const showSent = useCallback((sessionId: string) => {
    setNewBatch(false);
    setViewBatchId(sessionId);
  }, []);

  const sessionStatus = sessionQuery.data?.status ?? null;
  return {
    sessionQuery,
    batchesQuery,
    sessionStatus,
    /** While starting a new batch the locked session is not what we're
     *  editing, so nothing is read-only. */
    isReadOnly: isLockedStatus(sessionStatus) && !newBatch,
    newBatchRef,
    startNewBatch,
    canLeaveNewBatch,
    leaveNewBatch,
    otherBatch,
    openBatch,
    closeOtherBatch,
    showSent,
  };
}
