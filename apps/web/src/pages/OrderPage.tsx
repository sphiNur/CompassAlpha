import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Banner,
  Button,
  ChipBar,
  Chip,
  cn,
  DataState,
  EmptyState,
  Input,
  NameCell,
  NumberInput,
  QtyControl,
  SearchInput,
  SectionLabel,
  Sheet,
  StickyPageBar,
  useToast,
} from '@compass/ui';
import { trpc } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { usePageMainButton, haptic } from '../hooks/useTelegram';
import { useOfflineQueue } from '../hooks/useOfflineQueue';
import { isLikelyNetworkError } from '../lib/networkError';
import { useErrToast } from '../lib/errToast';
import { matchesNameLike, normalizeQuery } from '../lib/searchMatch';
import {
  useDateFormat,
  useI18n,
  useProductName,
  useProductNameParts,
  useUnitLabel,
} from '../hooks/useI18n';

// M3.34 (2026-05-19): canonical units for the extras editor's unit
// dropdown — kept in sync with CanonicalUnitSchema in
// @compass/contracts. STEP map drives NumberInput's decimal vs
// integer granularity per unit; UNIT_IS_INTEGER drives inputMode.
const CANONICAL_UNITS = ['kg', 'g', 'L', 'ml', 'pcs', 'pack', 'pair', 'bunch', 'roll'] as const;
const UNIT_STEP: Record<string, string> = {
  kg: '0.1',
  L: '0.1',
  g: '10',
  ml: '10',
  pcs: '1',
  pack: '1',
  pair: '1',
  bunch: '1',
  roll: '1',
};
const UNIT_IS_INTEGER = new Set(['pcs', 'pack', 'pair', 'bunch', 'roll']);
import { formatQty, formatMoney } from '../lib/format';
import { StoreChip, useStoreContext } from '../components/StoreSwitcher';

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
  const orgCurrency = useAuthStore((s) => s.session?.member.currency) ?? 'UZS';
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
  // M1.10 (2026-05-08): cross-language SKU search. Lives above the
  // category chip-bar; queries match across uz/ru/en/zh names + code.
  const [searchQuery, setSearchQuery] = useState('');

  const categoriesQuery = trpc.catalog.categories.useQuery();
  const skusQuery = trpc.catalog.skus.useQuery({ includeArchived: false });
  const sessionQuery = trpc.order.todaySession.useQuery(
    { storeId: currentStoreId ?? '' },
    { enabled: !!currentStoreId },
  );
  // Every batch this member started today at this store — drives the
  // "今日 N 批" strip and the receipt's batch list.
  const batchesQuery = trpc.order.todayBatches.useQuery(
    { storeId: currentStoreId ?? '' },
    { enabled: !!currentStoreId },
  );

  const utils = trpc.useUtils();
  // Replay map for the offline outbox. The hook calls back into our
  // tRPC client when network returns; we use the imperative .mutate()
  // form so the in-memory mutation state stays the same.
  const offline = useOfflineQueue({
    'order.adjustItem': async (entry) => {
      await utils.client.order.adjustItem.mutate(
        entry.input as Parameters<typeof utils.client.order.adjustItem.mutate>[0],
      );
      void utils.order.todaySession.invalidate();
    },
  }, { onDrop: () => toast.error(i18n.t('run.toast.syncFailed')) });
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
        return { ...old, id: data.sessionId };
      });
    },
    onError: (err, vars) => {
      if (isLikelyNetworkError(err)) {
        // Keep optimistic, enqueue for replay when online.
        void offline.enqueue('order.adjustItem', vars);
        return;
      }
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

  // Cleanup any pending timers on unmount.
  useEffect(() => {
    const timersOnMount = pendingTimers.current;
    return () => {
      timersOnMount.forEach((t) => clearTimeout(t));
      timersOnMount.clear();
    };
  }, []);

  /**
   * Fires a single AdjustItem mutation, waiting first for any
   * in-flight mutation for the same STORE (not the same SKU — see
   * the keying rationale above). The promise it returns settles when
   * the mutation succeeds OR fails.
   */
  const flushOne = useCallback(
    (payload: PendingPayload): Promise<unknown> => {
      const queueKey = payload.storeId;
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
          return await adjust.mutateAsync(payload);
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
    [adjust],
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

  /**
   * Recompute aggregate totals[] from items[]. Used by the optimistic
   * cache writer.
   */
  const recomputeTotals = (
    items: Array<{ skuId: string; qty: string }>,
  ): Array<{ skuId: string; qty: string }> => {
    const sums = new Map<string, number>();
    for (const it of items) {
      const v = Number(it.qty);
      if (v > 0) sums.set(it.skuId, (sums.get(it.skuId) ?? 0) + v);
    }
    return [...sums.entries()].map(([skuId, q]) => ({
      skuId,
      qty: q.toFixed(3).replace(/\.?0+$/, ''),
    }));
  };

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

      // Step 1: immediate optimistic cache update.
      utils.order.todaySession.setData(queryKey, (old) => {
        if (!old) {
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
            orderDate: new Date().toISOString().slice(0, 10),
            status: 'draft' as const,
            claimedByMemberId: null,
            claimedByDisplayName: null,
            claimedAt: null,
            submittedAt: null,
            decidedAt: null,
            decidedByMemberId: null,
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
        void flushOne(payload);
      }, DEBOUNCE_MS);
      pendingTimers.current.set(key, timer);
    },
    [flushOne, session?.member.memberId, utils.order.todaySession],
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
  const submit = trpc.order.submit.useMutation({
    retry: false,
    onSuccess: () => {
      void utils.order.todaySession.invalidate();
      void utils.order.todayBatches.invalidate();
      // Leave new-batch mode: the batch we just sent is now the receipt.
      setNewBatch(false);
      haptic('success');
      toast.success(i18n.t('order.toast.submitted'));
    },
    onError: (err) => {
      haptic('error');
      if (isLikelyNetworkError(err)) {
        toast.error(i18n.t('order.toast.submitFailedNetwork'));
      } else {
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
      void utils.order.todaySession.invalidate();
      void utils.order.todayBatches.invalidate();
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
    utils.order.todaySession.setData({ storeId: currentStoreId }, null);
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

  const skus = skusQuery.data ?? [];
  const filteredSkus = useMemo(
    () => {
      // Two filters compose: category chip + cross-language search.
      // Apply category first (cheap object-key compare) then search
      // (string match across 4 lang fields + code) so we walk the
      // smaller set on the second pass.
      let out = activeCategory
        ? skus.filter((s) => s.categoryId === activeCategory)
        : skus;
      const tokens = normalizeQuery(searchQuery);
      if (tokens) {
        out = out.filter((s) =>
          matchesNameLike(
            { names: s.names as Record<string, string> | null, code: s.code },
            tokens,
          ),
        );
      }
      return out;
    },
    [skus, activeCategory, searchQuery],
  );

  const items = sessionQuery.data?.items ?? [];
  const totals = sessionQuery.data?.totals ?? [];
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

  // Distinct SKUs with non-zero aggregate qty.
  const selectedCount = totals.length;

  const sessionStatus = sessionQuery.data?.status ?? null;
  const sessionLocked =
    sessionStatus === 'submitted' ||
    sessionStatus === 'approved' ||
    sessionStatus === 'in_run' ||
    sessionStatus === 'archived';
  // While starting a new batch the locked session is not what we're
  // editing, so nothing is read-only.
  const isReadOnly = sessionLocked && !newBatch;

  // Telegram MainButton — single point of control for the entire submit
  // flow. State machine:
  //   - sheet closed + items selected → "Review Order (3)"     → opens sheet
  //   - sheet open + not pending      → "Submit order"          → fires submit
  //   - sheet open + pending          → "Submitting…"  (disabled)
  // No buttons inside the sheet body — the MainButton IS the action.
  // The sheet handles its own dismissal via tap-outside / swipe-down.
  const canSubmit =
    sessionStatus === 'draft' || sessionStatus === 'rejected';

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
    const storeId = currentStoreId;

    await flushAllPendingAdjusts();

    let sid = utils.order.todaySession.getData({ storeId })?.id;
    if (!sid || sid === 'optimistic') {
      try {
        const fresh = await utils.order.todaySession.fetch({ storeId });
        sid = fresh?.id;
      } catch {
        /* network fail — fall through to syncing toast */
      }
    }

    if (!sid || sid === 'optimistic') {
      toast.info(i18n.t('order.toast.syncing'));
      return;
    }
    submit.mutate(
      { sessionId: sid },
      { onSuccess: () => setReviewOpen(false) },
    );
  }, [
    canSubmit,
    selectedCount,
    submit,
    currentStoreId,
    flushAllPendingAdjusts,
    utils.order.todaySession,
    toast,
    i18n,
  ]);

  usePageMainButton(
    mainButtonText,
    () => {
      if (!canSubmit || selectedCount === 0 || submit.isPending) return;
      if (reviewOpen) {
        if (!sessionQuery.data) return;
        void handleSubmit();
      } else {
        setReviewOpen(true);
      }
    },
    {
      visible: canSubmit && selectedCount > 0,
      active: selectedCount > 0 && !submit.isPending,
    },
  );

  if (!session) return null;
  if (!currentStoreId) {
    // Three failure modes:
    //   1. storeCtx.kind === 'none'   — user has no store assignments
    //   2. storeCtx.kind === 'all'    — admin viewing aggregate; OrderPage
    //                                    needs a specific store, prompt them
    //   3. currentStoreId fell to null somehow — same as case 1 in practice
    return (
      /* M3.5: the inline store-picker strip is gone — the picker now
         lives in SettingsSheet, reachable via Telegram's gear button.
         Empty-state copy was updated to point users at Settings. */
      <div className="flex flex-col">
        {storeCtx.kind === 'none' ? (
          <EmptyState
            title={i18n.t('auth.noStore.title')}
            description={i18n.t('auth.noStore.body')}
          />
        ) : (
          <EmptyState
            title={i18n.t('storeSwitcher.pickPrompt.title')}
            description={i18n.t('storeSwitcher.pickPrompt.body')}
          />
        )}
      </div>
    );
  }

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
          <StoreChip />
          <span className="ml-auto shrink-0 text-label tabular-nums text-[var(--c-fg-muted)]">
            {dateLabel}
          </span>
        </StickyPageBar>

        <div className="flex flex-col gap-3 px-4 pt-3">
          <BatchStrip
            batches={batchesQuery.data ?? []}
            currentId={locked.id}
            i18n={i18n}
            currency={orgCurrency}
          />
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
          ) : sessionStatus === 'in_run' ? (
            <Banner tone="info" title={i18n.t('order.banner.inRun.title')}>
              {i18n.t('order.banner.inRun.body')}
            </Banner>
          ) : (
            <Banner tone="info" title={i18n.t('order.status.archived')} />
          )}

          <BatchStrip
            batches={batchesQuery.data ?? []}
            currentId={locked.id}
            i18n={i18n}
            currency={orgCurrency}
          />

          <div>
            <SectionLabel padded={false} className="mb-1.5">
              {i18n.t('order.receipt.submittedItems')}
            </SectionLabel>
            <ReviewList totals={totals} skus={skus} productName={productName} />
          </div>
        </div>

        {/* Extras render read-only through the same editor the draft uses,
            so an off-catalog request the store made still shows up on the
            receipt instead of silently disappearing after submit. */}
        {locked.id !== 'optimistic' ? (
          <SessionExtrasEditor
            sessionId={locked.id}
            storeId={currentStoreId}
            initialValue={(locked.extras ?? []).map((r) => ({
              ...r,
              unit: (CANONICAL_UNITS as readonly string[]).includes(r.unit)
                ? (r.unit as (typeof CANONICAL_UNITS)[number])
                : 'kg',
            }))}
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
        {/* 2026-07-30 (flow review): the store you are ordering for was
            stated NOWHERE on this page. See the StoreChip docblock —
            with the picker two taps deep in Telegram's overflow and the
            selection persisted, an owner could spend a day ordering into
            the wrong store with no cue at all. */}
        <div className="flex items-center gap-2">
          <StoreChip />
          {/* Batch count stays visible while drafting too — otherwise
              "再报一批" drops you into an empty catalog identical to a
              first-of-the-day order, with nothing saying the earlier
              batches exist. */}
          {(batchesQuery.data?.length ?? 0) > 1 ? (
            <button
              type="button"
              onClick={() => setBatchesOpen(true)}
              className="press ml-auto shrink-0 rounded-[var(--r-pill)] px-1.5 py-0.5 text-label tabular-nums text-[var(--c-action)]"
            >
              {i18n.t('order.batches.today', { n: batchesQuery.data!.length })}
            </button>
          ) : null}
        </div>
        <SearchInput
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onClear={() => setSearchQuery('')}
          placeholder={i18n.t('order.search.placeholder')}
          clearAriaLabel={i18n.t('common.clear')}
          aria-label={i18n.t('order.search.placeholder')}
        />
        <ChipBar ariaLabel={i18n.t('order.categoriesAriaLabel')} className="-mx-4 px-4 py-0">
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
                  {productName({ names: c.names as Record<string, string> })}
                </Chip>
              ))
            }
          </DataState>
        </ChipBar>
      </StickyPageBar>

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
            <Banner tone="warn" title={i18n.t('order.banner.claimed', { who: 'manager' })} />
          ) : null}
          {sessionStatus === 'rejected' ? (
            <Banner
              tone="danger"
              title={i18n.t('order.status.rejected', { reason: sessionQuery.data?.rejectReason ?? '—' })}
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
          {sessionStatus === 'in_run' ? (
            <Banner tone="info" title={i18n.t('order.banner.inRun.title')}>
              {i18n.t('order.banner.inRun.body')}
            </Banner>
          ) : null}
        </div>
      ) : null}

      <DataState
        query={skusQuery}
        emptyWhen={(d) => d.length === 0}
        empty={<EmptyState title={i18n.t('order.empty.title')} description={i18n.t('order.empty.description')} />}
      >
        {() => (
          <ul className="flex flex-col" role="list">
            {filteredSkus.length === 0 && (searchQuery || activeCategory) ? (
              <li className="px-4 py-8">
                <EmptyState
                  title={i18n.t('order.search.noMatches.title')}
                  description={i18n.t('order.search.noMatches.description')}
                />
              </li>
            ) : null}
            {filteredSkus.map((sku) => (
              <SkuRow
                key={sku.id}
                sku={sku}
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
        )}
      </DataState>

      {/* Session-level "其他物品" structured extras (M3.16-C,
          2026-05-16). Replaces the M1.8 free-text textarea with a
          structured list of {name, qty, unit, note?} rows. Sits at
          the bottom of the SKU list so it's the last thing the staff
          sees before reviewing — natural placement for "and these
          items aren't in the catalog". Read-only once the session
          leaves draft (shown read-only on Approval / Run pages).
          We render it only when a session row exists; before the
          user adds their first item there's no stream yet, and
          adding an extra alone wouldn't carry meaning. */}
      {sessionQuery.data?.id && sessionQuery.data.id !== 'optimistic' ? (
        <SessionExtrasEditor
          sessionId={sessionQuery.data.id}
          storeId={currentStoreId ?? ''}
          // M3.34 (2026-05-19): coerce server-side extras into the
          // canonical-unit shape. Rows submitted pre-M3.34 may carry
          // free-text like "kgs" or "公斤" — map to 'kg' so the
          // dropdown can render them and re-saving lands a canonical
          // value. Anything we can't match falls back to 'kg' (the
          // most-common SKU unit) which the user can then change.
          initialValue={(sessionQuery.data.extras ?? []).map((r) => ({
            ...r,
            unit: (CANONICAL_UNITS as readonly string[]).includes(r.unit)
              ? (r.unit as (typeof CANONICAL_UNITS)[number])
              : 'kg',
          }))}
          isReadOnly={isReadOnly}
          onSave={async (extras) => {
            await setSessionExtras.mutateAsync({
              sessionId: sessionQuery.data!.id,
              extras,
            });
            // Optimistic cache write so the editor doesn't flicker
            // on next refetch.
            utils.order.todaySession.setData(
              { storeId: currentStoreId ?? '' },
              (old) => (old ? { ...old, extras } : old),
            );
          }}
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
        title={i18n.t('order.batches.today', { n: batchesQuery.data?.length ?? 0 })}
      >
        <div className="py-3">
          <BatchStrip
            batches={batchesQuery.data ?? []}
            currentId={sessionQuery.data?.id ?? ''}
            i18n={i18n}
            currency={orgCurrency}
            showHeading={false}
          />
        </div>
      </Sheet>

      <Sheet
        open={reviewOpen}
        onOpenChange={(open) => !open && !submit.isPending && setReviewOpen(false)}
        title={i18n.t('order.review.title')}
        description={
          dateLabel + ' · ' + i18n.t('order.review.itemsCount', { n: selectedCount })
        }
        footer={
          // M3.49: in-page PageMainButton sits behind any open sheet —
          // we must render the sheet's own footer button so the user
          // has something to tap.
          <Button
            block
            size="lg"
            loading={submit.isPending}
            disabled={selectedCount === 0}
            onClick={() => {
              if (!sessionQuery.data) return;
              void handleSubmit();
            }}
          >
            {submit.isPending
              ? i18n.t('order.action.submitting')
              : i18n.t('order.action.submitOrder')}
          </Button>
        }
      >
        <ReviewList totals={totals} skus={skus} productName={productName} />
      </Sheet>
    </div>
  );
}

/**
 * Memoized SKU row (M3.10, 2026-05-16).
 *
 * Previously the SKU list was inline `filteredSkus.map(sku => <li>…</li>)`
 * inside OrderPage. Tapping +/- on any one row updated the tRPC cache
 * via `utils.order.todaySession.setData`, which triggered a parent
 * re-render — which then re-rendered ALL 187 rows in production
 * (~2-3 ms each on slow iOS WebView = 400-500 ms of work for a single
 * tap).
 *
 * Pulling the row into `React.memo` short-circuits all unaffected
 * rows. The memo compares props shallowly; only the one row whose
 * `myQty` / `totalQty` / `otherContribCount` changed re-renders. Other
 * rows skip render entirely when the parent re-renders for unrelated
 * reasons (search input typing, banner state change, etc.).
 *
 * Stability requirements for the props (so memo isn't busted):
 *   - `productName`: useProductName() now memoizes by locale (M3.10
 *     hook fix) so its reference is stable across renders.
 *   - `onQtyChange`: already useCallback'd at handleQtyChange.
 *   - `i18n`: useI18n() returns a useMemo'd object per locale.
 *   - Other props are primitives or stable references.
 */
type SkuRowSku = {
  id: string;
  names: Record<string, string>;
  unit: string;
  step: string;
  suggestedQty?: string | number | null;
};

const SkuRow = memo(function SkuRow({
  sku,
  myQty,
  totalQty,
  otherContribCount,
  isReadOnly,
  storeId,
  productNameParts,
  unitLabel,
  i18n,
  onQtyChange,
}: {
  sku: SkuRowSku;
  myQty: number;
  totalQty: number;
  otherContribCount: number;
  isReadOnly: boolean;
  storeId: string;
  productNameParts: (item: {
    names: Record<string, string> | null | undefined;
  }) => { primary: string; secondary: string | null };
  unitLabel: (unit: string | null | undefined) => string;
  i18n: ReturnType<typeof useI18n>;
  onQtyChange: (storeId: string, skuId: string, qty: string) => void;
}) {
  // M3.15 (2026-05-16): py-2 → py-1.5 to tighten the SKU row. With
  // the new QtyControl baseline (h-9 = 36 px), the row sits at ~52 px
  // instead of the old ~72 px — matches the bottom-nav rhythm. One
  // more SKU visible per viewport on a 5.5" screen.
  //
  // M3.55 (2026-05-23): user-requested tweaks for the order surface:
  //   - bumped SKU name from text-body (13 px) → text-h2 (15 px) so
  //     the primary content scans easier on phone screens.
  //   - dropped the redundant `{sku.unit}` caption that used to lead
  //     the secondary line. The unit is already shown inside the
  //     QtyControl pill on the right ("3 kg") so duplicating it here
  //     stole vertical real estate without adding info.
  //   - the secondary line now hides entirely when there's no
  //     suggested qty AND no cross-staff contribution count — most
  //     rows on a fresh order are exactly that case, so the row
  //     collapses to a single line.
  const hasSecondaryLine =
    !!sku.suggestedQty || (otherContribCount > 0 && totalQty > 0);
  const nm = productNameParts(sku);
  return (
    <li className="flex items-center justify-between border-b border-[var(--c-divider)] px-4 py-1.5 last:border-b-0">
      <div className="min-w-0 flex-1 pr-3">
        <NameCell primary={nm.primary} secondary={nm.secondary} size="prominent" />
        {hasSecondaryLine ? (
          <div className="mt-0.5 text-label leading-tight text-[var(--c-fg-muted)]">
            {sku.suggestedQty
              ? i18n.t('order.suggested', { qty: sku.suggestedQty })
              : null}
            {sku.suggestedQty && otherContribCount > 0 && totalQty > 0
              ? ' · '
              : null}
            {otherContribCount > 0 && totalQty > 0 ? (
              <>
                <span className="font-semibold text-[var(--c-fg)]">
                  {i18n.t('order.totalQty', { qty: totalQty, unit: unitLabel(sku.unit) })}
                </span>
                {' '}
                ({otherContribCount + (myQty > 0 ? 1 : 0)})
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      <QtyControl
        value={myQty}
        step={Number(sku.step)}
        unit={unitLabel(sku.unit)}
        disabled={isReadOnly}
        onChange={(next) => onQtyChange(storeId, sku.id, String(next))}
        // M3.55 (2026-05-23): show the SKU name in the qty quick-pick
        // sheet title. Without this the popup was a context-less "Set
        // quantity" — when the user mis-tapped a row, they couldn't
        // tell they'd opened the wrong SKU's picker. Now the title
        // reads e.g. "玉米淀粉" so a wrong row is obvious instantly.
        pickTitle={nm.primary}
      />
    </li>
  );
});

/**
 * "Today's batches" strip (2026-07-30).
 *
 * M3.32 gave a (member, store, day) several sessions; the Order page only
 * ever showed one of them, so submitting a batch and starting another made
 * the first disappear with no trace. This is the trace: one chip per batch,
 * the one you're looking at marked, so "did my morning order go through?"
 * is answerable without leaving the page.
 *
 * Renders nothing for a single batch — with one chip the strip would just
 * restate the receipt below it.
 */
function BatchStrip({
  batches,
  currentId,
  i18n,
  currency,
  showHeading = true,
}: {
  /** The sheet that can host this strip supplies its own title, so it
   *  turns the internal heading off rather than stating "今日 N 批" twice. */
  showHeading?: boolean;
  batches: Array<{
    id: string;
    status: string;
    batchNumber: number;
    itemCount: number;
    estimatedTotal: string | null;
  }>;
  currentId: string;
  i18n: ReturnType<typeof useI18n>;
  currency: string;
}) {
  if (batches.length < 2) return null;
  return (
    <div>
      {showHeading ? (
        <SectionLabel padded={false} className="mb-1.5">
          {i18n.t('order.batches.today', { n: batches.length })}
        </SectionLabel>
      ) : null}
      <ul className="flex flex-col gap-1" role="list">
        {batches.map((b) => {
          const isCurrent = b.id === currentId;
          return (
            <li
              key={b.id}
              className={
                'flex items-baseline justify-between gap-2 rounded-[var(--r-card)] px-3 py-2 text-label ring-hairline ' +
                (isCurrent
                  ? 'bg-[var(--c-action)]/10 ring-1 ring-[var(--c-action)]'
                  : 'bg-[var(--c-surface-2)]')
              }
            >
              <span className="min-w-0 truncate">
                <span className="font-semibold text-[var(--c-fg)]">
                  {i18n.t('order.batches.batchLabel', { n: b.batchNumber })}
                </span>{' '}
                <span className="text-[var(--c-fg-muted)]">
                  {i18n.t(
                    ('order.status.' + b.status) as Parameters<typeof i18n.t>[0],
                    { reason: '' },
                  )}
                </span>
                {isCurrent ? (
                  <span className="text-[var(--c-action)]">
                    {' · '}
                    {i18n.t('order.batches.viewing')}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 whitespace-nowrap tabular-nums text-[var(--c-fg-muted)]">
                {i18n.t('approval.itemsCount', { n: b.itemCount })}
                {b.estimatedTotal
                  ? ` · ~${formatMoney(Number(b.estimatedTotal))} ${currency}`
                  : ''}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface ReviewTotal {
  skuId: string;
  qty: string;
}

function ReviewList({
  totals,
  skus,
  productName,
}: {
  totals: ReviewTotal[];
  skus: Array<{ id: string; categoryId: string | null; names: unknown; unit: string; step: string }>;
  productName: (item: { names: Record<string, string> | null | undefined }) => string;
}) {
  const i18n = useI18n();
  // 2026-07-30 (flow review): was printing the raw canonical unit, so the
  // last screen before Submit read "0.5 kg" while Approval showed "0.5 公斤".
  const unitLabel = useUnitLabel();
  // M1.21: org-wide currency for the estimate suffix.
  const currency = useAuthStore((s) => s.session?.member.currency) ?? 'UZS';
  // Pull avg-7d price stats for the SKUs being reviewed so we can show
  // an estimated total (added 2026-05-05). The API is keyed by skuId
  // and uses 7-day mean to avoid one freak-sale day skewing tomorrow's
  // expected cost. Stats might be null for new SKUs with no purchase
  // history yet — those rows just don't contribute to the estimate.
  const skuIds = useMemo(
    () => totals.filter((t) => Number(t.qty) > 0).map((t) => t.skuId),
    [totals],
  );
  const priceStats = trpc.catalog.skuPriceStats.useQuery(
    { skuIds },
    { enabled: skuIds.length > 0, staleTime: 60_000 },
  );
  const priceBySku = useMemo(() => {
    const m = new Map<string, { avg7d: string | null; lastPrice: string | null }>();
    for (const r of priceStats.data ?? []) {
      m.set(r.skuId, { avg7d: r.avg7d, lastPrice: r.lastPrice });
    }
    return m;
  }, [priceStats.data]);
  const estimate = useMemo(() => {
    let total = 0;
    let known = 0;
    let unknown = 0;
    for (const t of totals) {
      const qty = Number(t.qty);
      if (!(qty > 0)) continue;
      const stats = priceBySku.get(t.skuId);
      const price = stats?.avg7d ?? stats?.lastPrice;
      if (price) {
        total += Number(price) * qty;
        known += 1;
      } else {
        unknown += 1;
      }
    }
    return { total, known, unknown };
  }, [totals, priceBySku]);
  // Show the AGGREGATE qty per SKU (sum across all contributors). Group
  // by category. Items without a known SKU fall under "Other".
  const skuById = useMemo(() => {
    const m = new Map<string, (typeof skus)[number]>();
    for (const s of skus) m.set(s.id, s);
    return m;
  }, [skus]);

  const groups = useMemo(() => {
    const byCat = new Map<string | null, Array<{ name: string; qty: string; unit: string }>>();
    for (const t of totals) {
      if (Number(t.qty) <= 0) continue;
      const sku = skuById.get(t.skuId);
      if (!sku) continue;
      const arr = byCat.get(sku.categoryId) ?? [];
      arr.push({
        name: productName({ names: sku.names as Record<string, string> }),
        qty: t.qty,
        unit: sku.unit,
      });
      byCat.set(sku.categoryId, arr);
    }
    return [...byCat.entries()];
  }, [totals, skuById, productName]);

  if (groups.length === 0) {
    return (
      <div className="py-6 text-center text-body text-[var(--c-fg-muted)]">
        {i18n.t('order.review.empty')}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 py-3">
      {/* Estimated cost banner — shown when we have any price history
          to base the estimate on. Uses avg-7d mean per SKU. SKUs
          without history fall under "unknown" and are skipped from
          the total but called out so the staff knows the figure is
          approximate. (Added 2026-05-05.) */}
      {estimate.known > 0 ? (
        <div className="rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-4 py-2.5 ring-hairline">
          <div className="flex items-baseline justify-between gap-2">
            {/* eslint-disable-next-line — M3.13 typography exception:
                this eyebrow label is paired with a non-eyebrow big-money
                value as siblings inside a parent flex row, not a section
                header. SectionLabel is also flex which would compose
                awkwardly here. The CI grep guard for inline eyebrow
                strings allows-lists this single site. */}
            <span className="text-label font-semibold uppercase tracking-eyebrow text-[var(--c-fg-muted)]">
              {i18n.t('order.review.estimatedTotal')}
            </span>
            <span className="font-mono text-h2 font-semibold tabular-nums text-[var(--c-fg)]">
              ~{formatMoney(estimate.total)} {currency}
            </span>
          </div>
          <div className="mt-1 text-label text-[var(--c-fg-muted)]">
            {i18n.t('order.review.estimateHint', {
              known: estimate.known,
              unknown: estimate.unknown,
            })}
          </div>
        </div>
      ) : null}
      <ul className="flex flex-col gap-3" role="list">
        {groups.map(([catId, rows]) => (
          <li key={catId ?? 'other'}>
            <ul className="flex flex-col rounded-[var(--r-card)] bg-[var(--c-surface-2)] ring-hairline">
              {rows.map((r, i) => (
                <li
                  key={r.name + i}
                  className="flex items-baseline justify-between border-b border-[var(--c-divider)] px-4 py-2.5 last:border-b-0"
                >
                  {/* 2026-07-05: match the prominent SKU-name tier used
                      by SkuRow above (the Order surface is the "browse"
                      tier, text-h2) so the review summary and the pick
                      list read at the same size. */}
                  <span className="truncate pr-3 text-h2 font-semibold text-[var(--c-fg)]">
                    {r.name}
                  </span>
                  <span className="shrink-0 font-mono text-body tabular-nums text-[var(--c-fg-muted)]">
                    {formatQty(r.qty)} {unitLabel(r.unit)}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Session-level structured "其他物品" extras editor (M3.16-C,
 * 2026-05-16). Replaces SessionNotesEditor / the free-text textarea.
 *
 * Data shape: each extra is { name, qty, unit, note? }. The editor
 * holds the full list locally, mutates it on each row edit, and fires
 * a single setSessionExtras mutation 700 ms after the last keystroke
 * (or immediately on row add / remove). The mutation always sends the
 * WHOLE list — atomic-replace semantics match the domain event.
 *
 * Why a separate component:
 *   - Local rows array means typing doesn't wait for the server.
 *   - Suggestion query is per-row but identical per editor mount;
 *     the dropdown state is scoped inside the row component.
 *   - Stays mounted across refetches; adopts the server array into
 *     local state only when local is clean.
 *
 * Read-only mode: collapses each row to a one-line "name · qty unit"
 * read. Hidden entirely when no extras (read-only + empty list).
 */
interface ExtraDraft {
  name: string;
  qty: string;
  // M3.34: tightened from `string` to the canonical unit set so
  // tRPC's input schema validation (CanonicalUnitSchema) matches the
  // local shape — extras coming back from server may carry pre-M3.34
  // free-text units, the editor coerces to 'kg' on render if so.
  unit: (typeof CANONICAL_UNITS)[number];
  note?: string;
}

function SessionExtrasEditor({
  sessionId,
  storeId,
  initialValue,
  isReadOnly,
  onSave,
}: {
  sessionId: string;
  storeId: string;
  initialValue: ExtraDraft[];
  isReadOnly: boolean;
  onSave: (extras: ExtraDraft[]) => Promise<void>;
}) {
  const i18n = useI18n();
  const unitLabel = useUnitLabel();
  const [rows, setRows] = useState<ExtraDraft[]>(() =>
    initialValue.map((r) => ({ ...r })),
  );
  const lastSavedRef = useRef<string>(JSON.stringify(initialValue));
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [savingState, setSavingState] = useState<'idle' | 'saving' | 'saved'>('idle');

  // Adopt server array when local is clean. Compare via JSON string
  // (cheap; arrays are short ≤50 rows). If our local copy doesn't
  // match what we last saved, the user is mid-edit — let them win.
  useEffect(() => {
    const serverJson = JSON.stringify(initialValue);
    if (JSON.stringify(rows) === lastSavedRef.current) {
      lastSavedRef.current = serverJson;
      setRows(initialValue.map((r) => ({ ...r })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(initialValue)]);

  // Reset on session swap (different store → different session).
  useEffect(() => {
    const next = initialValue.map((r) => ({ ...r }));
    lastSavedRef.current = JSON.stringify(next);
    setRows(next);
    setSavingState('idle');
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Sanitize for the wire: drop empty-name rows, trim, coerce qty to
  // a valid decimal-as-string (or '1' fallback). The server enforces
  // the same rules; we just don't want to fire a guaranteed-reject
  // request for in-progress UI state.
  const sanitize = useCallback((draft: ExtraDraft[]): ExtraDraft[] => {
    const out: ExtraDraft[] = [];
    for (const r of draft) {
      const name = r.name.trim();
      // M3.34: unit is already type-constrained to the canonical enum;
      // no trim needed for the value (whitespace can't enter through
      // the <select>), but we still validate presence in case of a
      // pre-M3.34 cache write that smuggled in a stale free-text.
      const unit = r.unit;
      const qty = r.qty.trim();
      if (!name || !(CANONICAL_UNITS as readonly string[]).includes(unit)) continue;
      if (!/^\d+(\.\d{1,3})?$/.test(qty) || Number(qty) <= 0) continue;
      const note = r.note?.trim();
      out.push({
        name,
        qty,
        unit,
        ...(note ? { note } : {}),
      });
    }
    return out;
  }, []);

  const scheduleSave = useCallback(
    (next: ExtraDraft[], { immediate = false } = {}) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      const fire = async () => {
        const cleaned = sanitize(next);
        const cleanedJson = JSON.stringify(cleaned);
        if (cleanedJson === lastSavedRef.current) return;
        setSavingState('saving');
        try {
          await onSave(cleaned);
          lastSavedRef.current = cleanedJson;
          setSavingState('saved');
          setTimeout(() => setSavingState('idle'), 1500);
        } catch {
          setSavingState('idle');
        }
      };
      if (immediate) {
        void fire();
      } else {
        debounceRef.current = setTimeout(() => {
          debounceRef.current = null;
          void fire();
        }, 700);
      }
    },
    [onSave, sanitize],
  );

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  // Read-only and nothing to show → render nothing (avoids an empty
  // section under a submitted/approved session).
  const cleanedView = sanitize(rows);
  if (isReadOnly && cleanedView.length === 0) return null;

  const updateRow = (idx: number, patch: Partial<ExtraDraft>) => {
    setRows((prev) => {
      const next = prev.map((r, i) => (i === idx ? { ...r, ...patch } : r));
      scheduleSave(next);
      return next;
    });
  };
  const removeRow = (idx: number) => {
    setRows((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      scheduleSave(next, { immediate: true });
      return next;
    });
  };
  const addRow = () => {
    setRows((prev) => {
      if (prev.length >= 50) return prev;
      const next: ExtraDraft[] = [...prev, { name: '', qty: '1', unit: 'kg' as const }];
      // Don't fire save immediately — name is empty, sanitize drops
      // it. The save fires when the user types into the name field.
      return next;
    });
  };

  return (
    <section className="mt-2 px-4 pb-4 pt-1">
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <SectionLabel padded={false}>
          {i18n.t('order.extras.label')}
        </SectionLabel>
        <span className="text-label text-[var(--c-fg-muted)]">
          {savingState === 'saving'
            ? i18n.t('order.notes.saving')
            : savingState === 'saved'
              ? i18n.t('order.notes.saved')
              : ''}
        </span>
      </div>

      {isReadOnly ? (
        <ul className="flex flex-col gap-1 rounded-[var(--r-card)] bg-[var(--c-surface)] px-3 py-2 ring-hairline">
          {cleanedView.map((r, i) => (
            <li
              key={`${r.name}-${i}`}
              className="flex items-baseline justify-between gap-2 text-body"
            >
              <span className="min-w-0 flex-1 truncate text-[var(--c-fg)]">{r.name}</span>
              <span className="shrink-0 font-mono tabular-nums text-[var(--c-fg-muted)]">
                {r.qty} {unitLabel(r.unit)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((row, idx) => (
            <ExtraRowEditor
              key={idx}
              row={row}
              storeId={storeId}
              onChange={(patch) => updateRow(idx, patch)}
              onRemove={() => removeRow(idx)}
            />
          ))}
          <Button
            size="sm"
            variant="pearl"
            onClick={addRow}
            disabled={rows.length >= 50}
            className="self-start"
          >
            {i18n.t('order.extras.add')}
          </Button>
        </div>
      )}
    </section>
  );
}

/**
 * One row of the SessionExtrasEditor: name (with autocomplete), qty,
 * unit, remove. The autocomplete query fires on focus + as the user
 * types (debounced via react-query's natural caching — same key →
 * cached result for ~30s).
 */
function ExtraRowEditor({
  row,
  storeId,
  onChange,
  onRemove,
}: {
  row: ExtraDraft;
  storeId: string;
  onChange: (patch: Partial<ExtraDraft>) => void;
  onRemove: () => void;
}) {
  const i18n = useI18n();
  const unitLabel = useUnitLabel();
  const [focusing, setFocusing] = useState(false);
  // Suggestions query — fetches up to 20 distinct names this store
  // has used in the last 30 days. Enabled only while the name input
  // is focused so we don't fan out 5 simultaneous queries for 5
  // rows on every editor mount.
  const suggestionsQuery = trpc.order.extrasSuggestions.useQuery(
    { storeId, search: row.name },
    { enabled: focusing && storeId.length > 0, staleTime: 30_000 },
  );
  const suggestions = (suggestionsQuery.data ?? []).filter(
    (s) => s.name.length > 0 && s.name !== row.name.trim().toLowerCase(),
  );

  return (
    <div className="rounded-[var(--r-card)] bg-[var(--c-surface)] p-2 ring-hairline">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Input
            value={row.name}
            placeholder={i18n.t('order.extras.namePlaceholder')}
            maxLength={200}
            onChange={(e) => onChange({ name: e.target.value })}
            onFocus={() => setFocusing(true)}
            // Delay onBlur so the suggestion dropdown's click can
            // register before this fires and hides it.
            onBlur={() => setTimeout(() => setFocusing(false), 120)}
          />
          {focusing && suggestions.length > 0 ? (
            <ul
              role="listbox"
              className="absolute left-0 right-0 top-full z-10 mt-1 max-h-48 overflow-y-auto rounded-[var(--r-card)] bg-[var(--c-surface-elevated)] py-1 shadow-product ring-hairline"
            >
              {suggestions.slice(0, 6).map((s) => (
                <li key={s.name}>
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      // mousedown fires BEFORE blur — onClick would
                      // miss because blur hides the dropdown first.
                      e.preventDefault();
                      onChange({ name: s.name });
                      setFocusing(false);
                    }}
                    className="press flex w-full items-baseline justify-between gap-2 px-3 py-1.5 text-left text-body hover:bg-[var(--c-surface-2)]"
                  >
                    <span className="text-[var(--c-fg)]">{s.name}</span>
                    <span className="text-label text-[var(--c-fg-muted)]">
                      ×{s.count}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <NumberInput
          value={row.qty}
          // M3.34 (2026-05-19): step + inputMode track the unit so a
          // pcs/bunch row gives an integer keypad while a kg/L row
          // allows decimals. Prevents accidental decimal-in-pcs typos
          // (e.g. "1.5 个 of 鸡蛋" doesn't make sense).
          inputMode={UNIT_IS_INTEGER.has(row.unit) ? 'numeric' : 'decimal'}
          step={UNIT_STEP[row.unit] ?? '0.1'}
          min="0"
          className="w-16 text-center"
          onChange={(e) => onChange({ qty: e.target.value })}
        />
        <select
          value={row.unit}
          // M3.34: constrained to canonical units (CanonicalUnitSchema).
          // Free-text caused "kg"/"kgs"/"公斤" drift that broke
          // aggregation + i18n. Labels go through useUnitLabel so the
          // visible option text matches the rest of the UI in the
          // user's locale.
          onChange={(e) =>
            onChange({ unit: e.target.value as (typeof CANONICAL_UNITS)[number] })
          }
          className="h-9 w-20 rounded-[var(--r-input)] bg-[var(--c-surface)] px-2 text-center text-body text-[var(--c-fg)] ring-hairline focus:outline-none focus:ring-2 focus:ring-[var(--c-action)]"
        >
          {CANONICAL_UNITS.map((u) => (
            <option key={u} value={u}>
              {unitLabel(u)}
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-label={i18n.t('order.extras.remove')}
          onClick={onRemove}
          className={cn(
            'press inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full',
            'bg-[var(--c-surface-2)] text-[var(--c-fg-muted)] ring-hairline',
            'hover:text-[var(--c-danger)]',
          )}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
            <path
              d="M3.5 3.5l7 7M10.5 3.5l-7 7"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
