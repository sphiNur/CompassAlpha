/**
 * The order page's quantity writes (review ORD-10, step 2: moved out of
 * OrderPage as it was). A tap updates the cached order at once; the write
 * to the server is debounced per product, serialized per store, stored in
 * the outbox before it is sent, and flushed before Submit, on leaving the
 * page and when the WebView is hidden.
 */
import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { milliQty, qtyTotalsBySku } from '@compass/contracts/quantity';
import { trpc } from '../../lib/trpc';
import { haptic } from '../../lib/telegram';
import { staysQueued } from '../../lib/outbox/policy';
import { orgToday } from '../../lib/calendarDate';
import { registerLocalWrites } from '../../lib/localWrites';
import { useErrToast } from '../../hooks/useErrToast';
import type { useOfflineQueue } from '../../hooks/useOfflineQueue';
import { frozenOrderDate } from './orderDate';
import { isLockedStatus } from './batchStatus';

/**
 * Debounce + serialization (see useAdjustQueue). A burst of taps on one
 * product's +/- sends one write, 200 ms after the last.
 */
const DEBOUNCE_MS = 200;

type PendingPayload = { storeId: string; skuId: string; qty: string };

/**
 * Recompute aggregate totals[] from items[]. Used by the optimistic
 * cache writer. Review QTY-01 (2026-11-11): the same exact sum as the
 * server's (contracts), not floats trimmed with toFixed(3).
 */
const recomputeTotals = (
  items: Array<{ skuId: string; qty: string }>,
): Array<{ skuId: string; qty: string }> =>
  [...qtyTotalsBySku(items)].map(([skuId, milli]) => ({ skuId, qty: milliQty(milli) }));

export function useAdjustQueue({
  memberId,
  orgTimeZone,
  newBatchRef,
  sendQueued,
}: {
  /** The signed-in member: a tap edits their own line. */
  memberId: string | undefined;
  /** COREWEB2-21: an order is dated on the org's calendar, not the phone's. */
  orgTimeZone: string | undefined;
  /** CA-24: true while a new batch is being started (useBatchView). */
  newBatchRef: MutableRefObject<boolean>;
  sendQueued: ReturnType<typeof useOfflineQueue>['sendQueued'];
}) {
  const utils = trpc.useUtils();
  const errToast = useErrToast();
  // OPTIMISTIC ADJUST — fire-and-forget pattern.
  //
  // Why no onSettled invalidate? Because invalidate triggers a refetch
  // that races with the next tap. On iOS Telegram WebView, that race
  // produces visible flicker: the optimistic value appears, then the
  // refetch arrives and snaps the qty backwards (because the user has
  // already tapped a 2nd time and the server's snapshot is stale by
  // one tap), then the next mutation completes and snaps forward again.
  //
  // Instead we trust the optimistic cache fully. Reconciliation happens
  // via the debounced WebSocket invalidate (`useRealtime`) which
  // coalesces a burst of mutations into ONE refetch ~400 ms after
  // the user stops tapping — when the cache and server have converged.
  //
  // Flow on each tap:
  //   1. onMutate cancels in-flight refetches, snapshots, writes optimistic.
  //   2. Mutation fires; client UI is already updated.
  //   3. Server processes + emits ws `order.changed`.
  //   4. useRealtime's debounce: schedules invalidate; resets on next tap.
  //   5. After 400 ms quiet, invalidate fires; refetch returns server state
  //      (which by now matches the optimistic cache). No flicker.
  /**
   * Adjust mutation. Layered design — fights the high-latency-to-China
   * race where rapid taps used to cause the qty to "snap backwards":
   *
   * 1. **Optimistic cache write happens on TAP**, not in onMutate.
   *    `handleQtyChange` below updates the cache instantly. The
   *    user always sees their tap reflected with no RTT delay.
   *
   * 2. **Server mutation is debounced 200 ms per (storeId, skuId)**
   *    (DEBOUNCE_MS).
   *    A burst of 5 taps fires ONE mutation, not 5. This avoids the
   *    `(streamId, seq)` UNIQUE collision that previously caused a
   *    cascade of CONFLICT-rollback-snap-backward events.
   *
   * 3. **In-flight serialization per key.** While a mutation for
   *    (storeId, skuId) is in-flight, a second flush waits for it to
   *    settle before firing. No two AdjustItem requests for the same
   *    line are ever in-flight concurrently.
   *
   * 4. **Submit awaits the flush.** When the user hits MainButton,
   *    `flushAllPendingAdjusts()` is called BEFORE submit fires.
   *    Otherwise on slow networks the submit could arrive at the server
   *    before the trailing AdjustItem and the server would see an
   *    empty session → `order.errors.emptyOrder`.
   *
   * 5. **No ctx.prev rollback.** On CONFLICT/error we refetch from the
   *    server. The user's view stays at their latest optimistic until
   *    the refetch arrives, then snaps to truth. Rolling back to a
   *    snapshot from N seconds ago made the qty appear to "change by
   *    itself" — exactly the bug the user reported.
   */
  const adjust = trpc.order.adjustItem.useMutation({
    retry: false,
    onSuccess: (data, vars) => {
      if (!data?.sessionId) return;
      const queryKey = { storeId: vars.storeId };
      utils.order.todaySession.setData(queryKey, (old) => {
        if (!old) return old;
        if (old.id === data.sessionId) return old;
        // CA-24: a refetched SENT batch is not the one we just wrote —
        // don't relabel it with the new draft's id; realtime refetches.
        if (isLockedStatus(old.status)) return old;
        return { ...old, id: data.sessionId };
      });
    },
    onError: (err, vars) => {
      // Keep optimistic: flushOne stored the write in the outbox before
      // sending it (R2-ORD-5), and a network failure leaves it there, as
      // does being signed out (COREWEB2-02).
      if (staysQueued(err)) return;
      // CONFLICT = (streamId, seq) UNIQUE collision. With per-store
      // serialization (see `flushOne`) this can only happen when the
      // same person wrote from another device or tab at once (since
      // 0005 nobody else edits their draft) — NOT a user error.
      // Silently refetch and let the cache reconcile; the user keeps
      // tapping. Showing "could not save change" here was the bug the
      // user reported on rapid clicks across multiple SKUs.
      const code = (err as { data?: { code?: string } }).data?.code;
      if (code === 'CONFLICT') {
        void utils.order.todaySession.invalidate({ storeId: vars.storeId });
        return;
      }
      // Real domain error (FORBIDDEN, BAD_REQUEST, etc.) — surface it.
      // M1.9-extra (2026-05-07): use errToast so server-side i18n keys
      // (e.g. order.errors.cannotDraft) get translated; otherwise fall
      // back to the generic adjust-failed copy.
      errToast('order.toast.adjustFailed')(err);
      void utils.order.todaySession.invalidate({ storeId: vars.storeId });
    },
  });
  /**
   * Debounce + serialization state. Both maps live in refs so they
   * survive re-renders without triggering effects.
   *
   * KEYING (matters — got this wrong before):
   *   - pendingTimers + pendingPayloads: keyed by (storeId, skuId).
   *     Each SKU has its own debounce window, so rapid taps on +/- for
   *     SKU-A get coalesced INDEPENDENTLY of taps for SKU-B.
   *   - inFlight: keyed by storeId ALONE. Every AdjustItem for any SKU
   *     at that store goes to the same event stream: this member's own
   *     draft for the store and day (0005). If we serialize per-SKU
   *     instead of per-store, two concurrent requests for SKU-A and
   *     SKU-B both read the same `seq`, both try to append at seq+1,
   *     and one collides on the (streamId, seq) UNIQUE constraint →
   *     CONFLICT → "could not save change" toast. (The user reported
   *     this on rapid taps across multiple rows.) Per-store keying
   *     guarantees no two AdjustItem requests for the same session
   *     are EVER in-flight concurrently from the same client.
   */
  const pendingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const pendingPayloads = useRef<Map<string, PendingPayload>>(new Map());
  const inFlight = useRef<Map<string, Promise<unknown>>>(new Map());

  /**
   * Fires a single AdjustItem mutation, waiting first for any
   * in-flight mutation for the same STORE (not the same SKU — see
   * the keying rationale above). The promise it returns settles when
   * the mutation succeeds OR fails. The other-items save queues here
   * too (useExtrasSave).
   */
  const serializeOnStore = useCallback(<T>(storeId: string, fn: () => Promise<T>): Promise<T> => {
    const queueKey = storeId;
    const previous = inFlight.current.get(queueKey);
    const ref: { self: Promise<unknown> | null } = { self: null };
    const run = (async () => {
      if (previous) {
        try {
          await previous;
        } catch {
          /* previous failed — irrelevant, just don't block */
        }
      }
      try {
        return await fn();
      } finally {
        if (inFlight.current.get(queueKey) === ref.self) {
          inFlight.current.delete(queueKey);
        }
      }
    })();
    ref.self = run;
    inFlight.current.set(queueKey, run);
    return run;
  }, []);
  /**
   * R2-ORD-5 (2026-10-31): the write goes into the outbox BEFORE it is
   * sent and leaves it on success. A request that hung on a slow network
   * used to be queued only when it finally failed (up to 30 s later), so
   * closing the app meanwhile lost a change the screen showed as made.
   * qty is absolute, so replaying one the server did receive is harmless.
   * CA-25: the queued copy carries the business date frozen NOW, so a
   * replay after midnight can't land in the next day's order.
   */
  // DX-PFE-4 (2026-11-01): the mutation's result object is new on every
  // render, so depending on it re-created flushOne → handleQtyChange each
  // render and every memo'd SkuRow re-rendered on each push. mutateAsync
  // itself is stable.
  const adjustAsync = adjust.mutateAsync;
  const flushOne = useCallback(
    (payload: PendingPayload): Promise<unknown> =>
      serializeOnStore(payload.storeId, () =>
        sendQueued(
          'order.adjustItem',
          {
            ...payload,
            date: frozenOrderDate(
              utils.order.todaySession.getData({ storeId: payload.storeId }),
              orgTimeZone,
            ),
          },
          () => adjustAsync(payload),
        ),
      ),
    [adjustAsync, orgTimeZone, sendQueued, serializeOnStore, utils.order.todaySession],
  );

  /**
   * Force-flush every queued tap RIGHT NOW (don't wait for the
   * 200 ms quiet period). Returns when all flushes have settled.
   * Called before Submit so the server has every tap before deciding
   * whether the order is empty.
   */
  const flushAllPendingAdjusts = useCallback(async (): Promise<void> => {
    const keys = [...pendingPayloads.current.keys()];
    const promises: Promise<unknown>[] = [];
    for (const key of keys) {
      const timer = pendingTimers.current.get(key);
      if (timer) {
        clearTimeout(timer);
        pendingTimers.current.delete(key);
      }
      const payload = pendingPayloads.current.get(key);
      if (!payload) continue;
      pendingPayloads.current.delete(key);
      promises.push(flushOne(payload));
    }
    // Also wait for anything ALREADY in-flight (e.g. fired earlier).
    // After per-store serialization the inFlight map has at most ONE
    // entry per store, but the spread is still correct (and future-
    // proof against multi-store sessions on a single screen).
    promises.push(...inFlight.current.values());
    await Promise.allSettled(promises);
  }, [flushOne]);

  // DX-ORD-1 (2026-11-01): taps waiting out their debounce, or sent and not
  // answered yet, hold realtime's refetch (useRealtime). A refetch that
  // landed among them wrote the server's older value over the last tap,
  // and the next tap built on it: 5 taps stored 4.
  useEffect(
    () => registerLocalWrites(() => pendingPayloads.current.size > 0 || inFlight.current.size > 0),
    [],
  );

  // 2026-10-21 audit CA-25: on unmount (tab switch) and on pagehide
  // (WebView closed / backgrounded) SEND the taps still inside their
  // 200 ms debounce window. This used to only clearTimeout them, so the
  // last tap shown on screen never reached the server. The mutation is
  // owned by the MutationCache, so it completes (and its onError still
  // queues offline) after the component is gone.
  const flushAllRef = useRef(flushAllPendingAdjusts);
  useEffect(() => {
    flushAllRef.current = flushAllPendingAdjusts;
  }, [flushAllPendingAdjusts]);
  useEffect(() => {
    const onPageHide = () => {
      void flushAllRef.current();
    };
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      void flushAllRef.current();
    };
  }, []);

  /**
   * Tap handler. Always update the cache immediately, then schedule
   * the debounced server mutation.
   */
  const handleQtyChange = useCallback(
    (storeId: string, skuId: string, qty: string) => {
      const myMember = memberId ?? '';
      const queryKey = { storeId };
      const nowIso = new Date().toISOString();

      // Light haptic on every tap. Cheap, frequent, matches iOS feel.
      haptic('light');

      // DX-ORD-1: a read already on its way carries the server's value from
      // before this tap; cancelling it (state reverts first) keeps it from
      // landing on top of the tap below.
      void utils.order.todaySession.cancel(queryKey);

      // Step 1: immediate optimistic cache update.
      utils.order.todaySession.setData(queryKey, (old) => {
        // CA-24: in new-batch mode a cached SENT batch is not what we're
        // editing — start a fresh optimistic draft instead of building on it.
        if (!old || (newBatchRef.current && isLockedStatus(old.status))) {
          const items = [
            {
              skuId,
              contributorMemberId: myMember,
              qty,
              note: null,
              updatedByMemberId: myMember,
              updatedAt: nowIso,
            },
          ];
          return {
            id: 'optimistic',
            storeId,
            initiatedByMemberId: myMember,
            submittedByMemberId: null,
            // Review ORD-03 (2026-11-09): today on the calendar
            // frozenOrderDate uses, the org's (COREWEB2-21; it was the
            // phone's). The UTC date was yesterday in Tashkent between
            // 00:00 and 05:00, and once the real id came back it was
            // frozen into queued offline taps.
            orderDate: orgToday(orgTimeZone),
            status: 'draft' as const,
            claimedByMemberId: null,
            claimedByDisplayName: null,
            claimedAt: null,
            submittedAt: null,
            decidedAt: null,
            decidedByMemberId: null,
            decidedByDisplayName: null,
            rejectReason: null,
            runId: null,
            lastSeq: 0,
            notes: null,
            // M3.16-C: new sessions start with no structured extras.
            extras: [],
            totals: recomputeTotals(items),
            items,
          };
        }
        const items = [...old.items];
        const idx = items.findIndex(
          (it) => it.skuId === skuId && it.contributorMemberId === myMember,
        );
        if (idx >= 0) {
          items[idx] = {
            ...items[idx]!,
            qty,
            updatedByMemberId: myMember,
            updatedAt: nowIso,
          };
        } else {
          items.push({
            skuId,
            contributorMemberId: myMember,
            qty,
            note: null,
            updatedByMemberId: myMember,
            updatedAt: nowIso,
          });
        }
        return { ...old, items, totals: recomputeTotals(items) };
      });

      // Step 2: debounce + serialize the server mutation.
      const key = `${storeId}:${skuId}`;
      pendingPayloads.current.set(key, { storeId, skuId, qty });
      const existing = pendingTimers.current.get(key);
      if (existing) clearTimeout(existing);
      const timer = setTimeout(() => {
        pendingTimers.current.delete(key);
        const payload = pendingPayloads.current.get(key);
        if (!payload) return;
        pendingPayloads.current.delete(key);
        // ORD-22 (2026-10-30): the mutation's onError already handled a
        // failure; the bare promise surfaced again as an unhandled rejection.
        flushOne(payload).catch(() => {});
      }, DEBOUNCE_MS);
      pendingTimers.current.set(key, timer);
    },
    [flushOne, orgTimeZone, memberId, utils.order.todaySession, newBatchRef],
  );

  return { handleQtyChange, flushAllPendingAdjusts, serializeOnStore };
}
