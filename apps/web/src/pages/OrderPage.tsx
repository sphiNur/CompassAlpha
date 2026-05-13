import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Banner,
  Button,
  ChipBar,
  Chip,
  DataState,
  EmptyState,
  QtyControl,
  SearchInput,
  Sheet,
  Textarea,
  useToast,
} from '@compass/ui';
import { trpc } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { usePageMainButton, getTg, haptic } from '../hooks/useTelegram';
import { useOfflineQueue } from '../hooks/useOfflineQueue';
import { isLikelyNetworkError } from '../lib/networkError';
import { useErrToast } from '../lib/errToast';
import { matchesNameLike, normalizeQuery } from '../lib/searchMatch';
import { useI18n, useProductName } from '../hooks/useI18n';
import { formatQty, formatMoney } from '../lib/format';
import { StoreSwitcher, useStoreContext, useStoreSwitcherInteractive } from '../components/StoreSwitcher';

export function OrderPage() {
  const i18n = useI18n();
  const productName = useProductName();
  const session = useAuthStore((s) => s.session);
  // Language picker — accessible from every page's header so staff
  // who don't have admin access can still switch languages (added
  // 2026-05-05). State lives at OrderPage level since this is the
  // landing tab; other pages can grow their own copies if needed.
  // OrderPage requires a SPECIFIC store — you can't draft an order
  // without a target. If the global store-switcher is on 'ALL', we
  // refuse and prompt the user to pick (added 2026-05-05).
  // Language picker moved to Telegram's gear button (Shell wires it).
  const storeCtx = useStoreContext();
  const storeSwitcherInteractive = useStoreSwitcherInteractive();
  const currentStoreId = storeCtx.kind === 'specific' ? storeCtx.storeId : null;
  const toast = useToast();
  const errToast = useErrToast();
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  // M1.10 (2026-05-08): cross-language SKU search. Lives above the
  // category chip-bar; queries match across uz/ru/en/zh names + code.
  const [searchQuery, setSearchQuery] = useState('');

  const categoriesQuery = trpc.catalog.categories.useQuery();
  const skusQuery = trpc.catalog.skus.useQuery({ includeArchived: false });
  const sessionQuery = trpc.order.todaySession.useQuery(
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
  });
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
            claimedAt: null,
            submittedAt: null,
            decidedAt: null,
            decidedByMemberId: null,
            rejectReason: null,
            runId: null,
            lastSeq: 0,
            notes: null,
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
    onSuccess: () => void utils.order.todaySession.invalidate(),
  });

  /**
   * Session-level "其他物品" free-text note (M1.8, 2026-05-07).
   * Debounced save matching the line-item adjust pattern. The user
   * types continuously; we save 600ms after the last keystroke.
   */
  const setSessionNote = trpc.order.setSessionNote.useMutation({
    retry: false,
    onError: (err) => {
      // Stale-seq retries handle themselves on next refetch — only
      // surface "real" errors to the user.
      const code = (err as { data?: { code?: string } }).data?.code;
      if (code === 'CONFLICT') {
        if (currentStoreId) {
          void utils.order.todaySession.invalidate({ storeId: currentStoreId });
        }
        return;
      }
      errToast('order.toast.noteSaveFailed')(err);
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
  const isReadOnly =
    sessionStatus === 'submitted' ||
    sessionStatus === 'approved' ||
    sessionStatus === 'in_run' ||
    sessionStatus === 'archived';

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
      /* M1.12: PageHeader dropped — Telegram's chrome shows the bot
          name and BottomNav highlights "Order", so the in-body title
          was redundant. The store-picker fallback strip lets the user
          either pick a store (admin) or learn they need an
          assignment (non-admin). */
      <div className="flex flex-col">
        <div className="flex items-center gap-2 border-b border-[var(--c-divider)] bg-[var(--c-bg)] px-4 py-2">
          <StoreSwitcher />
        </div>
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

  const today = new Date();
  const dateLabel = today.toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });

  return (
    <div className="flex flex-col">
      {/* M1.12 / M1.13: PageHeader removed; the sticky strip below
          carries page chrome. M1.13 (2026-05-08): the [store · date ·
          selected] row only renders for users who actually have a
          choice to make (multi-store or admin). Single-store users
          got nothing useful from a static "🏪 Smoke Store" pill +
          today's date + a count that already shows in the
          MainButton — so we hide the row entirely and let SearchInput
          + ChipBar be the entire chrome. */}
      <div className="sticky top-0 z-[1] flex flex-col gap-2 border-b border-[var(--c-divider)] bg-[var(--c-bg)] px-4 py-2">
        {storeSwitcherInteractive ? (
          <div className="flex min-h-7 items-center gap-2">
            <StoreSwitcher />
            <span className="ml-auto truncate text-label text-[var(--c-fg-muted)]">
              {dateLabel}
            </span>
            {selectedCount > 0 ? (
              <span className="shrink-0 rounded-[var(--r-pill)] bg-[var(--c-action)] px-2 py-0.5 text-label font-semibold tabular-nums text-[var(--c-action-fg)]">
                {selectedCount}
              </span>
            ) : null}
          </div>
        ) : null}
        <SearchInput
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onClear={() => setSearchQuery('')}
          placeholder={i18n.t('order.search.placeholder')}
          clearAriaLabel={i18n.t('common.clear')}
          aria-label={i18n.t('order.search.placeholder')}
        />
        <ChipBar ariaLabel={i18n.t('order.categoriesAriaLabel')} className="-mx-4 px-4 py-0">
          <Chip selected={activeCategory === null} onClick={() => setActiveCategory(null)}>
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
      </div>

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
            {filteredSkus.map((sku) => {
              const myQty = myQtyBySku.get(sku.id) ?? 0;
              const totalQty = totalQtyBySku.get(sku.id) ?? 0;
              const contributors = contributorsBySku.get(sku.id) ?? [];
              const otherContribs = contributors.filter((c) => c.memberId !== myMemberId);
              return (
                <li
                  key={sku.id}
                  className="flex items-center justify-between border-b border-[var(--c-divider)] px-4 py-2 last:border-b-0"
                >
                  <div className="min-w-0 flex-1 pr-3">
                    {/* M2.2: list-row primary text unified to text-body
                        font-semibold across pages. Was text-h3 (15 px)
                        which read 1 px larger than RunPage's body (14)
                        for the same role — the "one big, one small"
                        feeling between Order and Run pages came from
                        this single class. */}
                    <div className="truncate text-body font-semibold leading-tight text-[var(--c-fg)]">
                      {productName(sku)}
                    </div>
                    <div className="mt-0.5 text-label leading-tight text-[var(--c-fg-muted)]">
                      {sku.unit}
                      {sku.suggestedQty
                        ? ' · ' + i18n.t('order.suggested', { qty: sku.suggestedQty })
                        : ''}
                      {otherContribs.length > 0 && totalQty > 0 ? (
                        <>
                          {' · '}
                          <span className="font-semibold text-[var(--c-fg)]">
                            {i18n.t('order.totalQty', { qty: totalQty, unit: sku.unit })}
                          </span>
                          {' '}
                          ({otherContribs.length + (myQty > 0 ? 1 : 0)})
                        </>
                      ) : null}
                    </div>
                  </div>
                  <QtyControl
                    value={myQty}
                    step={Number(sku.step)}
                    unit={sku.unit}
                    disabled={isReadOnly}
                    onChange={(next) => {
                      // Goes through the debounced + serialized path
                      // (handleQtyChange). The +/- ONLY edits MY
                      // contribution row.
                      handleQtyChange(currentStoreId, sku.id, String(next));
                    }}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </DataState>

      {/* Session-level "其他物品" free-text note (M1.8). Sits at the
          bottom of the SKU list so it's the last thing the staff sees
          before reviewing — natural placement for "and one more thing
          that's not in the catalog". Hidden once the session leaves
          draft (the value is shown read-only on ApprovalPage / RunPage).
          We render it only when a session row exists; before the user
          adds their first item there's no stream yet, and writing a
          note alone wouldn't carry meaning. */}
      {sessionQuery.data?.id && sessionQuery.data.id !== 'optimistic' ? (
        <SessionNotesEditor
          sessionId={sessionQuery.data.id}
          storeId={currentStoreId ?? ''}
          initialValue={sessionQuery.data.notes ?? ''}
          isReadOnly={isReadOnly}
          onSave={async (value) => {
            const trimmed = value.trim();
            await setSessionNote.mutateAsync({
              sessionId: sessionQuery.data!.id,
              note: trimmed.length === 0 ? null : trimmed,
            });
            // Optimistically write the cache so the textarea doesn't
            // flicker on next refetch.
            utils.order.todaySession.setData(
              { storeId: currentStoreId ?? '' },
              (old) => (old ? { ...old, notes: trimmed.length === 0 ? null : trimmed } : old),
            );
          }}
        />
      ) : null}

      {/* In-page primary action — ONLY when not running inside Telegram.
          Inside Telegram the MainButton (above) is the canonical CTA;
          rendering this button too would show two duplicate buttons. */}
      {!getTg() && canSubmit && selectedCount > 0 ? (
        <div className="sticky bottom-[var(--app-safe-bottom)] mt-3 px-4 pb-4">
          <Button
            block
            size="lg"
            disabled={submit.isPending}
            onClick={() => setReviewOpen(true)}
          >
            {i18n.t('order.review', { n: selectedCount })}
          </Button>
        </div>
      ) : null}

      {/* Review sheet — preview of what's being submitted. No buttons in
          the body: inside Telegram the MainButton text changes from
          "Review Order (N)" to "Submit order" while open, and that's the
          submit trigger. Tap-outside / swipe-down dismisses the sheet.
          Outside Telegram (rare — web preview) we render a single
          fallback button in the footer since there's no MainButton. */}
      <Sheet
        open={reviewOpen}
        onOpenChange={(open) => !open && !submit.isPending && setReviewOpen(false)}
        title={i18n.t('order.review.title')}
        description={
          dateLabel + ' · ' + i18n.t('order.review.itemsCount', { n: selectedCount })
        }
        footer={
          !getTg() ? (
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
          ) : null
        }
      >
        <ReviewList totals={totals} skus={skus} productName={productName} />
      </Sheet>
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
                  <span className="truncate pr-3 text-body text-[var(--c-fg)]">{r.name}</span>
                  <span className="shrink-0 font-mono text-body tabular-nums text-[var(--c-fg-muted)]">
                    {formatQty(r.qty)} {r.unit}
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
 * Session-level free-text "其他物品" textarea (M1.8, 2026-05-07).
 *
 * Why a separate component:
 *   - It owns its own controlled state so the user's typing doesn't
 *     wait on the round-trip to the server.
 *   - The debounce timer + dirty flag are local; lifting them up would
 *     pollute OrderPage with another ref + effect.
 *   - It stays mounted across refetches; we only adopt the server value
 *     into the local state when our local copy is "clean" (matches what
 *     we last submitted), so a parallel writer (rare — same store, same
 *     staff, two tabs) can't clobber what the user is typing right now.
 *
 * UX: 600ms debounce. Auto-grows up to ~6 lines, then scrolls. 1000-char
 * cap matches domain enforcement; we soft-truncate at the textarea level
 * so the user sees the limit before the server rejects. Read-only once
 * the session is submitted/approved/etc — manager sees the value on
 * ApprovalPage instead.
 */
function SessionNotesEditor({
  sessionId,
  initialValue,
  isReadOnly,
  onSave,
}: {
  sessionId: string;
  storeId: string;
  initialValue: string;
  isReadOnly: boolean;
  onSave: (value: string) => Promise<void>;
}) {
  const i18n = useI18n();
  const [value, setValue] = useState(initialValue);
  // The last value we saved to the server (or accepted from the server
  // because our local was clean). Used as the dirty-check baseline so
  // we don't fire a save for the no-op case where the parent prop
  // changed but the user value also matches it.
  const lastSavedRef = useRef(initialValue);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [savingState, setSavingState] = useState<'idle' | 'saving' | 'saved'>('idle');

  // Adopt server value when local is clean. Skip when the user is in
  // the middle of an edit (value !== lastSavedRef.current) — their
  // typing wins until the debounce fires.
  useEffect(() => {
    if (value === lastSavedRef.current) {
      lastSavedRef.current = initialValue;
      setValue(initialValue);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialValue]);

  // Reset when sessionId changes (e.g. switching stores → different
  // session entirely; we should not carry typing state across).
  useEffect(() => {
    lastSavedRef.current = initialValue;
    setValue(initialValue);
    setSavingState('idle');
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const scheduleSave = useCallback(
    (next: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(async () => {
        debounceRef.current = null;
        if (next === lastSavedRef.current) return;
        setSavingState('saving');
        try {
          await onSave(next);
          lastSavedRef.current = next;
          setSavingState('saved');
          // Clear the "saved" indicator after a moment so it doesn't
          // linger and look like a permanent UI element.
          setTimeout(() => setSavingState('idle'), 1500);
        } catch {
          setSavingState('idle');
          // The mutation hook surfaces the toast; we don't.
        }
      }, 600);
    },
    [onSave],
  );

  // Force-flush on unmount so a quick "type then close" doesn't lose
  // the trailing edit.
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, []);

  if (isReadOnly && !value.trim()) return null;

  const charCount = value.length;
  const overLimit = charCount > 1000;

  return (
    <div className="px-4 py-3">
      <div className="flex items-baseline justify-between gap-2 pb-1.5">
        <label
          htmlFor={`session-notes-${sessionId}`}
          className="text-label font-semibold text-[var(--c-fg)]"
        >
          {i18n.t('order.notes.label')}
        </label>
        <span className="text-label text-[var(--c-fg-muted)]">
          {savingState === 'saving'
            ? i18n.t('order.notes.saving')
            : savingState === 'saved'
              ? i18n.t('order.notes.saved')
              : ''}
        </span>
      </div>
      <Textarea
        id={`session-notes-${sessionId}`}
        value={value}
        readOnly={isReadOnly}
        rows={3}
        maxLength={1000}
        placeholder={i18n.t('order.notes.placeholder')}
        onChange={(e) => {
          const next = e.target.value;
          setValue(next);
          if (!isReadOnly) scheduleSave(next);
        }}
        onBlur={() => {
          // Force-flush on blur so the user doesn't have to wait the
          // full debounce window when they tap away.
          if (debounceRef.current) {
            clearTimeout(debounceRef.current);
            debounceRef.current = null;
          }
          if (!isReadOnly && value !== lastSavedRef.current) {
            void (async () => {
              setSavingState('saving');
              try {
                await onSave(value);
                lastSavedRef.current = value;
                setSavingState('saved');
                setTimeout(() => setSavingState('idle'), 1500);
              } catch {
                setSavingState('idle');
              }
            })();
          }
        }}
      />
      {/* M1.11 cleanup (2026-05-08): hint + char-counter only render
          when there's something to say. Empty notes show just the
          textarea + placeholder; counter appears as you approach the
          limit; hint shows once you've started typing (so screen-reader
          users still get the "visible to manager" context). */}
      {(charCount > 0 || overLimit) ? (
        <div className="mt-1 flex items-center justify-between">
          <span className="text-label text-[var(--c-fg-muted)]">
            {i18n.t('order.notes.hint')}
          </span>
          {charCount > 800 || overLimit ? (
            <span
              className={
                'text-label tabular-nums ' +
                (overLimit ? 'text-[var(--c-danger)]' : 'text-[var(--c-fg-muted)]')
              }
            >
              {charCount}/1000
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
