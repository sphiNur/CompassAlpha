import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button as OldButton, cn, Input, NumberInput, SectionLabel, useToast } from '@compass/ui';
import {
  Button,
  EmptyState,
  Field,
  List,
  Money,
  Row,
  Section,
  Sheet,
  StatusChip,
  Stepper,
} from '@compass/ui/kit';
import type { StatusTone } from '@compass/ui/kit';
import { trpc } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { usePageMainButton, haptic } from '../hooks/useTelegram';
import { useOfflineQueue } from '../hooks/useOfflineQueue';
import { isLikelyNetworkError } from '../lib/networkError';
import { useErrToast } from '../lib/errToast';
import { matchesNameLike, normalizeQuery } from '../lib/searchMatch';
import { useDateFormat, useI18n, useProductName, useUnitLabel } from '../hooks/useI18n';

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
import { useStoreContext } from '../components/StoreSwitcher';
import { SearchIcon } from '../destinations/icons';

export function OrderPage() {
  const i18n = useI18n();
  const productName = useProductName();
  const dateFmt = useDateFormat();
  // 2026-07-30 (flow review): the Order surface was the ONE place still
  // rendering the raw canonical unit ("kg" / "pcs") while Approval, Run
  // and the extras editor all went through useUnitLabel. Staff saw
  // "0.5 kg" here and "0.5 公斤" on every downstream screen. Memoized by
  // locale, so passing it into the React.memo'd SkuRow is memo-safe.
  const unitLabel = useUnitLabel();
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
  /** The product whose exact quantity is being typed, and what is typed. */
  const [typing, setTyping] = useState<{ skuId: string; value: string } | null>(null);

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
  const offline = useOfflineQueue(
    {
      'order.adjustItem': async (entry) => {
        await utils.client.order.adjustItem.mutate(
          entry.input as Parameters<typeof utils.client.order.adjustItem.mutate>[0],
        );
        void utils.order.todaySession.invalidate();
      },
    },
    { onDrop: () => toast.error(i18n.t('run.toast.syncFailed')) },
  );
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
  const filteredSkus = useMemo(() => {
    // Two filters compose: category chip + cross-language search.
    // Apply category first (cheap object-key compare) then search
    // (string match across 4 lang fields + code) so we walk the
    // smaller set on the second pass.
    let out = activeCategory ? skus.filter((s) => s.categoryId === activeCategory) : skus;
    const tokens = normalizeQuery(searchQuery);
    if (tokens) {
      out = out.filter((s) =>
        matchesNameLike({ names: s.names as Record<string, string> | null, code: s.code }, tokens),
      );
    }
    return out;
  }, [skus, activeCategory, searchQuery]);

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
  const canSubmit = sessionStatus === 'draft' || sessionStatus === 'rejected';

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
    submit.mutate({ sessionId: sid }, { onSuccess: () => setReviewOpen(false) });
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
      visible: canSubmit && selectedCount > 0 && !reviewOpen,
      active: selectedCount > 0 && !submit.isPending,
    },
  );

  const onTypeQty = useCallback(
    (skuId: string, current: number) => setTyping({ skuId, value: current ? String(current) : '' }),
    [],
  );

  if (!session) return null;

  const dateLabel = dateFmt.weekdayLong(new Date());
  const heading = (title: string, chip?: React.ReactNode) => (
    <header className="flex items-start justify-between gap-lg">
      <div className="min-w-0">
        <h1 className="text-h1 text-ink">{title}</h1>
        <p className="text-body text-secondary">{dateLabel}</p>
      </div>
      {chip}
    </header>
  );

  if (!currentStoreId) {
    return (
      <div className="flex flex-col gap-xl px-page py-xl">
        {heading(i18n.t('nav.order') as string)}
        <EmptyState
          title={
            i18n.t(
              storeCtx.kind === 'none' ? 'auth.noStore.title' : 'storeSwitcher.pickPrompt.title',
            ) as string
          }
          hint={
            i18n.t(
              storeCtx.kind === 'none' ? 'auth.noStore.body' : 'storeSwitcher.pickPrompt.body',
            ) as string
          }
          action={null}
        />
      </div>
    );
  }

  const batches = batchesQuery.data ?? [];
  const batchesRow =
    batches.length > 1 ? (
      <List>
        <Row
          data-testid="order-batches"
          title={i18n.t('order.batches.today', { n: batches.length })}
          onPress={() => setBatchesOpen(true)}
        />
      </List>
    ) : null;
  const batchesSheet = (
    <Sheet
      open={batchesOpen}
      onOpenChange={setBatchesOpen}
      title={i18n.t('order.batches.today', { n: batches.length }) as string}
    >
      <BatchList
        batches={batches}
        currentId={sessionQuery.data?.id ?? ''}
        i18n={i18n}
        currency={orgCurrency}
      />
    </Sheet>
  );
  const extrasFor = (locked: boolean) =>
    sessionQuery.data?.id && sessionQuery.data.id !== 'optimistic' ? (
      <SessionExtrasEditor
        sessionId={sessionQuery.data.id}
        storeId={currentStoreId}
        // Rows saved before units were a fixed list may carry free text;
        // anything unrecognised becomes kg, which the person can change.
        initialValue={(sessionQuery.data.extras ?? []).map((r) => ({
          ...r,
          unit: (CANONICAL_UNITS as readonly string[]).includes(r.unit)
            ? (r.unit as (typeof CANONICAL_UNITS)[number])
            : 'kg',
        }))}
        isReadOnly={locked}
        onSave={async (next) => {
          if (locked) return;
          await setSessionExtras.mutateAsync({ sessionId: sessionQuery.data!.id, extras: next });
          utils.order.todaySession.setData({ storeId: currentStoreId }, (old) =>
            old ? { ...old, extras: next } : old,
          );
        }}
      />
    ) : null;

  /**
   * After sending: what was sent and where it has got to. The catalogue
   * is a tool for choosing; once the choice is made it is 240 greyed-out
   * rows. From here the order can be taken back while nobody has picked
   * it up, or another batch started.
   */
  if (isReadOnly && sessionQuery.data) {
    const locked = sessionQuery.data;
    const claimedByOther =
      !!locked.claimedByMemberId && locked.claimedByMemberId !== session.member.memberId;
    const canWithdraw = sessionStatus === 'submitted' && !claimedByOther;
    const tone: StatusTone =
      sessionStatus === 'approved' || sessionStatus === 'in_run' ? 'done' : 'pending';
    const state = claimedByOther
      ? i18n.t('order.banner.claimed', {
          who: locked.claimedByDisplayName ?? i18n.t('approval.unknownReviewer'),
        })
      : sessionStatus === 'submitted'
        ? i18n.t('order.status.submitted')
        : sessionStatus === 'approved'
          ? i18n.t('order.banner.approved.title')
          : sessionStatus === 'in_run'
            ? i18n.t('order.banner.inRun.title')
            : i18n.t('order.status.archived');
    return (
      <div className="flex flex-col gap-xl px-page py-xl">
        {heading(i18n.t('nav.order') as string)}
        <div role="status" className="flex flex-col gap-sm">
          <StatusChip tone={tone} className="self-start">
            {state}
          </StatusChip>
          {sessionStatus === 'approved' ? (
            <p className="text-body text-secondary">{i18n.t('order.banner.approved.body')}</p>
          ) : sessionStatus === 'in_run' ? (
            <p className="text-body text-secondary">{i18n.t('order.banner.inRun.body')}</p>
          ) : null}
        </div>
        {batchesRow}
        <Section title={i18n.t('order.receipt.submittedItems') as string}>
          <OrderLines totals={totals} skus={skus} productName={productName} />
        </Section>
        {extrasFor(true)}
        <List>
          <Row
            action
            data-testid="order-new-batch"
            title={i18n.t('order.batches.newBatch')}
            onPress={startNewBatch}
          />
          {canWithdraw ? (
            <Row
              data-testid="order-withdraw"
              title={i18n.t('order.withdraw')}
              disabled={withdraw.isPending}
              onPress={() => withdraw.mutate({ sessionId: locked.id })}
            />
          ) : null}
        </List>
        {batchesSheet}
      </div>
    );
  }

  const categories = categoriesQuery.data ?? [];
  const categoryName = (id: string | null): string => {
    const category = id ? categories.find((c) => c.id === id) : undefined;
    return category
      ? productName({ names: category.names as Record<string, string> })
      : (i18n.t('run.view.uncategorized') as string);
  };
  const searching = !!normalizeQuery(searchQuery);
  // Under a heading per category, unless the list has been narrowed: a
  // search or a chosen category is already the answer to "which ones".
  const groups: Array<{ id: string | null; rows: typeof filteredSkus }> = [];
  if (searching || activeCategory) {
    groups.push({ id: null, rows: filteredSkus });
  } else {
    const byCategory = new Map<string | null, typeof filteredSkus>();
    for (const sku of filteredSkus) {
      const key = categories.some((c) => c.id === sku.categoryId) ? sku.categoryId : null;
      const rows = byCategory.get(key) ?? [];
      rows.push(sku);
      byCategory.set(key, rows);
    }
    for (const c of categories) {
      const rows = byCategory.get(c.id);
      if (rows) groups.push({ id: c.id, rows });
    }
    const rest = byCategory.get(null);
    if (rest) groups.push({ id: null, rows: rest });
  }
  const typingSku = typing ? skus.find((s) => s.id === typing.skuId) : undefined;
  const typedOk = !!typing && /^\d+(?:[.,]\d+)?$/.test(typing.value.trim() || '0');

  return (
    <div className="flex flex-col gap-xl px-page py-xl">
      {heading(i18n.t('nav.order') as string)}

      {sessionStatus === 'rejected' ? (
        <div role="status" className="flex flex-col gap-sm">
          <StatusChip tone="problem" className="self-start">
            {i18n.t('order.status.rejectedTitle')}
          </StatusChip>
          <p className="text-body text-secondary">
            {sessionQuery.data?.rejectReason || i18n.t('order.status.rejectedNoReason')}
          </p>
        </div>
      ) : null}

      <div className="flex flex-col gap-lg">
        {/* The search field, as the Wise app draws one: a capsule with an
            edge, the glass at the start. */}
        <label className="flex h-control items-center gap-md rounded-pill bg-field px-lg text-secondary ring-1 ring-inset ring-secondary focus-within:ring-2 focus-within:ring-ink">
          <SearchIcon />
          <input
            type="search"
            aria-label={i18n.t('order.search.placeholder') as string}
            placeholder={i18n.t('order.search.placeholder') as string}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-full min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-secondary"
          />
        </label>
        {/* Categories as a strip of capsules, the chosen one filled dark:
            one tap to narrow, where a sheet took three. */}
        {categories.length > 1 ? (
          <div
            role="tablist"
            aria-label={i18n.t('order.categoriesAriaLabel') as string}
            className="-mx-page flex gap-sm overflow-x-auto px-page"
          >
            {[
              { id: null as string | null },
              ...categories.map((c) => ({ id: c.id as string | null })),
            ].map((c) => (
              <button
                key={c.id ?? 'all'}
                type="button"
                role="tab"
                aria-selected={activeCategory === c.id}
                data-testid="order-category"
                onClick={() => setActiveCategory(c.id)}
                className={cn(
                  'flex h-pillbtn shrink-0 items-center rounded-pill px-lg text-label outline-none active:opacity-70',
                  activeCategory === c.id ? 'bg-contrast text-on-contrast' : 'bg-surface text-ink',
                )}
              >
                {c.id ? categoryName(c.id) : i18n.t('order.categories.all')}
              </button>
            ))}
          </div>
        ) : null}
        {batches.length > 1 ? (
          <button
            type="button"
            data-testid="order-batches"
            onClick={() => setBatchesOpen(true)}
            className="flex h-chip items-center self-start rounded-pill bg-surface-sunken px-md text-caption text-ink outline-none active:opacity-60"
          >
            {i18n.t('order.batches.today', { n: batches.length })}
          </button>
        ) : null}
      </div>

      {skusQuery.isPending ? (
        <p className="text-body text-secondary">{i18n.t('common.loading')}</p>
      ) : skus.length === 0 ? (
        <EmptyState
          title={i18n.t('order.empty.title') as string}
          hint={i18n.t('order.empty.description') as string}
          action={null}
        />
      ) : filteredSkus.length === 0 ? (
        <EmptyState
          title={i18n.t('order.search.noMatches.title') as string}
          hint={i18n.t('order.search.noMatches.description') as string}
          action={
            <Button
              inline
              onClick={() => {
                setSearchQuery('');
                setActiveCategory(null);
              }}
            >
              {i18n.t('common.clear')}
            </Button>
          }
        />
      ) : (
        groups.map((group) => (
          <section key={group.id ?? 'rest'} className="flex flex-col gap-sm">
            {searching || activeCategory ? null : (
              <h2 className="text-body text-secondary">{categoryName(group.id)}</h2>
            )}
            <ul className="flex flex-col">
              {group.rows.map((sku) => (
                <SkuRow
                  key={sku.id}
                  sku={sku}
                  name={productName({ names: sku.names as Record<string, string> })}
                  myQty={myQtyBySku.get(sku.id) ?? 0}
                  totalQty={totalQtyBySku.get(sku.id) ?? 0}
                  otherContribCount={
                    (contributorsBySku.get(sku.id) ?? []).filter((c) => c.memberId !== myMemberId)
                      .length
                  }
                  storeId={currentStoreId}
                  unit={unitLabel(sku.unit)}
                  i18n={i18n}
                  onQtyChange={handleQtyChange}
                  onTypeQty={onTypeQty}
                />
              ))}
            </ul>
          </section>
        ))
      )}

      {extrasFor(false)}

      {batchesSheet}

      {/* The exact amount, for when tapping + twenty times is not it. */}
      {typing && typingSku ? (
        <Sheet
          open
          onOpenChange={(open) => !open && setTyping(null)}
          title={productName({ names: typingSku.names as Record<string, string> })}
          actions={
            <Button
              variant="primary"
              data-testid="order-qty-save"
              disabled={!typedOk}
              onClick={() => {
                const qty = Number((typing.value.trim() || '0').replace(',', '.'));
                handleQtyChange(currentStoreId, typing.skuId, String(qty));
                setTyping(null);
              }}
            >
              {i18n.t('common.save')}
            </Button>
          }
        >
          <Field
            numeric
            label={i18n.t('buy.qty') as string}
            value={typing.value}
            placeholder="0"
            onChange={(e) => setTyping({ skuId: typing.skuId, value: e.target.value })}
            suffix={unitLabel(typingSku.unit)}
          />
        </Sheet>
      ) : null}

      <Sheet
        open={reviewOpen}
        onOpenChange={(open) => !open && !submit.isPending && setReviewOpen(false)}
        title={i18n.t('order.review.title') as string}
        actions={
          <Button
            variant="primary"
            data-testid="order-submit"
            busy={submit.isPending}
            disabled={selectedCount === 0}
            onClick={() => {
              if (!sessionQuery.data) return;
              void handleSubmit();
            }}
          >
            {i18n.t('order.action.submitOrder')}
          </Button>
        }
      >
        <OrderLines totals={totals} skus={skus} productName={productName} estimate />
      </Sheet>
    </div>
  );
}

type SkuRowSku = {
  id: string;
  names: Record<string, string>;
  unit: string;
  step: string;
  suggestedQty?: string | number | null;
};

/**
 * One product in the catalogue, always with its − n + control: the owner
 * chose that over a separate first button. Most of a long catalogue is
 * zeros, so a row at zero has the control without colour, and the rows
 * with a quantity are the ones that stand out.
 *
 * Memoised: a tap rewrites the cached order, which re-renders the page,
 * and without this every one of some two hundred rows would re-render
 * with it. Every prop is a primitive or a stable reference for that reason.
 */
const SkuRow = memo(function SkuRow({
  sku,
  name,
  myQty,
  totalQty,
  otherContribCount,
  storeId,
  unit,
  i18n,
  onQtyChange,
  onTypeQty,
}: {
  sku: SkuRowSku;
  name: string;
  myQty: number;
  totalQty: number;
  otherContribCount: number;
  storeId: string;
  unit: string;
  i18n: ReturnType<typeof useI18n>;
  onQtyChange: (storeId: string, skuId: string, qty: string) => void;
  onTypeQty: (skuId: string, current: number) => void;
}) {
  const step = Number(sku.step) || 1;
  const set = (next: number) =>
    onQtyChange(storeId, sku.id, String(Math.max(0, Math.round(next * 1000) / 1000)));
  // Someone else at this store has asked for it too: say what the store's
  // total is, since "my 2" and "the store's 5" are different facts.
  const shared = otherContribCount > 0 && totalQty > 0;
  const detail = [
    sku.suggestedQty ? i18n.t('order.suggested', { qty: sku.suggestedQty }) : null,
    shared ? i18n.t('order.totalQty', { qty: formatQty(String(totalQty)), unit }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <li data-testid="order-row" className="flex min-h-row items-center gap-lg py-sm">
      <span className="min-w-0 flex-1">
        <span className="block text-label text-ink">{name}</span>
        {detail ? <span className="block text-small text-secondary">{detail}</span> : null}
      </span>
      <span className="shrink-0">
        {/* Always the whole control, the owner's choice over a separate
            button for the first tap. A product not in the order has it
            without colour and cannot go below nothing. */}
        <Stepper
          value={formatQty(String(myQty))}
          unit={unit}
          quiet={myQty === 0}
          canDecrement={myQty > 0}
          onDecrement={() => set(myQty - step)}
          onIncrement={() => set(myQty + step)}
          onValuePress={() => onTypeQty(sku.id, myQty)}
        />
      </span>
    </li>
  );
});

/** Today's batches for this person at this store, and where each has got to. */
function BatchList({
  batches,
  currentId,
  i18n,
  currency,
}: {
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
  return (
    <List>
      {batches.map((b) => (
        <Row
          key={b.id}
          data-testid="order-batch"
          title={
            b.id === currentId
              ? `${i18n.t('order.batches.batchLabel', { n: b.batchNumber })} · ${i18n.t('order.batches.viewing')}`
              : i18n.t('order.batches.batchLabel', { n: b.batchNumber })
          }
          detail={[
            i18n.t(`order.status.${b.status}` as Parameters<typeof i18n.t>[0], { reason: '' }),
            i18n.t('approval.itemsCount', { n: b.itemCount }),
          ].join(' · ')}
          value={
            b.estimatedTotal ? (
              <Money amount={formatMoney(Number(b.estimatedTotal))} currency={currency} />
            ) : undefined
          }
        />
      ))}
    </List>
  );
}

/**
 * The lines of an order, by category: what is about to be sent, and
 * afterwards what was. The same list in both places, so nothing looks
 * as if it changed on the way.
 */
function OrderLines({
  totals,
  skus,
  productName,
  estimate = false,
}: {
  totals: Array<{ skuId: string; qty: string }>;
  skus: Array<{ id: string; categoryId: string | null; names: unknown; unit: string }>;
  productName: (item: { names: Record<string, string> | null | undefined }) => string;
  /** Show what it is likely to cost, from recent prices. */
  estimate?: boolean;
}) {
  const i18n = useI18n();
  const unitLabel = useUnitLabel();
  const currency = useAuthStore((s) => s.session?.member.currency) ?? 'UZS';
  const lines = useMemo(() => totals.filter((t) => Number(t.qty) > 0), [totals]);
  const skuIds = useMemo(() => lines.map((t) => t.skuId), [lines]);
  const priceStats = trpc.catalog.skuPriceStats.useQuery(
    { skuIds },
    { enabled: estimate && skuIds.length > 0, staleTime: 60_000 },
  );
  const cost = useMemo(() => {
    const priceBySku = new Map<string, string | null>();
    for (const r of priceStats.data ?? []) priceBySku.set(r.skuId, r.lastPrice);
    let total = 0;
    let known = 0;
    for (const t of lines) {
      const price = priceBySku.get(t.skuId);
      if (!price) continue;
      total += Number(price) * Number(t.qty);
      known += 1;
    }
    return { total, known, unknown: lines.length - known };
  }, [lines, priceStats.data]);
  const skuById = useMemo(() => new Map(skus.map((s) => [s.id, s])), [skus]);

  if (lines.length === 0) {
    return <p className="text-body text-secondary">{i18n.t('order.review.empty')}</p>;
  }
  return (
    <div className="flex flex-col gap-lg">
      {/* Only lines with a recent price are in the sum, so it is a floor. */}
      {estimate && cost.known > 0 ? (
        <div className="flex flex-col gap-xs">
          <div className="flex items-baseline justify-between gap-lg">
            <span className="text-body text-secondary">
              {i18n.t('order.review.estimatedTotal')}
            </span>
            <Money amount={formatMoney(cost.total)} currency={currency} size="lg" />
          </div>
          <p className="text-body text-secondary">
            {i18n.t('order.review.estimateHint', { known: cost.known, unknown: cost.unknown })}
          </p>
        </div>
      ) : null}
      <List>
        {lines.map((t) => {
          const sku = skuById.get(t.skuId);
          return (
            <Row
              key={t.skuId}
              data-testid="order-line"
              title={
                sku
                  ? productName({ names: sku.names as Record<string, string> })
                  : t.skuId.slice(0, 8)
              }
              value={
                <span className="text-money text-ink">
                  {formatQty(t.qty)} {unitLabel(sku?.unit)}
                </span>
              }
            />
          );
        })}
      </List>
    </div>
  );
}

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
  const [rows, setRows] = useState<ExtraDraft[]>(() => initialValue.map((r) => ({ ...r })));
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
        <SectionLabel padded={false}>{i18n.t('order.extras.label')}</SectionLabel>
        <span className="text-old-label text-[var(--c-fg-muted)]">
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
              className="flex items-baseline justify-between gap-2 text-old-body"
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
          <OldButton
            size="sm"
            variant="pearl"
            onClick={addRow}
            disabled={rows.length >= 50}
            className="self-start"
          >
            {i18n.t('order.extras.add')}
          </OldButton>
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
                    className="press flex w-full items-baseline justify-between gap-2 px-3 py-1.5 text-left text-old-body hover:bg-[var(--c-surface-2)]"
                  >
                    <span className="text-[var(--c-fg)]">{s.name}</span>
                    <span className="text-old-label text-[var(--c-fg-muted)]">×{s.count}</span>
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
          onChange={(e) => onChange({ unit: e.target.value as (typeof CANONICAL_UNITS)[number] })}
          className="h-9 w-20 rounded-[var(--r-input)] bg-[var(--c-surface)] px-2 text-center text-old-body text-[var(--c-fg)] ring-hairline focus:outline-none focus:ring-2 focus:ring-[var(--c-action)]"
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
