import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  Banner,
  Button,
  ChipBar,
  Chip,
  cn,
  DataState,
  EmptyState,
  SearchInput,
  SectionLabel,
  Sheet,
  StickyPageBar,
  useToast,
  focusAfter,
} from '@compass/ui';
import { trpc, newIdempotencyKey } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { usePageMainButton } from '../hooks/usePageMainButton';
import { useTelegramBackButton } from '../hooks/useTelegram';
import { haptic } from '../lib/telegram';
import { staysQueued } from '../lib/outbox/policy';
import { useOfflineQueue } from '../hooks/useOfflineQueue';
import { orgToday } from '../lib/calendarDate';
import { frozenOrderDate } from './order/orderDate';
import { outbox } from '../lib/idb';
import { registerLocalWrites } from '../lib/localWrites';
import { isLikelyNetworkError } from '../lib/networkError';
import { errorTextOf } from '../lib/errorText';
import { sentBatchCount } from './order/batchCount';
import { groupCatalog, orderableSkus } from './order/catalogGroups';
import { PendingSyncNotice } from '../components/PendingSyncNotice';
import { pendingChangeCount } from '../lib/pendingChanges';
import { useQueryClient } from '@tanstack/react-query';
import { refetchFailedQueries } from '../hooks/useRefetchFailedOnReconnect';
import { sessionLoadState } from './order/sessionLoadState';
import { InRunBanner } from './order/InRunBanner';
import type { ExtraLine } from './order/extraRows';
import { useErrToast } from '../hooks/useErrToast';
import { normalizeQuery, rankNameLike } from '../lib/searchMatch';
import {
  useDateFormat,
  useI18n,
  useProductName,
  useProductNameParts,
  useUnitLabel,
} from '../hooks/useI18n';
import { useCurrency } from '../hooks/useCurrency';
import { useAnnounce } from '../hooks/useAnnounce';
import { StoreContextEmpty } from '../components/NoStoreYet';
import { useStoreContext } from '../hooks/useStoreContext';
import { milliQty, qtyTotalsBySku } from '@compass/contracts/quantity';
import { BatchStrip } from './order/BatchStrip';
import { ReceiptList } from './order/ReceiptList';
import { ReviewList } from './order/ReviewList';
import { SessionExtrasEditor } from './order/SessionExtrasEditor';
import { SkuRow } from './order/SkuRow';

/** Statuses where the batch is sent and no longer editable by its owner. */
function isLockedStatus(status: string | null | undefined): boolean {
  return (
    status === 'submitted' ||
    status === 'approved' ||
    status === 'in_run' ||
    status === 'archived'
  );
}

/** Order writes still waiting in the offline outbox for this store (an
 *  entry without a storeId, e.g. extras keyed by session, counts too). */
async function hasQueuedOrderWrites(storeId: string): Promise<boolean> {
  try {
    const entries = await outbox.list();
    return entries.some((entry) => {
      if (!entry.procedure.startsWith('order.')) return false;
      const entryStore = (entry.input as { storeId?: unknown } | null)?.storeId;
      return typeof entryStore !== 'string' || entryStore === storeId;
    });
  } catch {
    return false; // IndexedDB unavailable: nothing can be queued there either
  }
}

export function OrderPage() {
  const i18n = useI18n();
  const productName = useProductName();
  const productNameParts = useProductNameParts();
  // 2026-07-30 (flow review): the Order surface was the ONE place still
  // rendering the raw canonical unit ("kg" / "pcs") while Approval, Run
  // and the extras editor all went through useUnitLabel. Staff saw
  // "0.5 kg" here and "0.5 公斤" on every downstream screen. Memoized by
  // locale, so passing it into the React.memo'd SkuRow is memo-safe.
  const unitLabel = useUnitLabel();
  const dateFmt = useDateFormat();
  const session = useAuthStore((s) => s.session);
  const orgCurrency = useCurrency();
  // COREWEB2-21: an order is dated on the org's calendar, not the phone's.
  const orgTimeZone = session?.member.timezone;
  // Language picker — accessible from every page's header so staff
  // who don't have admin access can still switch languages (added
  // 2026-05-05). State lives at OrderPage level since this is the
  // landing tab; other pages can grow their own copies if needed.
  // OrderPage requires a SPECIFIC store — you can't draft an order
  // without a target. If the global store-switcher is on 'ALL', we
  // refuse and prompt the user to pick (added 2026-05-05).
  // Language picker moved to Telegram's gear button (Shell wires it).
  const storeCtx = useStoreContext();
  const currentStoreId = storeCtx.kind === 'specific' ? storeCtx.storeId : null;
  const toast = useToast();
  const errToast = useErrToast();
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  // 2026-07-30: BatchStrip was written but never rendered, so the
  // "今日 N 批" count in the sticky bar was a dead number -- it told you
  // other batches existed and gave you no way to look at them. Now the
  // count is a button that opens this sheet, and the receipt view renders
  // the same strip inline.
  const [batchesOpen, setBatchesOpen] = useState(false);
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
  // M1.10 (2026-05-08): cross-language SKU search. Lives above the
  // category chip-bar; queries match across uz/ru/en/zh names + code.
  const [searchQuery, setSearchQuery] = useState('');
  // Perf (2026-11-05): the input shows every keystroke at once; the 300-row
  // list filters against this deferred copy, so React can paint the typed
  // character first and redo the list in the next, interruptible render.
  const deferredSearch = useDeferredValue(searchQuery);

  const categoriesQuery = trpc.catalog.categories.useQuery();
  // CAT-7 (2026-10-30): include archived products so lines already ordered,
  // approved or bought still show their name and unit (they showed as an id
  // fragment, or not at all). Pickers filter archived ones out.
  const skusQuery = trpc.catalog.skus.useQuery({ includeArchived: true });
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
    { storeId: currentStoreId ?? '' },
    { enabled: !!currentStoreId, select: hideSentWhileNewBatch },
  );
  // Every batch this member started today at this store — drives the
  // "今日 N 批" strip and the receipt's batch list.
  const batchesQuery = trpc.order.todayBatches.useQuery(
    { storeId: currentStoreId ?? '' },
    { enabled: !!currentStoreId },
  );
  /**
   * ORD-4 (2026-10-30): a batch picked from today's list. The page's own
   * session stays the default pick (draft > rejected > latest submitted);
   * a picked one is read through its own query, so the draft's cache and
   * its optimistic edits are never touched. Shown read-only.
   */
  const [viewBatchId, setViewBatchId] = useState<string | null>(null);
  const viewQuery = trpc.order.todaySession.useQuery(
    { storeId: currentStoreId ?? '', sessionId: viewBatchId ?? undefined },
    { enabled: !!currentStoreId && !!viewBatchId },
  );
  useEffect(() => {
    setViewBatchId(null);
  }, [currentStoreId]);

  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  // The offline outbox. Its replay (and the "did not sync" toast) lives at
  // app level now (CMP-FE-3, hooks/useOutboxReplay.ts).
  const offline = useOfflineQueue();
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
   *    `applyOptimisticQty` below updates the cache instantly. The
   *    user always sees their tap reflected with no RTT delay.
   *
   * 2. **Server mutation is debounced 250 ms per (storeId, skuId).**
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
      // serialization (see `flushOne`) this can only happen when a
      // SECOND staff member at the same store wrote concurrently —
      // legitimate multi-user editing, NOT a user error. Silently
      // refetch and let the cache reconcile; the user keeps tapping.
      // Showing "could not save change" here was the bug the user
      // reported on rapid clicks across multiple SKUs.
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
   *   - inFlight: keyed by storeId ALONE. The server keeps ONE event
   *     stream per (org, store, date) — every AdjustItem for any SKU
   *     at that store hits the same stream. If we serialize per-SKU
   *     instead of per-store, two concurrent requests for SKU-A and
   *     SKU-B both read the same `seq`, both try to append at seq+1,
   *     and one collides on the (streamId, seq) UNIQUE constraint →
   *     CONFLICT → "could not save change" toast. (The user reported
   *     this on rapid taps across multiple rows.) Per-store keying
   *     guarantees no two AdjustItem requests for the same session
   *     are EVER in-flight concurrently from the same client.
   */
  const DEBOUNCE_MS = 200;
  type PendingPayload = { storeId: string; skuId: string; qty: string };
  const pendingTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const pendingPayloads = useRef<Map<string, PendingPayload>>(new Map());
  const inFlight = useRef<Map<string, Promise<unknown>>>(new Map());

  /**
   * Fires a single AdjustItem mutation, waiting first for any
   * in-flight mutation for the same STORE (not the same SKU — see
   * the keying rationale above). The promise it returns settles when
   * the mutation succeeds OR fails.
   */
  const serializeOnStore = useCallback(
    <T,>(storeId: string, fn: () => Promise<T>): Promise<T> => {
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
    },
    [],
  );
  /**
   * R2-ORD-5 (2026-10-31): the write goes into the outbox BEFORE it is
   * sent and leaves it on success. A request that hung on a slow network
   * used to be queued only when it finally failed (up to 30 s later), so
   * closing the app meanwhile lost a change the screen showed as made.
   * qty is absolute, so replaying one the server did receive is harmless.
   * CA-25: the queued copy carries the business date frozen NOW, so a
   * replay after midnight can't land in the next day's order.
   */
  const { sendQueued } = offline;
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
    () =>
      registerLocalWrites(
        () => pendingPayloads.current.size > 0 || inFlight.current.size > 0,
      ),
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
   * Recompute aggregate totals[] from items[]. Used by the optimistic
   * cache writer. Review QTY-01 (2026-11-11): the same exact sum as the
   * server's (contracts), not floats trimmed with toFixed(3).
   */
  const recomputeTotals = (
    items: Array<{ skuId: string; qty: string }>,
  ): Array<{ skuId: string; qty: string }> =>
    [...qtyTotalsBySku(items)].map(([skuId, milli]) => ({ skuId, qty: milliQty(milli) }));

  /**
   * Tap handler. Always update the cache immediately, then schedule
   * the debounced server mutation.
   */
  const handleQtyChange = useCallback(
    (storeId: string, skuId: string, qty: string) => {
      const myMember = session?.member.memberId ?? '';
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
    [flushOne, orgTimeZone, session?.member.memberId, utils.order.todaySession],
  );

  /**
   * Submit mutation with explicit feedback. Earlier the MainButton text
   * just flipped Submitting → Submit-order silently when the request
   * failed (iOS Telegram WebView occasionally drops in-flight POSTs
   * during virtual-keyboard / nav transitions). Now we:
   *   1. Disable retry — the user, not the client, decides when to
   *      try again. Auto-retries hide the failure and confuse state.
   *   2. Toast on success / failure with concrete copy.
   *   3. On network-shaped failure, keep the review sheet open so the
   *      tap target is obvious; on a domain error, close it.
   */
  // 2026-10-21 audit CA-26: one stable X-Idempotency-Key per LOGICAL
  // submit of a given session (sent in the trpc context, as RunPage's
  // writes do through hooks/useOfflineWrite.ts), so a retry after a lost
  // response dedupes server-side instead of minting a fresh key. Scoped
  // to the session id because the server's cache is keyed on (key,
  // route, user) only, not the input.
  const submitIdemCtx = useRef<{ idempotencyKey?: string }>({}).current;
  const submitIdemRef = useRef<{ sessionId: string; key: string } | null>(null);
  /** Guards handleSubmit across its async flush phase (double taps). */
  const submittingRef = useRef(false);
  const submit = trpc.order.submit.useMutation({
    retry: false,
    trpc: { context: submitIdemCtx },
    onSuccess: (_data, vars) => {
      submitIdemRef.current = null;
      void utils.order.todaySession.invalidate();
      void utils.order.todayBatches.invalidate();
      // Leave new-batch mode: the batch we just sent is now the receipt.
      setNewBatch(false);
      // ORD-4: stay on the batch just sent; the default pick would show an
      // older rejected batch instead.
      setViewBatchId(vars.sessionId);
      haptic('success');
      toast.success(i18n.t('order.toast.submitted'));
    },
    onError: (err) => {
      haptic('error');
      if (isLikelyNetworkError(err)) {
        // Keep submitIdemRef: the retry is the same logical submit.
        toast.error(i18n.t('order.toast.submitFailedNetwork'));
      } else {
        submitIdemRef.current = null;
        // M1.9-extra (2026-05-07): was interpolating raw err.message
        // into the toast text via {reason}, leaking i18n keys like
        // `order.errors.cannotSubmit` to the user. errToast translates
        // domain keys; falls back to a generic "could not submit"
        // toast for unrecognized error shapes.
        errToast('order.toast.submitFailed')(err);
      }
    },
  });
  const withdraw = trpc.order.withdraw.useMutation({
    onSuccess: () => {
      // The withdrawn batch is a draft again — the default view.
      setViewBatchId(null);
      // CA-26: the withdrawn session will be re-submitted as a new
      // logical submit — never reuse the previous attempt's key.
      submitIdemRef.current = null;
      void utils.order.todaySession.invalidate();
      void utils.order.todayBatches.invalidate();
    },
    // 2026-10-21 audit B-23: a failed withdraw (e.g. claimed meanwhile —
    // order.errors.cannotWithdrawWhileClaimed) used to just stop the
    // spinner. Surface it, and refetch so the banner reflects reality.
    onError: (err) => {
      errToast('common.errors.actionFailed')(err);
      void utils.order.todaySession.invalidate();
    },
  });

  /**
   * Leave the receipt and start the next batch. Nulling the cached session
   * is what makes handleQtyChange build a fresh optimistic draft rather
   * than appending to the submitted one; the server lazy-creates the real
   * draft on the first AdjustItem.
   */
  const startNewBatch = useCallback(() => {
    if (!currentStoreId) return;
    setNewBatch(true);
    newBatchRef.current = true;
    utils.order.todaySession.setData({ storeId: currentStoreId }, null);
    // DX-IX-4 (2026-11-01): the button goes away with the receipt; start
    // keyboard focus at the top of the new order (the page heading), not
    // in the search field, which would raise the keyboard.
    focusAfter('#main-content h1');
  }, [currentStoreId, utils.order.todaySession]);

  // Switching stores must not carry new-batch mode across — the other
  // store has its own session and its own answer to "am I editing?".
  useEffect(() => {
    setNewBatch(false);
  }, [currentStoreId]);

  /**
   * Session-level "其他物品" structured extras (M3.16-C, 2026-05-16).
   * Successor to setSessionNote — sends the WHOLE updated list every
   * time. ExtrasEditor below does the local accumulation; this just
   * persists the snapshot.
   */
  const setSessionExtras = trpc.order.setSessionExtras.useMutation({
    retry: false,
    onError: (err) => {
      // 2026-10-21 audit CA-25/CA-27: same offline story as adjustItem —
      // the save stored it in the outbox before sending (R2-ORD-5).
      if (isLikelyNetworkError(err)) return;
      const code = (err as { data?: { code?: string } }).data?.code;
      if (code === 'CONFLICT') {
        if (currentStoreId) {
          void utils.order.todaySession.invalidate({ storeId: currentStoreId });
        }
        return;
      }
      errToast('order.toast.extrasSaveFailed')(err);
    },
  });

  const allSkus = useMemo(() => skusQuery.data ?? [], [skusQuery.data]);

  const items = useMemo(() => sessionQuery.data?.items ?? [], [sessionQuery.data]);
  const totals = useMemo(() => sessionQuery.data?.totals ?? [], [sessionQuery.data]);
  const myMemberId = session?.member.memberId ?? null;

  /** Aggregate qty per SKU (sum across all contributors). For the header. */
  const totalQtyBySku = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of totals) m.set(t.skuId, Number(t.qty));
    return m;
  }, [totals]);

  /** MY contribution per SKU. The +/- always edits this row. */
  const myQtyBySku = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of items) {
      if (it.contributorMemberId === myMemberId) m.set(it.skuId, Number(it.qty));
    }
    return m;
  }, [items, myMemberId]);

  // The catalogue offers active products, plus (DX-ORD-16) archived ones
  // still in my draft, so the line can be seen and taken out.
  const skus = useMemo(() => orderableSkus(allSkus, myQtyBySku), [allSkus, myQtyBySku]);
  const filteredSkus = useMemo(() => {
    // Two filters compose: category chip + cross-language search.
    // Apply category first (cheap object-key compare) then search
    // (string match across 4 lang fields + code) so we walk the
    // smaller set on the second pass.
    let out = activeCategory ? skus.filter((s) => s.categoryId === activeCategory) : skus;
    // Ranked: best match first, the reader's language breaking ties, typo
    // matches only when nothing matched literally (lib/searchMatch).
    out = rankNameLike(
      out,
      normalizeQuery(deferredSearch),
      (s) => ({ names: s.names, code: s.code }),
      i18n.locale,
    );
    return out;
  }, [skus, activeCategory, deferredSearch, i18n.locale]);
  // A11Y-12 (2026-10-31): say how many products the search / category
  // leaves, once typing settles; the list used to change in silence.
  useAnnounce(
    skusQuery.data && (deferredSearch.trim() || activeCategory)
      ? filteredSkus.length === 0
        ? i18n.t('order.search.noMatches.title')
        : i18n.t('a11y.results.products', { n: filteredSkus.length })
      : null,
  );
  // DX-ORD-6 (2026-11-01): grouped by category in the admin's order.
  const catalogGroups = useMemo(
    () =>
      // While searching, one list in relevance order — category groups would
      // scatter the best match below whole groups of weaker ones.
      // Archived lines still in the draft keep their "No longer sold" group.
      deferredSearch.trim()
        ? [
            {
              key: 'search-archived',
              categoryId: null,
              archived: true,
              skus: filteredSkus.filter((s) => s.isArchived),
            },
            { key: 'search', categoryId: null, archived: false, skus: filteredSkus.filter((s) => !s.isArchived) },
          ].filter((g) => g.skus.length > 0)
        : groupCatalog(filteredSkus, categoriesQuery.data ?? [], { archivedFirst: true }),
    [filteredSkus, categoriesQuery.data, deferredSearch],
  );
  const categoryNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categoriesQuery.data ?? []) {
      m.set(c.id, productName({ names: c.names }));
    }
    return m;
  }, [categoriesQuery.data, productName]);

  /** All non-zero contributor rows per SKU — for the "added by N people" hint. */
  const contributorsBySku = useMemo(() => {
    const m = new Map<string, Array<{ memberId: string; qty: string }>>();
    for (const it of items) {
      if (Number(it.qty) <= 0) continue;
      const arr = m.get(it.skuId) ?? [];
      arr.push({ memberId: it.contributorMemberId, qty: it.qty });
      m.set(it.skuId, arr);
    }
    return m;
  }, [items]);

  // Distinct SKUs with non-zero aggregate qty, plus saved extras rows —
  // 2026-10-21 audit CA-27: the domain accepts an extras-only submit
  // (M3.33), but zeroing the last SKU used to hide Submit even with
  // extras on the session.
  const extrasCount = sessionQuery.data?.extras?.length ?? 0;
  const selectedCount = totals.length + extrasCount;

  const sessionStatus = sessionQuery.data?.status ?? null;
  const sessionLocked = isLockedStatus(sessionStatus);
  // While starting a new batch the locked session is not what we're
  // editing, so nothing is read-only.
  const isReadOnly = sessionLocked && !newBatch;

  // 2026-10-21 audit CA-27: the extras editor no longer waits for a SKU
  // tap to create the session. With no session yet it saves by
  // {storeId, date} and the server lazy-creates the draft; the editor
  // then adopts the real id without dropping the rows on screen.
  const extrasSessionId =
    sessionQuery.data && sessionQuery.data.id !== 'optimistic' ? sessionQuery.data.id : null;
  const showExtrasEditor =
    !!currentStoreId && (extrasSessionId !== null || (!isReadOnly && sessionQuery.isSuccess));
  const saveExtras = useCallback(
    async (extras: ExtraLine[]): Promise<void> => {
      if (!currentStoreId) return;
      const storeId = currentStoreId;
      // Same per-store queue as AdjustItem taps: the first tap and the
      // first extras save must not BOTH lazy-create a draft.
      await serializeOnStore(storeId, async () => {
        // Read the cache at fire time — the render that scheduled this
        // save may predate the lazily-created draft. Only a draft or
        // rejected session is editable here (in new-batch mode the raw
        // cache can still hold the previous SENT batch).
        const cached = utils.order.todaySession.getData({ storeId });
        const knownId =
          cached && cached.id !== 'optimistic' && !isLockedStatus(cached.status)
            ? cached.id
            : undefined;
        // No editable session: address it by store. Pin the date only
        // when the page shows a real session (server truth); otherwise
        // the server uses today and onError freezes one if it queues.
        const input = knownId
          ? { sessionId: knownId, extras }
          : {
              storeId,
              extras,
              ...(cached && cached.id !== 'optimistic' ? { date: cached.orderDate } : {}),
            };
        // The queued copy freezes the business date (CA-25) when the input
        // addresses the session by store without one.
        const queuedInput =
          'storeId' in input && !input.date
            ? { ...input, date: frozenOrderDate(cached, orgTimeZone) }
            : input;
        let res: { sessionId: string | null } | undefined;
        try {
          res = await sendQueued('order.setSessionExtras', queuedInput, () =>
            setSessionExtras.mutateAsync(input),
          );
        } catch (err) {
          // Left in the outbox (network failure, signed out): keep the
          // rows as saved locally.
          if (!staysQueued(err)) throw err;
        }
        const newId = res?.sessionId ?? null;
        // Optimistic cache write so the editor doesn't flicker on the
        // next refetch; adopt the lazily-created id over 'optimistic'.
        utils.order.todaySession.setData({ storeId }, (old) => {
          if (!old || isLockedStatus(old.status)) return old;
          return { ...old, extras, ...(newId && !knownId ? { id: newId } : {}) };
        });
        if (newId && !knownId) {
          void utils.order.todaySession.invalidate({ storeId });
          void utils.order.todayBatches.invalidate({ storeId });
        }
      });
    },
    [currentStoreId, orgTimeZone, sendQueued, serializeOnStore, setSessionExtras, utils.order],
  );

  // Telegram MainButton — single point of control for the entire submit
  // flow. State machine:
  //   - sheet closed + items selected → "Review Order (3)"     → opens sheet
  //   - sheet open + not pending      → "Submit order"          → fires submit
  //   - sheet open + pending          → "Submitting…"  (disabled)
  // No buttons inside the sheet body — the MainButton IS the action.
  // The sheet handles its own dismissal via tap-outside / swipe-down.
  const canSubmit =
    sessionStatus === 'draft' || sessionStatus === 'rejected';
  // 2026-10-21 FE-01: todaySession failed with nothing cached — we do not
  // know whether this member already submitted, so no catalog, no submit.
  const sessionLoad = sessionLoadState({
    isError: sessionQuery.isError,
    hasData: sessionQuery.data !== undefined,
    isNetworkError: isLikelyNetworkError(sessionQuery.error),
    waitingOffline: sessionQuery.fetchStatus === 'paused',
  });
  const sessionBlocked = sessionLoad === 'blocked';

  let mainButtonText: string;
  if (submit.isPending) {
    mainButtonText = i18n.t('order.action.submitting');
  } else if (reviewOpen) {
    mainButtonText = i18n.t('order.action.submitOrder');
  } else {
    mainButtonText = i18n.t('order.review', { n: selectedCount });
  }

  /**
   * Submit-with-id-resolution flow, used by both the Telegram
   * MainButton and the non-Telegram fallback footer button. Steps:
   *
   *   1. Flush every pending / in-flight AdjustItem so the server
   *      has every line before we ask it to submit.
   *   2. Read the session id from the cache. If it's still
   *      'optimistic' (because an adjust hit a CONFLICT or the user
   *      submitted the very first tap at the same instant), force a
   *      refetch and read again. The server is the authoritative
   *      source of the real id once the first AdjustItem landed
   *      (server lazy-creates the session).
   *   3. If after the refetch we STILL don't have a real id, tell
   *      the user to try again — at this point the network is genuinely
   *      losing requests.
   *
   * Earlier the failure mode here was: any CONFLICT during the burst
   * of taps left the cache stuck on id='optimistic' and Submit would
   * print "syncing — try submit in a moment" and just sit there. The
   * refetch step resolves that without user intervention.
   */
  const handleSubmit = useCallback(async () => {
    if (!canSubmit || selectedCount === 0 || submit.isPending) return;
    if (!currentStoreId) return;
    // CA-26: `submit.isPending` is false during the flush/refetch below,
    // so a second tap used to start a second submit. Ref-lock the whole
    // logical submit instead.
    if (submittingRef.current) return;
    // DX-ORD-5 (2026-11-01): offline, say that submitting needs a network.
    // It used to fall through to the outbox check and say "still syncing,
    // tap again in a moment", and people kept waiting.
    if (!offline.online) {
      toast.info(i18n.t('order.review.needsNetwork'));
      return;
    }
    submittingRef.current = true;
    const storeId = currentStoreId;
    try {
      await flushAllPendingAdjusts();
      // Changes queued offline must reach the server before the batch is
      // submitted: the review showed them, but Submit sent the server's
      // copy without them, and their later replay lazily opened a new
      // draft. Drain the outbox; if this store still has queued order
      // writes (offline, or the server refused to answer), don't submit.
      await offline.flush();
      if (await hasQueuedOrderWrites(storeId)) {
        toast.info(
          i18n.t(navigator.onLine ? 'order.toast.syncing' : 'order.review.needsNetwork'),
        );
        return;
      }

      // Only a draft/rejected session is submittable. CA-24: in new-batch
      // mode the raw cache can still hold the previous SENT batch — never
      // submit that id (the domain would no-op it as a repeat Submit).
      const submittableId = (
        d: { id: string; status: string } | null | undefined,
      ): string | undefined =>
        d && d.id !== 'optimistic' && !isLockedStatus(d.status) ? d.id : undefined;
      let sid = submittableId(utils.order.todaySession.getData({ storeId }));
      if (!sid) {
        try {
          sid = submittableId(await utils.order.todaySession.fetch({ storeId }));
        } catch {
          /* network fail — fall through to syncing toast */
        }
      }

      if (!sid) {
        toast.info(i18n.t('order.toast.syncing'));
        return;
      }
      if (submitIdemRef.current?.sessionId !== sid) {
        submitIdemRef.current = { sessionId: sid, key: newIdempotencyKey() };
      }
      submitIdemCtx.idempotencyKey = submitIdemRef.current.key;
      try {
        await submit.mutateAsync({ sessionId: sid });
        setReviewOpen(false);
      } catch {
        /* surfaced by the mutation's onError */
      }
    } finally {
      submittingRef.current = false;
    }
  }, [
    canSubmit,
    selectedCount,
    submit,
    submitIdemCtx,
    currentStoreId,
    flushAllPendingAdjusts,
    offline,
    utils.order.todaySession,
    toast,
    i18n,
  ]);

  const viewingOtherBatch =
    !!viewBatchId && !!viewQuery.data && viewQuery.data.id !== sessionQuery.data?.id;
  usePageMainButton(
    mainButtonText,
    () => {
      if (!canSubmit || selectedCount === 0 || submit.isPending || viewingOtherBatch) return;
      if (reviewOpen) {
        if (!sessionQuery.data) return;
        void handleSubmit();
      } else {
        setReviewOpen(true);
      }
    },
    {
      // RE-ORD-1 (2026-10-30): while another batch is shown read-only the
      // button would still act on the current draft — tapping it submitted
      // a batch the user was not looking at. No main button there.
      visible: canSubmit && selectedCount > 0 && !sessionBlocked && !viewingOtherBatch,
      active:
        selectedCount > 0 &&
        !submit.isPending &&
        !sessionBlocked &&
        !(reviewOpen && !offline.online),
    },
  );

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
    if (currentStoreId) void utils.order.todaySession.invalidate({ storeId: currentStoreId });
  }, [currentStoreId, utils.order.todaySession]);
  useTelegramBackButton(leaveNewBatch, canLeaveNewBatch && !viewingOtherBatch);
  useTelegramBackButton(() => setViewBatchId(null), viewingOtherBatch);

  if (!session) return null;
  // An order is one store's: no store, or all of them, says why.
  if (!currentStoreId) return <StoreContextEmpty />;

  if (sessionLoad === 'offline') {
    return (
      <div className="flex flex-col px-4 pt-3">
        <EmptyState title={i18n.t('common.offlineNoData')} />
      </div>
    );
  }

  // 2026-10-21 FE-01: an errored todaySession used to fall through to an
  // empty, editable catalog (first tap lazily creates a NEW draft), so a
  // member who already submitted could order twice. Block until it loads.
  if (sessionBlocked) {
    return (
      <div className="flex flex-col px-4 pt-3">
        <Banner
          tone="danger"
          title={i18n.t('common.error')}
          action={
            <Button
              size="sm"
              variant="pearl"
              loading={sessionQuery.isFetching}
              onClick={() => void refetchFailedQueries(queryClient)}
            >
              {i18n.t('common.retry')}
            </Button>
          }
        >
          {/* RE-AUTH-5 (2026-10-30): showed the raw transport text, e.g.
              "Failed to fetch (session refresh did not complete)". */}
          {(() => {
            const said = errorTextOf(sessionQuery.error, 'common.errorUnknown');
            return i18n.t(said.key, said.vars);
          })()}
        </Banner>
      </div>
    );
  }
  // Background refetch failed but cached data is still good: keep the page
  // working and say so quietly.
  const staleWarning =
    sessionLoad === 'staleWarning' ? (
      <div className="px-4 pt-2">
        <Banner
          tone="warn"
          title={i18n.t('common.error')}
          action={
            <Button
              size="sm"
              variant="pearl"
              loading={sessionQuery.isFetching}
              onClick={() => void refetchFailedQueries(queryClient)}
            >
              {i18n.t('common.retry')}
            </Button>
          }
        />
      </div>
    ) : null;

  // 2026-07-30 (flow review): was `toLocaleDateString(undefined, …)`, i.e.
  // the BROWSER's locale, so the review sheet's subtitle read
  // "Thursday, July 30" above a Chinese item list.
  const dateLabel = dateFmt.weekdayLong(new Date());

  /**
   * SUBMITTED-BATCH RECEIPT (2026-07-30).
   *
   * Before this, submitting left you on the same 244-row catalog with every
   * row disabled — ~12,000 px of greyed-out list — and the review sheet's
   * only entry point was the main button, which hides itself once
   * `canSubmit` goes false. So after pressing Submit there was literally no
   * way to see what you had just sent.
   *
   * The catalog is a tool for *choosing*; once the choice is made it's
   * noise. This replaces it with the receipt: what you sent, what it's
   * worth, where it is in the pipeline, and the two things you might now
   * want — take it back, or start another batch.
   *
   * `ReviewList` is reused deliberately: the pre-submit preview and the
   * post-submit receipt should be the same object, so nothing looks like it
   * changed in transit.
   */
  /** Open a batch from the day's list (the default one closes the view). */
  const selectBatch = (id: string) => {
    setBatchesOpen(false);
    setViewBatchId(id === sessionQuery.data?.id ? null : id);
  };
  /** DX-ORD-3: the reviewer's reason, then who rejected it and when. */
  const rejectionBody = (b: {
    rejectReason: string | null;
    decidedAt: string | null;
    decidedByDisplayName?: string | null;
  }) => {
    const who = b.decidedByDisplayName || i18n.t('approval.unknownReviewer');
    return (
      <>
        <p className="whitespace-pre-line">
          {b.rejectReason || i18n.t('order.status.rejectedNoReason')}
        </p>
        {b.decidedAt ? (
          <p className="mt-1 text-old-label text-[var(--c-fg-muted)]">
            {i18n.t('order.status.rejectedBy', { who, time: dateFmt.time(b.decidedAt) })}
          </p>
        ) : null}
      </>
    );
  };
  /** ORD-4: a batch sent back by a reviewer, said on every view. */
  const rejectedNotice = (shownId: string | undefined) => {
    const b = (batchesQuery.data ?? []).find((x) => x.status === 'rejected' && x.id !== shownId);
    if (!b) return null;
    return (
      <Banner
        tone="warn"
        title={i18n.t('order.batches.rejectedTitle', { n: b.batchNumber })}
        action={
          <Button size="sm" variant="pearl" onClick={() => selectBatch(b.id)}>
            {i18n.t('order.batches.open')}
          </Button>
        }
      >
        {b.rejectReason || i18n.t('order.status.rejectedNoReason')}
      </Banner>
    );
  };

  if (viewBatchId && viewQuery.data && viewQuery.data.id !== sessionQuery.data?.id) {
    const v = viewQuery.data;
    const vClaimedByOther =
      !!v.claimedByMemberId && v.claimedByMemberId !== session.member.memberId;
    return (
      <div className="flex flex-col pb-4">
        {/* min-h-12 py-1 (RE-VIS-3 / R2-VIS-2, 2026-10-31): the strip is
            taller than the back button's 44px tap area plus its 1px border.
            In the default 30px strip the area stuck out of the top edge,
            under the header. */}
        <StickyPageBar className="min-h-12 py-1">
          <button
            type="button"
            className="hit-44 text-old-label font-semibold text-[var(--c-action)]"
            onClick={() => setViewBatchId(null)}
          >
            ‹ {i18n.t('order.batches.backToCurrent')}
          </button>
          <span className="ml-auto shrink-0 text-old-label tabular-nums text-[var(--c-fg-muted)]">
            {dateLabel}
          </span>
        </StickyPageBar>
        <div className="flex flex-col gap-3 px-4 pt-3">
          <BatchStrip
            batches={batchesQuery.data ?? []}
            currentId={v.id}
            i18n={i18n}
            currency={orgCurrency}
            onSelect={selectBatch}
          />
          {rejectedNotice(v.id)}
          {v.status === 'rejected' ? (
            <Banner tone="warn" title={i18n.t('order.status.rejectedTitle')}>
              {rejectionBody(v)}
              <p className="mt-1">{i18n.t('order.batches.rejectedFinishDraft')}</p>
            </Banner>
          ) : v.status === 'submitted' ? (
            <Banner
              tone="info"
              title={i18n.t('order.status.submitted')}
              action={
                !vClaimedByOther ? (
                  <Button
                    size="sm"
                    variant="pearl"
                    loading={withdraw.isPending}
                    onClick={() => withdraw.mutate({ sessionId: v.id })}
                  >
                    {i18n.t('order.withdraw')}
                  </Button>
                ) : undefined
              }
            />
          ) : v.status === 'approved' ? (
            <Banner tone="success" title={i18n.t('order.banner.approved.title')} />
          ) : v.status === 'in_run' && currentStoreId ? (
            <InRunBanner runId={v.runId} storeId={currentStoreId} showBody={false} />
          ) : (
            <Banner tone="info" title={i18n.t('order.status.archived')} />
          )}
          {(v.totals ?? []).length > 0 || (v.extras ?? []).length === 0 ? (
            <div>
              <SectionLabel padded={false} className="mb-1.5">
                {i18n.t('order.receipt.submittedItems')}
              </SectionLabel>
              <ReceiptList
                sessionId={v.id}
                status={v.status}
                totals={v.totals ?? []}
                extras={v.extras ?? []}
                skus={allSkus}
                categories={categoriesQuery.data ?? []}
                productName={productName}
              />
            </div>
          ) : null}
        </div>
        {/* CMP-ORD-2 (2026-10-31): a batch opened from today's list left its
            extras out, so they looked lost. Read-only, like the current
            batch's receipt below. `key` gives each batch its own editor. */}
        <SessionExtrasEditor
          key={v.id}
          sessionId={v.id}
          storeId={currentStoreId}
          initialValue={v.extras ?? []}
          isReadOnly
          onSave={async () => {
            /* read-only — never called */
          }}
        />
      </div>
    );
  }

  if (isReadOnly && sessionQuery.data) {
    const locked = sessionQuery.data;
    const claimedByOther =
      !!locked.claimedByMemberId && locked.claimedByMemberId !== session.member.memberId;
    // Withdraw is only offered while nobody has picked the batch up. The
    // server enforces the same rule; hiding it avoids a tap-then-403.
    const canWithdraw = sessionStatus === 'submitted' && !claimedByOther;
    return (
      <div className="flex flex-col pb-4">
        <StickyPageBar>
          {/* Store moved to Shell's top strip (2026-07-30) — the date is
              the only page-specific thing this strip carried. */}
          <span className="ml-auto shrink-0 text-old-label tabular-nums text-[var(--c-fg-muted)]">
            {dateLabel}
          </span>
        </StickyPageBar>
        {staleWarning}

        <div className="flex flex-col gap-3 px-4 pt-3">
          <BatchStrip
            batches={batchesQuery.data ?? []}
            currentId={locked.id}
            i18n={i18n}
            currency={orgCurrency}
            onSelect={selectBatch}
          />
          {rejectedNotice(locked.id)}
          {claimedByOther ? (
            <Banner
              tone="warn"
              title={i18n.t('order.banner.claimed', {
                who: locked.claimedByDisplayName ?? i18n.t('approval.unknownReviewer'),
              })}
            />
          ) : sessionStatus === 'submitted' ? (
            <Banner
              tone="info"
              title={i18n.t('order.status.submitted')}
              action={
                canWithdraw ? (
                  <Button
                    size="sm"
                    variant="pearl"
                    loading={withdraw.isPending}
                    onClick={() => withdraw.mutate({ sessionId: locked.id })}
                  >
                    {i18n.t('order.withdraw')}
                  </Button>
                ) : undefined
              }
            />
          ) : sessionStatus === 'approved' ? (
            <Banner tone="success" title={i18n.t('order.banner.approved.title')}>
              {i18n.t('order.banner.approved.body')}
            </Banner>
          ) : sessionStatus === 'in_run' && currentStoreId ? (
            <InRunBanner runId={locked.runId} storeId={currentStoreId} />
          ) : (
            <Banner tone="info" title={i18n.t('order.status.archived')} />
          )}

          {/* 2026-10-21 audit CA-44: a second identical BatchStrip used to
              render here; the one above the banner is the only copy. */}

          {/* ORD-13 (2026-10-30): an extras-only batch said "nothing chosen
              yet"; its extras are listed below. */}
          {totals.length > 0 || extrasCount === 0 ? (
            <div>
              <SectionLabel padded={false} className="mb-1.5">
                {i18n.t('order.receipt.submittedItems')}
              </SectionLabel>
              <ReceiptList
                sessionId={locked.id}
                status={locked.status}
                totals={totals}
                extras={locked.extras ?? []}
                skus={allSkus}
                categories={categoriesQuery.data ?? []}
                productName={productName}
              />
            </div>
          ) : null}
        </div>

        {/* Extras render read-only through the same editor the draft uses,
            so an off-catalog request the store made still shows up on the
            receipt instead of silently disappearing after submit. */}
        {locked.id !== 'optimistic' ? (
          <SessionExtrasEditor
            sessionId={locked.id}
            storeId={currentStoreId}
            initialValue={locked.extras ?? []}
            isReadOnly
            onSave={async () => {
              /* read-only — never called */
            }}
          />
        ) : null}

        <div className="px-4 pt-4">
          <Button block size="lg" variant="pearl" onClick={startNewBatch}>
            {i18n.t('order.batches.newBatch')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {/* M3.12-B (2026-05-16): the [date · selectedCount] row is gone.
          Both halves of the strip were redundant:
          - Date appears in the Telegram chrome (bot title bar shows
            the current view; users already orient by it).
          - Selected count is duplicated on the MainButton label
            ("Review Order (N)") which is always at the bottom of the
            screen and updates live. Showing the same number twice
            (top-right pill + MainButton) was visual stutter.
          The sticky strip now carries only the SearchInput + category
          ChipBar — the actual filters the user interacts with. */}
      <StickyPageBar direction="col">
        {canLeaveNewBatch ? (
          <button
            type="button"
            className="hit-44 self-start text-old-label font-semibold text-[var(--c-action)]"
            onClick={leaveNewBatch}
          >
            ‹ {i18n.t('order.batches.backToReceipt')}
          </button>
        ) : null}
        {/* 2026-07-30 (flow review): the store you are ordering for was
            stated NOWHERE on this page. See the StoreChip docblock —
            with the picker two taps deep in Telegram's overflow and the
            selection persisted, an owner could spend a day ordering into
            the wrong store with no cue at all.

            Later the same day: the chip moved OUT of here and into
            Shell's top strip, centered in the slot Telegram leaves
            between its Close and ⋯ buttons. It is page-independent
            context, so one instance in the shell beats a copy in each
            page's sticky bar — and Run / Admin, which never had one,
            get it for free. What stays here is the batch count, which
            IS page state.

            Losing the chip left the batch count alone on a row of its
            own, `ml-auto` pinning it to the right edge with a hand's
            width of nothing beside it. It rides the search row now:
            one less row on a 375-px screen, and "field + trailing
            action" is a shape people already read. */}
        <div className="flex items-center gap-2">
          <SearchInput
            className="flex-1"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onClear={() => setSearchQuery('')}
            placeholder={i18n.t('order.search.placeholder')}
            clearAriaLabel={i18n.t('common.clear')}
            aria-label={i18n.t('order.search.placeholder')}
          />
          {/* Batch count stays visible while drafting too — otherwise
              "再报一批" drops you into an empty catalog identical to a
              first-of-the-day order, with nothing saying the earlier
              batches exist. */}
          {(batchesQuery.data?.length ?? 0) > 1 ? (
            <button
              type="button"
              onClick={() => setBatchesOpen(true)}
              className="press hit-44 shrink-0 rounded-[var(--r-pill)] px-1.5 py-0.5 text-old-label tabular-nums text-[var(--c-action)]"
            >
              {/* U5: the draft being filled in is not counted. */}
              {i18n.t('order.batches.today', { n: sentBatchCount(batchesQuery.data) })}
            </button>
          ) : null}
        </div>
        {/* V4: -my-1.5 py-1.5 instead of py-0 — same layout, but the
            scroller keeps the 6px above and below that the chips' 44px tap
            areas (hit-44) need; a scroller clips everything past its padding. */}
        <ChipBar ariaLabel={i18n.t('order.categoriesAriaLabel')} className="-mx-4 -my-1.5 px-4 py-1.5">
          <Chip
            selected={activeCategory === null}
            onClick={() => {
              // M3.10 (2026-05-16): tapping "All" after a category
              // filter previously left any active search query in
              // place. If the user had typed "tomato" while looking
              // at Fruits and then tapped All to "reset", the search
              // still filtered the (now-broader) list and they often
              // saw an empty result with no obvious way to clear.
              // Clearing search alongside the category reset matches
              // the natural "show me everything" intent.
              setActiveCategory(null);
              setSearchQuery('');
            }}
          >
            {i18n.t('order.categories.all')}
          </Chip>
          <DataState query={categoriesQuery}>
            {(cats) =>
              cats.map((c) => (
                <Chip
                  key={c.id}
                  selected={activeCategory === c.id}
                  onClick={() => setActiveCategory(c.id)}
                >
                  {productName({ names: c.names })}
                </Chip>
              ))
            }
          </DataState>
        </ChipBar>
      </StickyPageBar>
      {staleWarning}
      {/* ORD-3 (2026-10-30): changes waiting in the outbox were invisible. */}
      <PendingSyncNotice count={pendingChangeCount(offline.pendingEntries)} saving={offline.savingSlow} />
      {rejectedNotice(sessionQuery.data?.id) ? (
        <div className="px-4 pt-3">{rejectedNotice(sessionQuery.data?.id)}</div>
      ) : null}

      {/* Status banners — only render the wrapper when at least one
          banner condition is true, so the empty-state draft view has
          zero chrome between sticky filters and the SKU list. M1.11:
          single section with `gap-2` replaces 4 individually-padded
          shells. */}
      {(sessionStatus &&
        (sessionStatus === 'rejected' ||
          sessionStatus === 'approved' ||
          sessionStatus === 'in_run' ||
          (sessionStatus === 'submitted' && !sessionQuery.data?.claimedByMemberId))) ||
      (sessionQuery.data?.claimedByMemberId &&
        sessionQuery.data.claimedByMemberId !== session.member.memberId) ? (
        <div className="flex flex-col gap-2 px-4 pt-2">
          {sessionQuery.data?.claimedByMemberId &&
          sessionQuery.data.claimedByMemberId !== session.member.memberId ? (
            <Banner
              tone="warn"
              title={i18n.t('order.banner.claimed', {
                who:
                  sessionQuery.data.claimedByDisplayName ?? i18n.t('approval.unknownReviewer'),
              })}
            />
          ) : null}
          {/* DX-ORD-3 (2026-11-01): no 撤回 here. A rejected batch is edited
              in place already; withdrawing it only turned it back into a
              draft and took the reviewer's reason off the screen. The
              reason is the body (it was the bold red title), with who
              sent it back and when. */}
          {sessionStatus === 'rejected' && sessionQuery.data ? (
            <Banner tone="danger" title={i18n.t('order.status.rejectedTitle')}>
              {rejectionBody(sessionQuery.data)}
            </Banner>
          ) : null}
          {sessionStatus === 'submitted' && !sessionQuery.data?.claimedByMemberId ? (
            <Banner
              tone="info"
              title={i18n.t('order.status.submitted')}
              action={
                <Button
                  size="sm"
                  variant="pearl"
                  loading={withdraw.isPending}
                  onClick={() => sessionQuery.data && withdraw.mutate({ sessionId: sessionQuery.data.id })}
                >
                  {i18n.t('order.withdraw')}
                </Button>
              }
            />
          ) : null}
          {sessionStatus === 'approved' ? (
            <Banner tone="success" title={i18n.t('order.banner.approved.title')}>
              {i18n.t('order.banner.approved.body')}
            </Banner>
          ) : null}
          {sessionStatus === 'in_run' && currentStoreId ? (
            <InRunBanner runId={sessionQuery.data?.runId} storeId={currentStoreId} />
          ) : null}
        </div>
      ) : null}

      {/* DX-ORD-4 (2026-11-01): "empty" is judged on what can be ordered —
          it was judged on the list including archived products, so a
          catalog of only archived ones showed a blank page — and says why,
          not "tap + next to a product" when there is none to tap. */}
      <DataState
        query={skusQuery}
        emptyWhen={() => skus.length === 0}
        empty={
          <EmptyState
            title={i18n.t('order.catalogEmpty.title')}
            description={i18n.t('order.catalogEmpty.description', {
              path: `${i18n.t('nav.admin')} › ${i18n.t('admin.section.catalog')}`,
            })}
          />
        }
      >
        {() => (
          <ul className="flex flex-col" role="list">
            {filteredSkus.length === 0 && (deferredSearch || activeCategory) ? (
              <li>
                {/* Review UI-13 (2026-11-11): a line in the list, as on the
                    run preview, not a page heading inside it. */}
                <EmptyState
                  compact
                  title={i18n.t('order.search.noMatches.title')}
                  description={i18n.t('order.search.noMatches.description')}
                />
              </li>
            ) : null}
            {catalogGroups.map((group) => {
              // DX-ORD-6: headings under "All"; a picked category is its own
              // heading already. Archived lines always say what they are.
              const showHeading =
                group.key !== 'search' && (group.archived || activeCategory === null);
              const heading = group.archived
                ? i18n.t('order.review.archived')
                : group.categoryId
                  ? (categoryNameById.get(group.categoryId) ?? '')
                  : i18n.t('order.categories.uncategorized');
              return (
                <li key={group.key}>
                  {showHeading ? (
                    <SectionLabel
                      as="h3"
                      className={cn('pt-3', group.archived && 'text-[var(--c-warning-fg)]')}
                    >
                      {heading}
                    </SectionLabel>
                  ) : null}
                  <ul className="flex flex-col" role="list">
                    {group.skus.map((sku) => (
                      <SkuRow
                        key={sku.id}
                        sku={sku}
                        archived={!!sku.isArchived}
                        myQty={myQtyBySku.get(sku.id) ?? 0}
                        totalQty={totalQtyBySku.get(sku.id) ?? 0}
                        otherContribCount={
                          (contributorsBySku.get(sku.id) ?? [])
                            .filter((c) => c.memberId !== myMemberId).length
                        }
                        isReadOnly={isReadOnly}
                        storeId={currentStoreId}
                        productNameParts={productNameParts}
                        unitLabel={unitLabel}
                        i18n={i18n}
                        onQtyChange={handleQtyChange}
                      />
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </DataState>

      {/* Session-level "其他物品" structured extras (M3.16-C,
          2026-05-16). Replaces the M1.8 free-text textarea with a
          structured list of {name, qty, unit, note?} rows. Sits at
          the bottom of the SKU list so it's the last thing the staff
          sees before reviewing — natural placement for "and these
          items aren't in the catalog". Read-only once the session
          leaves draft (shown read-only on Approval / Run pages).
          2026-10-21 audit CA-27: also rendered BEFORE any session
          exists — an order of only non-catalog items is legitimate;
          the first save lazy-creates the draft (see saveExtras). */}
      {showExtrasEditor ? (
        <SessionExtrasEditor
          sessionId={extrasSessionId}
          storeId={currentStoreId ?? ''}
          // Rows saved before M3.34 (2026-05-19) may carry free text such
          // as "kgs" or "公斤". ORD-13 (2026-11-11): shown as written, not
          // turned into 'kg' (which re-saving then made true); the editor
          // asks for a unit from the list before it saves again.
          initialValue={sessionQuery.data?.extras ?? []}
          isReadOnly={isReadOnly}
          onSave={saveExtras}
        />
      ) : null}

      {/* An in-page "Review order (N)" fallback used to live here, gated on
          `!getTg()` — "only outside Telegram, where there's no MainButton".
          Deleted 2026-07-30. It never rendered (getTg() is truthy in any
          browser: the SDK is a static script tag), and it MUST not: since
          M3.49 the in-DOM <PageMainButton /> in Shell renders in every
          environment and already carries this exact action. Reviving the
          branch by "fixing" its predicate would just show the button
          twice. The other five sites that conflated SDK-present with
          inside-Telegram needed real fixes; this one needed deleting. */}

      {/* Review sheet — preview of what's being submitted. No buttons in
          the body: inside Telegram the MainButton text changes from
          "Review Order (N)" to "Submit order" while open, and that's the
          submit trigger. Tap-outside / swipe-down dismisses the sheet.
          Outside Telegram (rare — web preview) we render a single
          fallback button in the footer since there's no MainButton. */}
      {/* Today's batches, reachable while drafting. Without this the count
          above was informational only: you could see that an earlier batch
          existed but not what was in it or where it had got to. */}
      <Sheet
        open={batchesOpen}
        onOpenChange={setBatchesOpen}
        title={i18n.t('order.batches.today', { n: sentBatchCount(batchesQuery.data) })}
      >
        <div className="py-3">
          <BatchStrip
            batches={batchesQuery.data ?? []}
            currentId={sessionQuery.data?.id ?? ''}
            i18n={i18n}
            currency={orgCurrency}
            showHeading={false}
            onSelect={selectBatch}
          />
        </div>
      </Sheet>

      <Sheet
        open={reviewOpen}
        onOpenChange={(open) => !open && !submit.isPending && setReviewOpen(false)}
        title={i18n.t('order.review.title')}
        description={
          // DX-ORD-12: "7 items + 1 other item" — other items are not products.
          dateLabel +
          ' · ' +
          i18n.t('order.review.itemsCount', { n: totals.length }) +
          (extrasCount > 0 ? ' + ' + i18n.t('order.batches.extras', { n: extrasCount }) : '')
        }
        footer={
          // M3.49: in-page PageMainButton sits behind any open sheet —
          // we must render the sheet's own footer button so the user
          // has something to tap.
          <div className="flex flex-col gap-2">
            {/* DX-ORD-5: offline the button is off and says why. */}
            {!offline.online ? (
              <p id="order-submit-offline" className="text-center text-old-label text-[var(--c-fg-muted)]">
                {i18n.t('order.review.needsNetwork')}
              </p>
            ) : null}
            <Button
              block
              size="lg"
              loading={submit.isPending}
              disabled={selectedCount === 0 || !offline.online}
              aria-describedby={!offline.online ? 'order-submit-offline' : undefined}
              onClick={() => {
                if (!sessionQuery.data) return;
                void handleSubmit();
              }}
            >
              {submit.isPending
                ? i18n.t('order.action.submitting')
                : i18n.t('order.action.submitOrder')}
            </Button>
          </div>
        }
      >
        {/* A11Y-7 (2026-10-31): the list is the sheet's first focus stop, so
            opening 复核订单 with the keyboard lands on what is being
            ordered. Focus used to land on 提交订单 itself, where a repeated
            Enter submitted the order unread. */}
        <div
          tabIndex={0}
          role="region"
          aria-label={i18n.t('order.review.title')}
          className="rounded-[var(--r-utility)]"
        >
          {totals.length > 0 || extrasCount === 0 ? (
            <ReviewList
              totals={totals}
              skus={allSkus}
              categories={categoriesQuery.data ?? []}
              productName={productName}
              edit={
                currentStoreId && !isReadOnly
                  ? {
                      myQtyBySku,
                      onQtyChange: (skuId, qty) => handleQtyChange(currentStoreId, skuId, qty),
                    }
                  : undefined
              }
            />
          ) : null}
          {extrasCount > 0 && sessionQuery.data && sessionQuery.data.id !== 'optimistic' ? (
            <SessionExtrasEditor
              sessionId={sessionQuery.data.id}
              storeId={currentStoreId}
              initialValue={sessionQuery.data.extras ?? []}
              isReadOnly
              inSheet
              onSave={async () => {
                /* read-only — never called */
              }}
            />
          ) : null}
        </div>
      </Sheet>
    </div>
  );
}
