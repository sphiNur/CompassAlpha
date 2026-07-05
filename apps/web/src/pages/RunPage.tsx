/**
 * RunPage — purchaser cockpit.
 *
 * Stages and reversibility (designed 2026-05-03):
 *   - planned     : show preview, "Start purchase" via Telegram MainButton.
 *                   Header ⋯ menu lets you cancel the entire run.
 *   - purchasing  : per-item Buy / N/A; multi-store split sheet on Buy.
 *                   Already-purchased rows: ⋯ menu → Edit (RevisePurchase).
 *                   Already-unavailable rows: ⋯ menu → Mark available again.
 *                   Header ⋯ menu: Cancel run · Back to plan (only allowed
 *                   when nothing has been bought / marked).
 *   - delivering  : per-store Deliver button.
 *                   Already-delivered rows that haven't been confirmed yet:
 *                   ⋯ menu → Recall delivery.
 *                   Header ⋯ menu: Cancel run · Back to purchase (only when
 *                   no store has been delivered to yet).
 *                   Finish via MainButton when all confirmed (with summary
 *                   confirm sheet).
 *   - finished / cancelled : terminal.
 *
 * EVERY forward step now goes through a ConfirmSheet first. The previous
 * implementation fired mutations on first tap with no confirmation; a
 * single mis-tap could lock the run, mis-deliver to a store, or finalize
 * the entire run. The user explicitly asked for "an opportunity to change
 * your mind at every step." Each ConfirmSheet shows what will happen and,
 * for backwards-incompatible operations, asks for a free-text reason that
 * goes into the audit log.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardHeader,
  CardTitle,
  Chip,
  ChipBar,
  DataState,
  EmptyState,
  Input,
  SectionLabel,
  Sheet,
  useToast,
} from '@compass/ui';
import { trpc, newIdempotencyKey } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { usePageMainButton, haptic, getTg } from '../hooks/useTelegram';
import { useI18n, useProductName } from '../hooks/useI18n';
import { usePhotoUploader } from '../hooks/usePhotoUploader';
// M3.5: StoreSwitcher pill removed from page chrome; picker lives in
// SettingsSheet now. RunPage still uses useStoreContext indirectly
// through other paths if needed.
import { usePageMenu } from '../app/PageMenuContext';
import { useOfflineQueue } from '../hooks/useOfflineQueue';
import { isLikelyNetworkError } from '../lib/networkError';
import { useErrToast } from '../lib/errToast';
import { formatQty, formatMoney } from '../lib/format';
import { shareLink } from '../lib/telegramLinks';
// Run money math — extracted to pages/runs/lib (Phase 4 step 1, unit-tested).
import { splitPaymentMethod, splitSubtotal, settleItemLine } from './runs/lib/settlement';
// History subsystem — extracted to runs/history (Phase 4 step 2).
import {
  RunHistorySection,
  RunHistoryPage,
  RunHistoryDetailSheet,
  type HistoryDetailTarget,
} from './runs/history/RunHistory';
// Mutation sheets + draft types — extracted to runs/sheets (Phase 4 step 3).
import {
  PurchaseSheet,
  AddItemSheet,
  ConfirmSheet,
  type PurchaseDraft,
  type AddItemDraft,
} from './runs/sheets/RunSheets';
// Grouped views + row leaf — extracted to runs/views (Phase 4 step 4).
import {
  PerStoreView,
  PerVendorView,
  PerCategoryView,
  RunExtrasCard,
  ExpensesCard,
  PurchaseRow,
} from './runs/views/RunViews';
import type { ActiveRun } from './runs/types';

function newClientId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** A pending reason-prompt confirm. The keys here are the ONLY transitions
 *  that need a confirmation; trivial actions (Buy, mark N/A) keep their
 *  existing inline sheets. */
type ConfirmKind =
  | 'startPurchase'
  | 'startDelivery'
  | 'finish'
  | 'cancel'
  | 'undoStartPurchase'
  | 'undoStartDelivery'
  | { kind: 'deliverStore'; storeId: string; storeName: string }
  | { kind: 'recallDelivery'; storeId: string; storeName: string }
  | { kind: 'unmarkUnavailable'; skuId: string; skuName: string }
  | { kind: 'undoPurchase'; skuId: string; skuName: string }
  | { kind: 'ejectSession'; sessionId: string; storeName: string; submitterName: string };

export function RunPage() {
  const i18n = useI18n();
  const productName = useProductName();
  const session = useAuthStore((s) => s.session);
  const toast = useToast();
  const photoUploader = usePhotoUploader('receipt');

  const [createOpen, setCreateOpen] = useState(false);
  const [purchaseDraft, setPurchaseDraft] = useState<PurchaseDraft | null>(null);
  const [inlineSavingSkuId, setInlineSavingSkuId] = useState<string | null>(null);
  // M3.41 (2026-05-21): purchaser-initiated mid-run additions. Distinct
  // from `purchaseDraft` because the workflow is different — picking a
  // SKU that's NOT in the run (vs. recording a buy for a planned row),
  // requiring a free-text reason for audit, and submitting via the new
  // `run.addPurchaserItem` mutation instead of purchaseItem/revisePurchase.
  const [addItemDraft, setAddItemDraft] = useState<AddItemDraft | null>(null);
  // M3.36 (2026-05-19): page-level "thousands input" toggle.
  // Default ON — UZS pricing is the launch tenant's currency and
  // operators consistently type 5-6 digit prices. Persist per-user
  // via localStorage so the preference survives page navigation.
  const [priceInThousands, setPriceInThousandsState] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('compass.run.priceInThousands');
      if (saved === '0') return false;
      if (saved === '1') return true;
    } catch {
      /* localStorage disabled / quota — non-fatal */
    }
    return true;
  });
  const togglePriceInThousands = useCallback(() => {
    setPriceInThousandsState((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('compass.run.priceInThousands', next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);
  const [unavailableFor, setUnavailableFor] = useState<{ runId: string; skuId: string } | null>(
    null,
  );
  const [unavailableNote, setUnavailableNote] = useState('');
  const [confirmAction, setConfirmAction] = useState<ConfirmKind | null>(null);
  const [confirmReason, setConfirmReason] = useState('');
  // Drill-down for a historical run.
  const [historyDetailFor, setHistoryDetailFor] = useState<HistoryDetailTarget | null>(null);
  const [historyPageOpen, setHistoryPageOpen] = useState(false);

  const previewQuery = trpc.run.previewCreatable.useQuery({});
  const runsQuery = trpc.run.list.useQuery();
  const fullHistoryQuery = trpc.run.history.useQuery(
    { limit: 500 },
    { enabled: historyPageOpen },
  );
  const skusQuery = trpc.catalog.skus.useQuery({ includeArchived: false });
  const categoriesQuery = trpc.catalog.categories.useQuery();
  const storesQuery = trpc.catalog.stores.useQuery();
  const suppliersQuery = trpc.catalog.suppliers.useQuery();
  const expenseTemplatesQuery = trpc.run.expenseTemplates.useQuery(undefined, {
    enabled:
      !!session &&
      (session.permissions.includes('run.purchase') ||
        session.permissions.includes('users.manage') ||
        session.permissions.includes('org.admin')),
  });

  const utils = trpc.useUtils();
  const invalidateRunQuietly = useCallback(
    (includeList = false) => {
      setTimeout(() => {
        void utils.run.get.invalidate();
        if (includeList) void utils.run.list.invalidate();
      }, 650);
    },
    [utils],
  );
  const offline = useOfflineQueue({
    'run.purchaseItem': async (entry) => {
      // H2: replay with the SAME idempotency key the first attempt used, so
      // a request the server already committed (lost response) dedupes.
      await utils.client.run.purchaseItem.mutate(
        entry.input as Parameters<typeof utils.client.run.purchaseItem.mutate>[0],
        entry.idempotencyKey ? { context: { idempotencyKey: entry.idempotencyKey } } : undefined,
      );
      void utils.run.get.invalidate();
      void utils.run.list.invalidate();
    },
    'run.markUnavailable': async (entry) => {
      await utils.client.run.markUnavailable.mutate(
        entry.input as Parameters<typeof utils.client.run.markUnavailable.mutate>[0],
      );
      void utils.run.get.invalidate();
    },
    'run.deliverToStore': async (entry) => {
      await utils.client.run.deliverToStore.mutate(
        entry.input as Parameters<typeof utils.client.run.deliverToStore.mutate>[0],
      );
      void utils.run.get.invalidate();
      void utils.run.list.invalidate();
    },
    // M3.41 (2026-05-21): purchaser-added items survive flaky bazaar
    // LTE just like regular purchases.
    'run.addPurchaserItem': async (entry) => {
      await utils.client.run.addPurchaserItem.mutate(
        entry.input as Parameters<typeof utils.client.run.addPurchaserItem.mutate>[0],
      );
      void utils.run.get.invalidate();
      void utils.run.list.invalidate();
    },
    // M3.44 (2026-05-22): off-catalog expenses. Same retry pattern.
    'run.addExpense': async (entry) => {
      await utils.client.run.addExpense.mutate(
        entry.input as Parameters<typeof utils.client.run.addExpense.mutate>[0],
      );
      void utils.run.get.invalidate();
      void utils.run.list.invalidate();
    },
  }, { onDrop: () => toast.error(i18n.t('run.toast.syncFailed')) });

  // ---- Mutations ------------------------------------------------------
  // M1.9 (2026-05-07): hoisted into `lib/errToast.ts` so the same
  // translation logic doesn't live in 3 different pages with subtly
  // different shapes. Server-side TRPCError uses i18n keys like
  // `run.errors.runFrozen` as `message`; the helper translates them
  // and falls back to the caller-provided key on raw / unknown
  // strings.
  const errToast = useErrToast();
  const create = trpc.run.create.useMutation({
    onSuccess: () => {
      void utils.run.list.invalidate();
      void utils.run.previewCreatable.invalidate();
      setCreateOpen(false);
      haptic('success');
      toast.success(i18n.t('run.toast.runPlanned'));
    },
    onError: errToast('run.toast.couldNotPlan'),
  });
  const attachSessions = trpc.run.attachSessions.useMutation({
    onSuccess: () => {
      void utils.run.get.invalidate();
      void utils.run.previewCreatable.invalidate();
      void utils.run.list.invalidate();
      haptic('success');
      toast.success(i18n.t('run.toast.sessionsAttached'));
    },
    onError: errToast('run.toast.couldNotAttach'),
  });
  const startPurchase = trpc.run.startPurchase.useMutation({
    onSuccess: () => {
      void utils.run.list.invalidate();
      // M1.9-fix (2026-05-07): success feedback was missing on
      // startPurchase / startDelivery — the screen visually changed
      // but no toast/haptic, which on slow networks looked like a
      // double-tap had registered. Mirrors the pattern used by every
      // other run mutation.
      haptic('success');
      toast.success(i18n.t('run.toast.purchaseStarted'));
    },
    onError: errToast('common.error'),
  });
  // M3.41 (2026-05-21): mid-run addition. Mirrors purchaseItem's
  // success/offline-queue pattern so the bazaar UX (flaky LTE) survives
  // a network drop mid-add. Idempotent at the API layer via
  // X-Idempotency-Key so replays don't double-buy.
  const addPurchaserItem = trpc.run.addPurchaserItem.useMutation({
    onSuccess: () => {
      invalidateRunQuietly(true);
      setAddItemDraft(null);
      haptic('success');
      toast.success(i18n.t('run.toast.itemAdded'));
    },
    onError: (err, vars) => {
      if (isLikelyNetworkError(err)) {
        void offline.enqueue('run.addPurchaserItem', vars);
        setAddItemDraft(null);
        toast.info(i18n.t('run.toast.purchaseSavedOffline'));
      } else {
        errToast('run.toast.couldNotAddItem')(err);
      }
    },
  });
  // M3.44 (2026-05-22): off-catalog expense add + remove. Same
  // optimistic + offline-queue pattern as the SKU-item path so the
  // bazaar UX is consistent across modes.
  const addExpense = trpc.run.addExpense.useMutation({
    onSuccess: () => {
      invalidateRunQuietly(true);
      setAddItemDraft(null);
      haptic('success');
      toast.success(i18n.t('run.toast.expenseAdded'));
    },
    onError: (err, vars) => {
      if (isLikelyNetworkError(err)) {
        void offline.enqueue('run.addExpense', vars);
        setAddItemDraft(null);
        toast.info(i18n.t('run.toast.purchaseSavedOffline'));
      } else {
        errToast('run.toast.couldNotAddExpense')(err);
      }
    },
  });
  const removeExpense = trpc.run.removeExpense.useMutation({
    onSuccess: () => {
      invalidateRunQuietly();
      haptic('success');
      toast.info(i18n.t('run.toast.expenseRemoved'));
    },
    onError: errToast('common.error'),
  });
  const ejectSession = trpc.run.ejectSession.useMutation({
    onSuccess: () => {
      void utils.run.get.invalidate();
      void utils.run.list.invalidate();
      void utils.run.previewCreatable.invalidate();
      void utils.order.todaySession.invalidate();
      void utils.order.pendingList.invalidate();
      haptic('success');
      toast.success(i18n.t('run.toast.sessionEjected'));
    },
    onError: errToast('run.toast.couldNotEjectSession'),
  });
  // H2: one stable idempotency key per purchase, shared between the first
  // attempt (sent via trpc.context → httpLink header) and any offline
  // replay (stored on the outbox entry). onMutate runs before the request
  // is built, so the header picks up the key; the app's mutation-in-flight
  // guard serialises purchases, so the shared context object can't be
  // clobbered by a concurrent one.
  const purchaseIdemCtx = useRef<{ idempotencyKey?: string }>({}).current;
  const purchaseItem = trpc.run.purchaseItem.useMutation({
    trpc: { context: purchaseIdemCtx },
    onMutate: () => {
      const idempotencyKey = newIdempotencyKey();
      purchaseIdemCtx.idempotencyKey = idempotencyKey;
      return { idempotencyKey };
    },
    onSuccess: () => {
      invalidateRunQuietly(true);
      setPurchaseDraft(null);
      haptic('success');
      toast.success(i18n.t('run.toast.purchaseRecorded'));
    },
    onError: (err, vars, ctx) => {
      setInlineSavingSkuId((cur) => (cur === vars.skuId ? null : cur));
      if (isLikelyNetworkError(err)) {
        const key = (ctx as { idempotencyKey?: string } | undefined)?.idempotencyKey;
        void offline.enqueue('run.purchaseItem', vars, key);
        setPurchaseDraft(null);
        toast.info(i18n.t('run.toast.purchaseSavedOffline'));
      } else {
        errToast('run.toast.couldNotSavePurchase')(err);
      }
    },
  });
  const revisePurchase = trpc.run.revisePurchase.useMutation({
    onSuccess: () => {
      invalidateRunQuietly();
      setPurchaseDraft(null);
      haptic('success');
      toast.success(i18n.t('run.toast.purchaseRevised'));
    },
    onError: errToast('run.toast.couldNotSavePurchase'),
  });
  const markUnavailable = trpc.run.markUnavailable.useMutation({
    onSuccess: () => {
      invalidateRunQuietly();
      setUnavailableFor(null);
      setUnavailableNote('');
      toast.info(i18n.t('run.toast.markedUnavailable'));
    },
    onError: (err, vars) => {
      if (isLikelyNetworkError(err)) {
        void offline.enqueue('run.markUnavailable', vars);
        setUnavailableFor(null);
        setUnavailableNote('');
        toast.info(i18n.t('run.toast.purchaseSavedOffline'));
      } else {
        errToast('common.error')(err);
      }
    },
  });
  const unmarkUnavailable = trpc.run.unmarkUnavailable.useMutation({
    onSuccess: () => {
      invalidateRunQuietly();
      haptic('success');
      toast.success(i18n.t('run.toast.unmarkedUnavailable'));
    },
    onError: errToast('common.error'),
  });
  const undoPurchase = trpc.run.undoPurchase.useMutation({
    onSuccess: () => {
      invalidateRunQuietly();
      haptic('success');
      toast.success(i18n.t('run.toast.purchaseUndone'));
    },
    onError: errToast('common.error'),
  });
  const startDelivery = trpc.run.startDelivery.useMutation({
    onSuccess: () => {
      invalidateRunQuietly(true);
      haptic('success');
      toast.success(i18n.t('run.toast.deliveryStarted'));
    },
    onError: errToast('common.error'),
  });
  const deliverToStore = trpc.run.deliverToStore.useMutation({
    onSuccess: () => {
      invalidateRunQuietly(true);
    },
    onError: (err, vars) => {
      if (isLikelyNetworkError(err)) {
        void offline.enqueue('run.deliverToStore', vars);
        toast.info(i18n.t('run.toast.purchaseSavedOffline'));
      } else {
        errToast('common.error')(err);
      }
    },
  });
  const undeliverStore = trpc.run.undeliverStore.useMutation({
    onSuccess: () => {
      invalidateRunQuietly(true);
      haptic('success');
      toast.success(i18n.t('run.toast.deliveryRecalled'));
    },
    onError: errToast('common.error'),
  });
  const undoStartPurchase = trpc.run.undoStartPurchase.useMutation({
    onSuccess: () => {
      invalidateRunQuietly(true);
      haptic('success');
      toast.success(i18n.t('run.toast.startPurchaseUndone'));
    },
    onError: errToast('common.error'),
  });
  const undoStartDelivery = trpc.run.undoStartDelivery.useMutation({
    onSuccess: () => {
      invalidateRunQuietly(true);
      haptic('success');
      toast.success(i18n.t('run.toast.startDeliveryUndone'));
    },
    onError: errToast('common.error'),
  });
  const cancelRun = trpc.run.cancel.useMutation({
    onSuccess: (result) => {
      void utils.run.list.invalidate();
      void utils.run.get.invalidate();
      // Wave2 #15 (M3.40, 2026-05-20): the server returns
      // `ejectionFailures: [{ sessionId, reason }]` for any session
      // that couldn't be released cleanly during the cancel cascade.
      // Pre-M3.40 the FE silently showed a success toast and the
      // operator never learned about the orphaned sessions. Now: if
      // anything failed, show a warning. The worker's repair sweep
      // will pick those up within the next CLAIM_TIMEOUT_SCAN_MS, so
      // we tell the operator "they'll be auto-released shortly".
      const failures = result?.ejectionFailures?.length ?? 0;
      if (failures > 0) {
        haptic('warning');
        toast.info(
          i18n.t('run.toast.runCancelledWithOrphans', { n: failures }),
        );
      } else {
        haptic('success');
        toast.success(i18n.t('run.toast.runCancelled'));
      }
    },
    onError: errToast('common.error'),
  });
  const finish = trpc.run.finish.useMutation({
    onSuccess: () => {
      void utils.run.list.invalidate();
      haptic('success');
      toast.success(i18n.t('run.toast.runFinished'));
    },
    onError: errToast('common.error'),
  });
  // M3.37 (2026-05-19, Wave2 #5): purchaser cycles an extra row's
  // outcome (pending → bought → unavailable → pending). One mutation
  // call per tap — the row is small, payload tiny, and the realtime
  // run.changed pubsub feeds a coarse refetch so the new status lands
  // before the next user input even on slow networks. No offline
  // queue: an unmarked extra is functionally identical to "pending",
  // so re-queueing on flaky reconnects would create more confusion
  // than it would resolve.
  const markExtraStatus = trpc.order.markExtraStatus.useMutation({
    onSuccess: () => {
      invalidateRunQuietly();
      haptic('success');
    },
    onError: errToast('common.error'),
  });
  // C.2 (M3.38, 2026-05-19): run-level claim mutations. Auto-claim on
  // RunPage mount (purchasing/delivering only); auto-release on
  // visibilitychange (best-effort, worker sweep is the safety net).
  // Take-over button on the "claimed by other" banner sends
  // releaseClaim — the server detects cross-claim and re-tags the
  // event with reason='override'.
  const claimRun = trpc.run.claim.useMutation({
    onSuccess: () => {
      void utils.run.get.invalidate();
    },
    // Silent on most errors — auto-claim races (another purchaser
    // grabbed it ~10ms after we mounted) shouldn't toast. Conflict
    // errors are expected during the race window.
    onError: () => {
      void utils.run.get.invalidate();
    },
  });
  const releaseRunClaim = trpc.run.releaseClaim.useMutation({
    onSuccess: () => {
      void utils.run.get.invalidate();
    },
    onError: errToast('common.error'),
  });

  // ---- Derived state --------------------------------------------------
  const skuById = useMemo(() => {
    const m = new Map<
      string,
      { id: string; names: Record<string, string>; unit: string; step: string; categoryId: string | null }
    >();
    for (const sku of skusQuery.data ?? []) {
      m.set(sku.id, {
        id: sku.id,
        names: sku.names as Record<string, string>,
        unit: sku.unit,
        step: sku.step,
        categoryId: sku.categoryId ?? null,
      });
    }
    return m;
  }, [skusQuery.data]);

  const categoryById = useMemo(() => {
    const m = new Map<string, { id: string; names: Record<string, string> }>();
    for (const category of categoriesQuery.data ?? []) {
      m.set(category.id, { id: category.id, names: category.names as Record<string, string> });
    }
    return m;
  }, [categoriesQuery.data]);

  const storeById = useMemo(() => {
    const m = new Map<string, { id: string; name: string; code: string | null }>();
    for (const store of storesQuery.data ?? []) m.set(store.id, store);
    return m;
  }, [storesQuery.data]);

  const activeRun = useMemo(
    () =>
      runsQuery.data?.find((r) => r.status !== 'finished' && r.status !== 'cancelled') ?? null,
    [runsQuery.data],
  );

  const runDetailQuery = trpc.run.get.useQuery(
    activeRun ? { runId: activeRun.id } : { runId: '' },
    { enabled: !!activeRun, refetchInterval: activeRun ? 6_000 : false },
  );

  useEffect(() => {
    if (!inlineSavingSkuId) return;
    const item = runDetailQuery.data?.items.find((it) => it.skuId === inlineSavingSkuId);
    if (!item || item.status !== 'pending') {
      setInlineSavingSkuId(null);
      return;
    }
    if (purchaseItem.isPending) return;
    const t = setTimeout(() => {
      setInlineSavingSkuId((cur) => (cur === inlineSavingSkuId ? null : cur));
    }, 5_000);
    return () => clearTimeout(t);
  }, [inlineSavingSkuId, purchaseItem.isPending, runDetailQuery.data?.items]);

  const allItemsHandled = useMemo(() => {
    const items = runDetailQuery.data?.items ?? [];
    return (
      items.length > 0 &&
      items.every((i) => i.status === 'purchased' || i.status === 'unavailable')
    );
  }, [runDetailQuery.data]);

  const allStoresConfirmed = useMemo(() => {
    if (!runDetailQuery.data) return false;
    const involved = new Set<string>();
    for (const sp of runDetailQuery.data.splits) involved.add(sp.storeId);
    if (involved.size === 0) return false;
    for (const id of involved) {
      const allConfirmed = runDetailQuery.data.splits
        .filter((sp) => sp.storeId === id)
        .every((sp) => !!sp.confirmedAt);
      if (!allConfirmed) return false;
    }
    return true;
  }, [runDetailQuery.data]);

  /** "We can still un-Start delivery" — true iff status=delivering AND
   *  no store has been delivered to. */
  const canUndoStartDelivery = useMemo(() => {
    if (activeRun?.status !== 'delivering') return false;
    return (runDetailQuery.data?.splits ?? []).every((sp) => !sp.deliveredAt);
  }, [activeRun?.status, runDetailQuery.data]);

  /** M3.29 (2026-05-18): re-exposed. Lifted the "no items touched"
   *  gate (commands.ts:503); purchases survive the revert and the
   *  user can step back to planned to modify the run mid-purchase. */
  const canUndoStartPurchase = activeRun?.status === 'purchasing';

  // C.2 (M3.38, 2026-05-19): run claim signals.
  const myMemberId = session?.member.memberId ?? null;
  const runClaimedByMemberId = runDetailQuery.data?.claimedByMemberId ?? null;
  const collaborationEnabled = true;
  const isClaimedByMe = !!myMemberId && runClaimedByMemberId === myMemberId;
  const isClaimedByOther =
    !!runClaimedByMemberId && runClaimedByMemberId !== myMemberId;
  const claimedByDisplayName = runDetailQuery.data?.claimedByDisplayName ?? null;
  const previousClaimerDisplayName =
    runDetailQuery.data?.previousClaimerDisplayName ?? null;
  // Auto-claim on mount when status is in the claim window AND no one
  // currently holds the claim. The dependency array intentionally
  // EXCLUDES claimRun (stable mutation ref) — adding it would re-fire
  // every render. We do include `runClaimedByMemberId` so the effect
  // re-evaluates when another user releases.
  useEffect(() => {
    if (!activeRun || !myMemberId) return;
    if (collaborationEnabled) return;
    if (activeRun.status !== 'purchasing' && activeRun.status !== 'delivering') {
      return;
    }
    // Wait until the query has resolved so we don't claim based on
    // stale undefined state.
    if (!runDetailQuery.data) return;
    if (runClaimedByMemberId) return; // already held (by me or by other)
    if (claimRun.isPending) return;
    claimRun.mutate({ runId: activeRun.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeRun?.id,
    activeRun?.status,
    myMemberId,
    runClaimedByMemberId,
    runDetailQuery.data,
    collaborationEnabled,
  ]);
  // Auto-release on page hide. Best-effort fire-and-forget; the
  // worker timeout sweep handles cases where this never fires
  // (force-close, network gone, etc.). Only releases if WE hold the
  // claim — visibility events fire for any user, not just claimers.
  useEffect(() => {
    if (!activeRun || !isClaimedByMe || collaborationEnabled) return;
    const handle = () => {
      if (document.visibilityState !== 'hidden') return;
      // Don't await — we may have ~100ms before the tab is killed.
      releaseRunClaim.mutate({
        runId: activeRun.id,
        reason: 'pagehide',
      });
    };
    document.addEventListener('visibilitychange', handle);
    return () => document.removeEventListener('visibilitychange', handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRun?.id, collaborationEnabled, isClaimedByMe]);

  const finishSummary = useMemo(() => {
    const items = runDetailQuery.data?.items ?? [];
    const splits = runDetailQuery.data?.splits ?? [];
    const expenses = runDetailQuery.data?.expenses ?? [];
    const skus = items.filter((i) => i.status === 'purchased').length;
    const stores = new Set(splits.map((sp) => sp.storeId)).size;
    let total = 0;
    let totalCash = 0;
    let totalTransfer = 0;
    // M3.41 (2026-05-21): track purchaser-added rows separately so the
    // finish confirm sheet can call out "Z items added beyond the
    // original order, total W UZS". The manager reviewing the run sees
    // this at a glance — no hunting through audit logs to spot
    // off-plan spending.
    let addedSkus = 0;
    let addedTotal = 0;
    for (const it of items) {
      if (it.status === 'purchased' && it.unitPrice && it.purchasedQty) {
        const itemSplits = splits.filter((sp) => sp.skuId === it.skuId);
        const { line, cash, transfer } = settleItemLine(it, itemSplits);
        total += line;
        totalCash += cash;
        totalTransfer += transfer;
        if (it.addedByPurchaser) {
          addedSkus += 1;
          addedTotal += line;
        }
      }
    }
    // M3.44 (2026-05-22): off-catalog expenses roll into the grand
    // total and the cash/transfer breakdown the same way SKU buys do.
    // Counted separately for the "Off-catalog / expenses" line in the
    // finish confirm body so the manager can read them as their own
    // bucket.
    let expensesCount = 0;
    let expensesTotal = 0;
    for (const ex of expenses) {
      const line = Number(ex.qty) * Number(ex.unitPrice);
      expensesCount += 1;
      expensesTotal += line;
      total += line;
      if (ex.paymentMethod === 'transfer') totalTransfer += line;
      else totalCash += line;
    }
    /**
     * M3.52 (2026-05-23): per-store settlement preview shown in the
     * finish-confirm sheet. The user asked that the post-purchase
     * settlement strictly segregate each store's bill so the manager
     * can read it without mentally untangling cross-store totals.
     * Same shape as the history-sheet breakdown (SKU lines + expense
     * splits, never mixing across stores).
     */
    const byStore = new Map<
      string,
      { storeId: string; total: number; cash: number; transfer: number }
    >();
    const ensureStore = (storeId: string) => {
      let cur = byStore.get(storeId);
      if (!cur) {
        cur = { storeId, total: 0, cash: 0, transfer: 0 };
        byStore.set(storeId, cur);
      }
      return cur;
    };
    for (const sp of splits) {
      const item = items.find((i) => i.skuId === sp.skuId);
      if (!item || item.status !== 'purchased' || !item.unitPrice) continue;
      const subtotal = splitSubtotal(sp, item);
      const cur = ensureStore(sp.storeId);
      cur.total += subtotal;
      if (splitPaymentMethod(sp, item) === 'transfer') cur.transfer += subtotal;
      else cur.cash += subtotal;
    }
    for (const ex of expenses) {
      for (const ss of ex.storeSplits) {
        const subtotal = Number(ss.qty) * Number(ex.unitPrice);
        const cur = ensureStore(ss.storeId);
        cur.total += subtotal;
        if (ex.paymentMethod === 'transfer') cur.transfer += subtotal;
        else cur.cash += subtotal;
      }
    }
    const byStoreList = [...byStore.values()].sort((a, b) => b.total - a.total);
    return {
      skus,
      stores,
      total,
      totalCash,
      totalTransfer,
      addedSkus,
      addedTotal,
      expensesCount,
      expensesTotal,
      byStore: byStoreList,
    };
  }, [runDetailQuery.data]);

  /**
   * Submit-purchase logic factored out of PurchaseSheet so the page-level
   * MainButton can drive it. The sheet's in-footer button (rendered only
   * outside Telegram) calls the same function. Keeping the math in one
   * place avoids the "two save buttons disagree" bug.
   */
  const submitPurchaseDraft = useCallback(
    (d: PurchaseDraft) => {
      const payload = {
        runId: d.runId,
        skuId: d.skuId,
        supplierId: d.supplierId,
        unitPrice: d.unitPrice,
        actualQty: d.actualQty,
        receiptPhotoUrl: d.receiptPhotoUrl,
        storeSplits: [...d.splits.entries()]
          .filter(([, q]) => Number(q) > 0)
          .map(([storeId, qty]) => ({
            storeId,
            qty,
            ...(d.perStorePricing
              ? {
                  unitPrice: d.splitPrices.get(storeId) || d.unitPrice,
                  paymentMethod: d.splitPaymentMethods.get(storeId) ?? d.paymentMethod,
                }
              : {}),
          })),
        paymentMethod: d.paymentMethod,
      };
      if (d.isEdit) {
        revisePurchase.mutate({ ...payload, reason: d.reason });
      } else {
        purchaseItem.mutate(payload);
      }
    },
    [purchaseItem, revisePurchase],
  );

  /**
   * Derived purchase-form validity (mirrors the math inside PurchaseSheet
   * so MainButton can show the right text + enable/disable). Lives here
   * so we don't duplicate it in two places.
   */
  const purchaseFormState = useMemo(() => {
    if (!purchaseDraft) return null;
    let splitTotal = 0;
    for (const v of purchaseDraft.splits.values()) splitTotal += Number(v) || 0;
    const splitMatches =
      Math.abs(splitTotal - Number(purchaseDraft.actualQty || 0)) < 0.001;
    const reasonOk = !purchaseDraft.isEdit || purchaseDraft.reason.trim().length > 0;
    const splitPricesOk =
      !purchaseDraft.perStorePricing ||
      [...purchaseDraft.splits.entries()]
        .filter(([, qty]) => Number(qty) > 0)
        .every(([storeId]) => Number(purchaseDraft.splitPrices.get(storeId) || purchaseDraft.unitPrice) > 0);
    const canSubmit = !!(
      Number(purchaseDraft.actualQty) > 0 &&
      Number(purchaseDraft.unitPrice) > 0 &&
      splitMatches &&
      reasonOk &&
      splitPricesOk
    );
    return { splitTotal, splitMatches, reasonOk, canSubmit };
  }, [purchaseDraft]);

  // ---- MainButton -----------------------------------------------------
  // The previous implementation showed a clickable MainButton even when
  // the user couldn't actually advance — pressing it just toasted "do X
  // first". That's a noisy waste. Now: button is disabled (Telegram dims
  // it) when the precondition isn't met, and the *text* tells the user
  // what's missing.
  const mainButton = useMemo<{
    text: string;
    onClick: () => void;
    visible: boolean;
    active: boolean;
  }>(() => {
    if (!activeRun) {
      // M1.12: when there's no active run BUT planned items exist, the
      // MainButton becomes the "+ New run" CTA. Previously this button
      // lived in the PageHeader actions slot, which we just dropped.
      // Routing it through Telegram's MainButton keeps the action
      // visually consistent with every other phase transition (Start
      // purchase / Start delivery / Finish run all already do this).
      const plannable = previewQuery.data?.plannedItems.length ?? 0;
      if (plannable > 0) {
        return {
          text: i18n.t('run.header.newRun'),
          onClick: () => setCreateOpen(true),
          visible: true,
          active: true,
        };
      }
      return { text: '', onClick: () => {}, visible: false, active: false };
    }
    switch (activeRun.status) {
      case 'planned':
        return {
          text: i18n.t('run.action.startPurchase'),
          onClick: () => setConfirmAction('startPurchase'),
          visible: true,
          active: true,
        };
      case 'purchasing':
        // 2026-05-04: HIDE the button entirely when not actionable.
        // The previous "Process every item first" disabled label ate
        // 60 vertical pixels with zero value — user already knows from
        // the row badges what's pending. Reserve the bottom strip for
        // a real CTA, or nothing at all.
        return {
          text: i18n.t('run.action.startDelivery'),
          onClick: () => allItemsHandled && setConfirmAction('startDelivery'),
          visible: allItemsHandled,
          active: allItemsHandled,
        };
      case 'delivering':
        return {
          text: i18n.t('run.action.finish'),
          onClick: () => allStoresConfirmed && setConfirmAction('finish'),
          visible: allStoresConfirmed,
          active: allStoresConfirmed,
        };
      default:
        return { text: '', onClick: () => {}, visible: false, active: false };
    }
  }, [activeRun, allItemsHandled, allStoresConfirmed, i18n, previewQuery.data]);

  /**
   * MainButton dispatch: when a sheet with a single primary action is
   * open, the Telegram MainButton TAKES OVER as that sheet's submit
   * button. This avoids the "two duplicate buttons" UX the user
   * reported (sheet's blue button + MainButton showing through
   * underneath the sheet — looks awkward and confusing).
   *
   *   - createOpen / purchaseDraft / unavailableFor / confirmAction
   *     → MainButton becomes the sheet's primary; the sheet's footer
   *       hides its own primary (only renders it outside Telegram).
   *   - itemActionFor / storeActionFor / headerMenuOpen / historyDetailFor
   *     → these are MULTI-option menus; MainButton hides entirely so
   *       the user only sees the menu options.
   *
   * The dispatch is computed below (`sheetPrimary` / `multiOptionSheetOpen`),
   * then a single `usePageMainButton` call binds whichever applies.
   */
  const sheetPrimary = useMemo<{
    text: string;
    onClick: () => void;
    active: boolean;
  } | null>(() => {
    // Generic confirm sheet (start/finish/deliver/recall/cancel/etc).
    if (confirmAction) {
      // Re-resolve the same i18n payload that ConfirmSheet uses below.
      // We can't reference confirmConfig here because it's defined later
      // in the file order; build the minimum dispatcher inline.
      // (Cheaper than restructuring the file.)
      return null; // filled in below right after confirmConfig is defined
    }
    if (purchaseDraft && purchaseFormState) {
      const submitting = purchaseItem.isPending || revisePurchase.isPending;
      const text = !purchaseFormState.splitMatches
        ? i18n.t('run.label.splitsMismatch', {
            sum: formatQty(purchaseFormState.splitTotal),
            target: formatQty(purchaseDraft.actualQty || '0'),
          })
        : !purchaseFormState.reasonOk
          ? i18n.t('run.errors.reviseReasonRequired')
          : purchaseDraft.isEdit
            ? i18n.t('run.action.editPurchase')
            : i18n.t('run.action.savePurchase');
      return {
        text,
        onClick: () => {
          if (!purchaseFormState.canSubmit || submitting) return;
          submitPurchaseDraft(purchaseDraft);
        },
        active: purchaseFormState.canSubmit && !submitting,
      };
    }
    if (unavailableFor) {
      const reasonOk = unavailableNote.trim().length > 0;
      return {
        text: i18n.t('run.action.markNa'),
        onClick: () => {
          if (!reasonOk || markUnavailable.isPending) return;
          markUnavailable.mutate({
            runId: unavailableFor.runId,
            skuId: unavailableFor.skuId,
            note: unavailableNote.trim(),
          });
        },
        active: reasonOk && !markUnavailable.isPending,
      };
    }
    if (createOpen) {
      const sessionIds = previewQuery.data?.sessions.map((s) => s.id) ?? [];
      return {
        text: i18n.t('run.action.planRun'),
        onClick: () => {
          if (sessionIds.length === 0 || create.isPending) return;
          // M1.13: collapse "+ New run" + "Start purchase" double tap
          // into a single CTA. Server emits PlanRun + StartPurchase
          // atomically when startImmediately is true.
          create.mutate({ sessionIds, startImmediately: true });
        },
        active: sessionIds.length > 0 && !create.isPending,
      };
    }
    return null;
  }, [
    confirmAction,
    purchaseDraft,
    purchaseFormState,
    purchaseItem.isPending,
    revisePurchase.isPending,
    submitPurchaseDraft,
    unavailableFor,
    unavailableNote,
    markUnavailable,
    createOpen,
    previewQuery.data,
    create,
    i18n,
  ]);

  /** Sheets that DON'T have a single primary action (drill-down
   *  history). MainButton hides while these are open. (M1.12: the
   *  former header ⋯ Sheet was removed; its contents migrated to the
   *  Telegram gear via usePageMenu.) */
  const multiOptionSheetOpen = !!historyDetailFor;

  // ---- Confirm-sheet wiring --------------------------------------------
  // Resets the reason input whenever the confirm switches kind (or
  // closes). Avoids stale text leaking from one decision into the next.
  useEffect(() => {
    setConfirmReason('');
  }, [confirmAction]);

  /** Returns the current confirmation's i18n payload + the side effect
   *  to fire on Confirm. Returns null when no confirm is open. */
  const confirmConfig = useMemo(() => {
    if (!confirmAction || !activeRun) return null;
    const runId = activeRun.id;
    if (typeof confirmAction === 'string') {
      switch (confirmAction) {
        case 'startPurchase':
          return {
            title: i18n.t('run.confirm.startPurchase.title'),
            body: i18n.t('run.confirm.startPurchase.body'),
            confirmLabel: i18n.t('run.action.startPurchase'),
            danger: false,
            requireReason: false,
            isPending: startPurchase.isPending,
            run: () => startPurchase.mutate({ runId }, { onSuccess: () => setConfirmAction(null) }),
          };
        case 'startDelivery':
          return {
            title: i18n.t('run.confirm.startDelivery.title'),
            body: i18n.t('run.confirm.startDelivery.body'),
            confirmLabel: i18n.t('run.action.startDelivery'),
            danger: false,
            requireReason: false,
            isPending: startDelivery.isPending,
            run: () => startDelivery.mutate({ runId }, { onSuccess: () => setConfirmAction(null) }),
          };
        case 'finish': {
          // M1.14: include cash / transfer breakdown when the run mixed
          // both methods. Single-method runs see only the lump sum.
          // M2.1 (2026-05-08): route the three confirm-body numbers
          // through formatMoney() so thousand separators + the
          // one-decimal cap match every other money display in the
          // app. Was `.toFixed(0)` which produced a raw integer
          // string with no separators (e.g. "1234567").
          const showBreakdown =
            finishSummary.totalCash > 0 && finishSummary.totalTransfer > 0;
          const breakdownLine = showBreakdown
            ? '\n' +
              i18n.t('run.confirm.finish.paymentBreakdown', {
                cash: formatMoney(finishSummary.totalCash),
                transfer: formatMoney(finishSummary.totalTransfer),
              })
            : '';
          // M3.41 (2026-05-21): when the purchaser added items mid-run,
          // call them out separately in the finish body so the manager
          // can see "X items added beyond the original order, total Y"
          // at the same glance as the canonical total. The line is
          // omitted when nothing was added (the normal case) to avoid
          // cluttering 90% of finishes with a zeroed-out row.
          const addedLine =
            finishSummary.addedSkus > 0
              ? '\n' +
                i18n.t('run.confirm.finish.addedByPurchaser', {
                  n: finishSummary.addedSkus,
                  total: formatMoney(finishSummary.addedTotal),
                })
              : '';
          // M3.44 (2026-05-22): off-catalog expenses line. Skipped
          // when there are none to keep the common-case confirm
          // body concise.
          const expensesLine =
            finishSummary.expensesCount > 0
              ? '\n' +
                i18n.t('run.confirm.finish.expenses', {
                  n: finishSummary.expensesCount,
                  total: formatMoney(finishSummary.expensesTotal),
                })
              : '';
          /**
           * M3.52 (2026-05-23): per-store settlement list. Shown only
           * for multi-store runs (single-store: the headline total
           * already says everything). The manager sees "店A 100,000
           * · 💵 60,000 · 🏦 40,000" before tapping Finish, so they
           * can confirm each store's bill at a glance and pivot to
           * cash-vs-transfer if the run mixed methods.
           *
           * Strictly per-store: each line is one store's own slice
           * (SKU lines + expense splits attributed via storeSplits),
           * never aggregated across stores.
           */
          const perStoreLines =
            finishSummary.byStore.length > 1
              ? '\n\n' +
                i18n.t('run.confirm.finish.perStoreHeading') +
                '\n' +
                finishSummary.byStore
                  .map((ps) => {
                    const storeName =
                      storeById.get(ps.storeId)?.name ?? ps.storeId.slice(0, 8);
                    const mixed = ps.cash > 0 && ps.transfer > 0;
                    const tail = mixed
                      ? ` · 💵 ${formatMoney(ps.cash)} · 🏦 ${formatMoney(ps.transfer)}`
                      : '';
                    return `${storeName}: ${formatMoney(ps.total)}${tail}`;
                  })
                  .join('\n')
              : '';
          return {
            title: i18n.t('run.confirm.finish.title'),
            body:
              i18n.t('run.confirm.finish.body') +
              '\n\n' +
              i18n.t('run.confirm.finish.summary', {
                items: finishSummary.skus,
                stores: finishSummary.stores,
                total: formatMoney(finishSummary.total),
              }) +
              breakdownLine +
              addedLine +
              expensesLine +
              perStoreLines,
            confirmLabel: i18n.t('run.action.finish'),
            danger: false,
            requireReason: false,
            isPending: finish.isPending,
            run: () => finish.mutate({ runId }, { onSuccess: () => setConfirmAction(null) }),
          };
        }
        case 'cancel':
          // M1.7-A (2026-05-06): soft-encourage reason but don't
          // gate. The user pointed out that hard-requiring a reason
          // for cancel produces "asdf" noise — most cancels are
          // misclicks. Optional input + an encouraging placeholder
          // captures the cases where the operator actually has
          // something to say.
          return {
            title: i18n.t('run.confirm.cancel.title'),
            body: i18n.t('run.confirm.cancel.body'),
            confirmLabel: i18n.t('run.action.cancelRun'),
            danger: true,
            requireReason: false,
            reasonOptional: true,
            reasonPlaceholder: i18n.t('run.cancel.reasonPlaceholder'),
            isPending: cancelRun.isPending,
            run: () =>
              cancelRun.mutate(
                { runId, reason: confirmReason },
                { onSuccess: () => setConfirmAction(null) },
              ),
          };
        case 'undoStartPurchase':
          return {
            title: i18n.t('run.confirm.undoStartPurchase.title'),
            body: i18n.t('run.confirm.undoStartPurchase.body'),
            confirmLabel: i18n.t('run.action.undoStartPurchase'),
            danger: false,
            requireReason: true,
            isPending: undoStartPurchase.isPending,
            run: () =>
              undoStartPurchase.mutate(
                { runId, reason: confirmReason },
                { onSuccess: () => setConfirmAction(null) },
              ),
          };
        case 'undoStartDelivery':
          return {
            title: i18n.t('run.confirm.undoStartDelivery.title'),
            body: i18n.t('run.confirm.undoStartDelivery.body'),
            confirmLabel: i18n.t('run.action.undoStartDelivery'),
            danger: false,
            requireReason: true,
            isPending: undoStartDelivery.isPending,
            run: () =>
              undoStartDelivery.mutate(
                { runId, reason: confirmReason },
                { onSuccess: () => setConfirmAction(null) },
              ),
          };
      }
    } else {
      switch (confirmAction.kind) {
        case 'deliverStore':
          return {
            title: i18n.t('run.confirm.deliver.title', { store: confirmAction.storeName }),
            body: i18n.t('run.confirm.deliver.body'),
            confirmLabel: i18n.t('run.action.confirmDeliver'),
            danger: false,
            requireReason: false,
            isPending: deliverToStore.isPending,
            run: () =>
              deliverToStore.mutate(
                { runId, storeId: confirmAction.storeId },
                { onSuccess: () => setConfirmAction(null) },
              ),
          };
        case 'recallDelivery':
          return {
            title: i18n.t('run.confirm.recall.title', { store: confirmAction.storeName }),
            body: i18n.t('run.confirm.recall.body'),
            confirmLabel: i18n.t('run.action.recallDelivery'),
            danger: true,
            requireReason: true,
            isPending: undeliverStore.isPending,
            run: () =>
              undeliverStore.mutate(
                { runId, storeId: confirmAction.storeId, reason: confirmReason },
                { onSuccess: () => setConfirmAction(null) },
              ),
          };
        case 'unmarkUnavailable':
          return {
            title: i18n.t('run.confirm.unmarkUnavailable.title'),
            body: i18n.t('run.confirm.unmarkUnavailable.body'),
            confirmLabel: i18n.t('run.action.unmarkUnavailable'),
            danger: false,
            requireReason: true,
            isPending: unmarkUnavailable.isPending,
            run: () =>
              unmarkUnavailable.mutate(
                { runId, skuId: confirmAction.skuId, reason: confirmReason },
                { onSuccess: () => setConfirmAction(null) },
              ),
          };
        case 'undoPurchase':
          // No reason field — undo is just "open this row back up for
          // editing". Audit log still gets an empty PurchaseUndone event
          // for the state revert; the operator just doesn't have to type
          // anything.
          return {
            title: i18n.t('run.confirm.undoPurchase.title'),
            body: i18n.t('run.confirm.undoPurchase.body'),
            confirmLabel: i18n.t('run.action.undoPurchase'),
            danger: true,
            requireReason: false,
            isPending: undoPurchase.isPending,
            run: () =>
              undoPurchase.mutate(
                { runId, skuId: confirmAction.skuId, reason: '' },
                { onSuccess: () => setConfirmAction(null) },
              ),
          };
        case 'ejectSession':
          return {
            title: i18n.t('run.confirm.ejectSession.title', {
              store: confirmAction.storeName,
              who: confirmAction.submitterName,
            }),
            body: i18n.t('run.confirm.ejectSession.body'),
            confirmLabel: i18n.t('run.action.ejectSession'),
            danger: true,
            requireReason: false,
            reasonOptional: true,
            reasonPlaceholder: i18n.t('run.eject.reasonPlaceholder'),
            isPending: ejectSession.isPending,
            run: () =>
              ejectSession.mutate(
                {
                  runId,
                  sessionId: confirmAction.sessionId,
                  reason: confirmReason.trim() || undefined,
                },
                { onSuccess: () => setConfirmAction(null) },
              ),
          };
      }
    }
    return null;
  }, [
    confirmAction,
    confirmReason,
    finishSummary,
    activeRun,
    i18n,
    storeById,
    startPurchase,
    startDelivery,
    finish,
    cancelRun,
    undoStartPurchase,
    undoStartDelivery,
    deliverToStore,
    undeliverStore,
    unmarkUnavailable,
    undoPurchase,
    ejectSession,
  ]);

  // ---- Unified MainButton dispatcher --------------------------------
  // Single bind point. Source of truth for which action MainButton
  // currently fires:
  //   1. confirmConfig (generic confirm sheet) — highest priority,
  //      because it can stack on top of other sheets in theory.
  //   2. sheetPrimary (purchase/unavailable/create) — a sheet with a
  //      single primary action, no body-level controls beyond the form.
  //   3. multi-option sheet open → MainButton hidden.
  //   4. Page-level mainButton (Start purchase / Start delivery /
  //      Finish run) when no sheet is open.
  let mainBtnText = mainButton.text;
  let mainBtnClick = mainButton.onClick;
  let mainBtnVisible = mainButton.visible;
  let mainBtnActive = mainButton.active;

  if (confirmConfig) {
    const reasonOk = !confirmConfig.requireReason || confirmReason.trim().length > 0;
    mainBtnText = confirmConfig.confirmLabel;
    mainBtnClick = () => {
      if (!reasonOk || confirmConfig.isPending) return;
      confirmConfig.run();
    };
    mainBtnVisible = true;
    mainBtnActive = reasonOk && !confirmConfig.isPending;
  } else if (sheetPrimary) {
    mainBtnText = sheetPrimary.text;
    mainBtnClick = sheetPrimary.onClick;
    mainBtnVisible = true;
    mainBtnActive = sheetPrimary.active;
  } else if (multiOptionSheetOpen) {
    mainBtnVisible = false;
  }

  usePageMainButton(mainBtnText, mainBtnClick, {
    visible: mainBtnVisible,
    active: mainBtnActive,
  });

  // M1.12: register the run's "danger zone" actions in Telegram's gear ⚙️.
  // M3.29 (2026-05-18): re-added `undoStartPurchase` after the gate
  // lift. The M1.13 removal assumed plan/purchase had merged and any
  // undo was equivalent to cancel — now that purchases survive the
  // revert, "Back to plan" is a real, non-destructive option that
  // belongs in the menu alongside the delivery undo.
  usePageMenu(
    activeRun
      ? {
          title: i18n.t('run.title') + ` #${activeRun.runIndex + 1}`,
          actions: [
            ...(canUndoStartPurchase
              ? [
                  {
                    label: i18n.t('run.action.undoStartPurchase'),
                    onClick: () => setConfirmAction('undoStartPurchase'),
                  },
                ]
              : []),
            ...(canUndoStartDelivery
              ? [
                  {
                    label: i18n.t('run.action.undoStartDelivery'),
                    onClick: () => setConfirmAction('undoStartDelivery'),
                  },
                ]
              : []),
            {
              label: i18n.t('run.action.cancelRun'),
              variant: 'danger' as const,
              onClick: () => setConfirmAction('cancel'),
            },
          ],
        }
      : null,
  );

  if (!session) return null;

  // M1.9-extra (P4): adopted shared <PageHeader>. Subtitle folds in
  // run date + phase label so the line under the title shows
  // "2026-05-07 · Purchase" or "No active run" depending on state.
  const runSubtitle = activeRun
    ? `${activeRun.runDate} · ${
        activeRun.status === 'planned'
          ? i18n.t('run.step.plan')
          : activeRun.status === 'purchasing'
            ? i18n.t('run.step.purchase')
            : activeRun.status === 'delivering'
              ? i18n.t('run.step.deliver')
              : activeRun.status === 'finished'
                ? i18n.t('run.step.done')
                : activeRun.status
      }`
    : i18n.t('run.empty.noActive');

  if (historyPageOpen) {
    return (
      <RunHistoryPage
        runs={fullHistoryQuery.data ?? []}
        loading={fullHistoryQuery.isLoading}
        storeById={storeById}
        skuById={skuById}
        productName={productName}
        i18n={i18n}
        onBack={() => setHistoryPageOpen(false)}
      />
    );
  }

  return (
    /* M1.12: outer page is just `flex flex-col` + bottom safe-area.
        PageHeader removed entirely — Telegram's chrome (bot name +
        BottomNav) is the app frame, and per-page actions ("Undo
        start purchase", "Cancel run") now live in the gear ⚙️ on the
        right side of Telegram's chrome (registered via usePageMenu
        below). What remains in-body is a one-line context strip
        showing the current store and, when a run is active, a small
        "#3 · purchasing" tag so the user sees both store-scope and
        run state without losing 60+ px to a redundant header bar. */
    <div className="flex flex-col pb-24">
      {/* M3.5: store-switcher pill moved to SettingsSheet. Sticky strip
         now only renders when there's an active run to label. */}
      {activeRun ? (
        <div
          className="sticky top-0 z-[1] flex min-h-9 items-center gap-2 border-b border-[var(--c-divider)] bg-[var(--c-bg)] py-2"
          style={{
            // M3.46 (2026-05-22): clear Telegram's overlay chrome
            // (Close at left, ⋯ at right). Vars set by Shell.tsx's
            // chrome detection; default to 16px so non-Telegram /
            // web-preview keeps the legacy px-4 look.
            paddingLeft: 'max(16px, var(--app-chrome-pad-left, 16px))',
            paddingRight: 'max(16px, var(--app-chrome-pad-right, 16px))',
          }}
        >
          {/* M3.36 (2026-05-19): "×1000" toggle. Visible during the
              two stages where price actually gets typed — planned (an
              advanced edit can still pop) and purchasing. Hidden in
              delivering / finished where the toggle would be a
              no-op (no price inputs anywhere). */}
          {activeRun.status === 'planned' || activeRun.status === 'purchasing' ? (
            <button
              type="button"
              onClick={togglePriceInThousands}
              title={i18n.t('run.label.thousandsToggleAria')}
              aria-pressed={priceInThousands}
              className={
                'shrink-0 rounded-[var(--r-pill)] px-2 py-0.5 text-label font-mono tabular-nums active:opacity-70 ' +
                (priceInThousands
                  ? 'bg-[var(--c-action)]/15 text-[var(--c-action)] ring-1 ring-[var(--c-action)]'
                  : 'bg-[var(--c-surface-2)] text-[var(--c-fg-muted)]')
              }
            >
              {i18n.t('run.label.thousandsToggle')}
            </button>
          ) : null}
          {/* M3.41 (2026-05-21): "+ add item" — only shown during
              purchasing AND when I hold the run claim (C.2 gate). The
              domain layer enforces the same constraints; gating the UI
              hides the affordance to avoid a confusing tap-then-fail.
              The button opens AddItemSheet which collects SKU + qty +
              price + store split + reason. */}
          {activeRun.status === 'purchasing' && (isClaimedByMe || collaborationEnabled) ? (
            <button
              type="button"
              onClick={() =>
                setAddItemDraft({
                  mode: 'sku',
                  runId: activeRun.id,
                  skuId: null,
                  supplierId: null,
                  skuCostMode: 'merge',
                  // M3.44: pre-generate expense UUID even when opening
                  // in SKU mode so a mid-flow tab switch to expense
                  // mode already has the id ready (idempotency).
                  expenseId: newClientId(),
                  label: '',
                  unitHint: '',
                  expenseScope: 'shared',
                  actualQty: '',
                  unitPrice: '',
                  splits: new Map(),
                  splitPrices: new Map(),
                  splitPaymentMethods: new Map(),
                  perStorePricing: false,
                  paymentMethod: 'cash',
                  receiptPhotoUrl: null,
                  reason: '',
                })
              }
              title={i18n.t('run.action.addItem.title')}
              className="shrink-0 rounded-[var(--r-pill)] bg-[var(--c-action)] px-2.5 py-0.5 text-label font-semibold text-[var(--c-action-fg)] active:opacity-70"
            >
              {i18n.t('run.action.addItem.button')}
            </button>
          ) : null}
          <span className="ml-auto truncate text-label tabular-nums text-[var(--c-fg-muted)]">
            #{activeRun.runIndex + 1} · {runSubtitle}
          </span>
        </div>
      ) : null}

      {/* C.2 (M3.38, 2026-05-19): "claimed by other" banner with
          take-over button. Take-over re-tags releaseClaim with
          reason='override' (server-side detection), the auto-claim
          useEffect then re-grabs the claim under our memberId once
          the WS invalidate lands. Two API roundtrips visible to the
          user as a single tap. */}
      {activeRun && !collaborationEnabled && isClaimedByOther ? (
        <div className="px-4 pt-2">
          <Banner
            tone="warn"
            title={
              previousClaimerDisplayName
                ? i18n.t('run.banner.claimedAfterHandoff', {
                    who: claimedByDisplayName ?? '…',
                    prev: previousClaimerDisplayName,
                  })
                : i18n.t('run.banner.claimed', {
                    who: claimedByDisplayName ?? '…',
                  })
            }
            action={
              <Button
                variant="pearl"
                size="sm"
                loading={releaseRunClaim.isPending}
                onClick={() =>
                  releaseRunClaim.mutate({ runId: activeRun.id, reason: 'manual' })
                }
              >
                {i18n.t('run.action.takeOver')}
              </Button>
            }
          />
        </div>
      ) : null}

      {/* M3.31 A.2 (2026-05-18): when the run is still mutable
          (planned/purchasing) and new approved sessions have appeared
          since the run was created, prompt the purchaser to attach
          them. Mirrors the "what should I add" reality of midday top-
          ups — the staff submitted late, the approver waved it
          through, the purchaser is already at the bazaar. The button
          merges every available session in one call; the mutation's
          domain layer guards against duplicates. */}
      {activeRun &&
      (activeRun.status === 'planned' || activeRun.status === 'purchasing') &&
      previewQuery.data?.sessions.length ? (
        <div className="px-4 pt-2">
          <Banner
            tone="info"
            title={i18n.t('run.attach.banner.title', {
              n: previewQuery.data.sessions.length,
            })}
            action={
              <Button
                variant="pearl"
                size="sm"
                loading={attachSessions.isPending}
                onClick={() =>
                  attachSessions.mutate({
                    runId: activeRun.id,
                    sessionIds: previewQuery.data!.sessions.map((s) => s.id),
                  })
                }
              >
                {i18n.t('run.action.attachSessions')}
              </Button>
            }
          />
        </div>
      ) : null}

      <div className="flex flex-col gap-2 px-4 pt-2">
      {!activeRun ? (
        <DataState query={previewQuery}>
          {(p) =>
            p.plannedItems.length === 0 ? (
              <EmptyState
                title={i18n.t('run.empty.noPlannable')}
                description={i18n.t('run.empty.noPlannableBody')}
              />
            ) : (
              <PreviewSummaryCard
                preview={p}
                skuById={skuById}
                productName={productName}
                i18n={i18n}
                toast={toast}
              />
            )
          }
        </DataState>
      ) : null}

      {activeRun &&
      runDetailQuery.data &&
      (activeRun.status === 'planned' || activeRun.status === 'purchasing') &&
      (runDetailQuery.data.sessions?.length ?? 0) > 0 ? (
        <RunSessionsCard
          sessions={runDetailQuery.data.sessions ?? []}
          storeById={storeById}
          i18n={i18n}
          ejecting={ejectSession.isPending}
          onEject={(sessionRow) => {
            const storeName =
              storeById.get(sessionRow.storeId)?.name ?? sessionRow.storeId.slice(0, 8);
            setConfirmAction({
              kind: 'ejectSession',
              sessionId: sessionRow.id,
              storeName,
              submitterName:
                sessionRow.submittedByDisplayName ?? i18n.t('run.sessions.unknownSubmitter'),
            });
          }}
        />
      ) : null}

      {/* M3.30 (2026-05-18): for an EXISTING run that's back in `planned`
          status (either freshly created or reverted via "Back to plan",
          M3.29), render the same preview-style summary the no-run-yet
          path uses — three-way view toggle, by-store / by-vendor copy
          buttons, no per-row edit affordances. Recording purchases
          resumes once the user taps the MainButton "Start purchase".
          Adapts run.detail's shape into PreviewSummaryCard's expected
          prop: planned-qty from items, store names looked up via
          storeById, supplierBySku straight from run.get (added M3.27). */}
      {activeRun && runDetailQuery.data && activeRun.status === 'planned' ? (
        <PreviewSummaryCard
          preview={{
            date: runDetailQuery.data.runDate,
            sessions: ((runDetailQuery.data.sessionIdsJson as string[] | null) ?? []).map(
              (id) => ({ id, storeId: '' }),
            ),
            plannedItems: runDetailQuery.data.items.map((it) => ({
              skuId: it.skuId,
              qty: it.plannedQty,
            })),
            perStoreDemand: (runDetailQuery.data.perStoreDemand ?? []).map((d) => ({
              storeId: d.storeId,
              storeName:
                storeById.get(d.storeId)?.name ?? d.storeId.slice(0, 8),
              skuId: d.skuId,
              qty: d.qty,
            })),
            supplierBySku: runDetailQuery.data.supplierBySku ?? {},
            sessionNotesByStore: runDetailQuery.data.sessionNotesByStore,
            sessionExtrasByStore: runDetailQuery.data.sessionExtrasByStore,
          }}
          skuById={skuById}
          productName={productName}
          i18n={i18n}
          toast={toast}
        />
      ) : null}

      {activeRun && runDetailQuery.data && activeRun.status !== 'planned' ? (
        <ActiveRunPanel
          run={runDetailQuery.data}
          skuById={skuById}
          categoryById={categoryById}
          storeById={storeById}
          productName={productName}
          i18n={i18n}
          priceInThousands={priceInThousands}
          savingSkuId={inlineSavingSkuId}
          onSavePurchaseInline={({ skuId, actualQty, unitPrice, storeSplits, paymentMethod }) => {
            // Direct in-page save — no sheet involved. Triggered when
            // the user blurs the price input on a row whose qty
            // matches planned. Splits come from per-store demand.
            // M1.14: paymentMethod comes from the in-row toggle
            // (defaults to 'cash'; user can flip to 'transfer' before
            // saving for the relatively rare transfer items).
            setInlineSavingSkuId(skuId);
            purchaseItem.mutate({
              runId: activeRun.id,
              skuId,
              supplierId: null,
              unitPrice,
              actualQty,
              receiptPhotoUrl: null,
              storeSplits,
              paymentMethod,
            });
          }}
          onMarkNa={(skuId) =>
            setUnavailableFor({ runId: activeRun.id, skuId })
          }
          onEditPurchased={(item) => {
            const splits = new Map<string, string>();
            const splitPrices = new Map<string, string>();
            const splitPaymentMethods = new Map<string, 'cash' | 'transfer'>();
            let perStorePricing = false;
            for (const sp of runDetailQuery.data!.splits) {
              if (sp.skuId === item.skuId) {
                splits.set(sp.storeId, sp.qty);
                if (sp.unitPrice) {
                  splitPrices.set(sp.storeId, sp.unitPrice);
                  perStorePricing = true;
                }
                if (sp.paymentMethod) {
                  splitPaymentMethods.set(sp.storeId, sp.paymentMethod as 'cash' | 'transfer');
                  perStorePricing = true;
                }
              }
            }
            setPurchaseDraft({
              isEdit: true,
              skuId: item.skuId,
              runId: activeRun.id,
              unitPrice: item.unitPrice ?? '',
              actualQty: item.purchasedQty ?? '',
              supplierId: item.supplierId ?? null,
              splits,
              splitPrices,
              splitPaymentMethods,
              perStorePricing,
              receiptPhotoUrl: item.receiptPhotoUrl ?? null,
              reason: '',
              // M1.14: prefill from existing record so editing doesn't
              // accidentally flip the method back to cash.
              paymentMethod: (item.paymentMethod as 'cash' | 'transfer') ?? 'cash',
            });
          }}
          onUnmark={(skuId, skuName) =>
            setConfirmAction({ kind: 'unmarkUnavailable', skuId, skuName })
          }
          onUndoPurchase={(skuId, skuName) =>
            setConfirmAction({ kind: 'undoPurchase', skuId, skuName })
          }
          onOpenAdvancedPurchase={(item) => {
            // User changed qty from planned (or no per-store demand
            // info available) — open the full PurchaseSheet so they
            // can manually allocate across stores. Pre-fill with
            // demand if known.
            const splits = new Map<string, string>();
            const demand =
              runDetailQuery.data?.perStoreDemand?.filter(
                (d) => d.skuId === item.skuId,
              ) ?? [];
            for (const d of demand) splits.set(d.storeId, d.qty);
            // Fallback to first store with the planned qty if no demand
            // info (legacy runs that were planned before perStoreDemand
            // existed).
            if (splits.size === 0) {
              const firstStore = storesQuery.data?.[0]?.id ?? '';
              if (firstStore) splits.set(firstStore, item.plannedQty);
            }
            setPurchaseDraft({
              isEdit: false,
              skuId: item.skuId,
              runId: activeRun.id,
              unitPrice: '',
              actualQty: item.plannedQty,
              supplierId: null,
              splits,
              splitPrices: new Map(),
              splitPaymentMethods: new Map(),
              perStorePricing: false,
              receiptPhotoUrl: null,
              reason: '',
              // M1.14: cash default; user flips to transfer in the sheet.
              paymentMethod: 'cash',
            });
          }}
          onDeliverStore={(storeId, storeName) =>
            setConfirmAction({ kind: 'deliverStore', storeId, storeName })
          }
          onRecallStore={(storeId, storeName) =>
            setConfirmAction({ kind: 'recallDelivery', storeId, storeName })
          }
          onMarkExtraStatus={(sessionId, extraIndex, status) =>
            markExtraStatus.mutate({ sessionId, extraIndex, status })
          }
          onRecordExtraExpense={(storeId, extra) => {
            setAddItemDraft({
              mode: 'expense',
              runId: activeRun.id,
              skuId: null,
              supplierId: null,
              skuCostMode: 'merge',
              expenseId: newClientId(),
              label: extra.name,
              unitHint: extra.unit,
              expenseScope: 'store',
              actualQty: extra.qty || '1',
              unitPrice: '',
              splits: new Map([[storeId, extra.qty || '1']]),
              splitPrices: new Map(),
              splitPaymentMethods: new Map(),
              perStorePricing: false,
              paymentMethod: 'cash',
              receiptPhotoUrl: null,
              reason: i18n.t('run.extras.recordExpenseReason'),
            });
          }}
          onRemoveExpense={(expenseId) =>
            removeExpense.mutate({
              runId: activeRun.id,
              expenseId,
              reason: '',
            })
          }
          onOpenExpense={() =>
            setAddItemDraft({
              mode: 'expense',
              runId: activeRun.id,
              skuId: null,
              supplierId: null,
              skuCostMode: 'merge',
              expenseId: newClientId(),
              label: '',
              unitHint: '',
              expenseScope: 'shared',
              actualQty: '1',
              unitPrice: '',
              splits: new Map(),
              splitPrices: new Map(),
              splitPaymentMethods: new Map(),
              perStorePricing: false,
              paymentMethod: 'cash',
              receiptPhotoUrl: null,
              reason: '',
            })
          }
        />
      ) : null}

      {/* History section — finished + cancelled runs, newest first.
          M1.13 (2026-05-08): moved INSIDE the px-4 wrapper. Was
          rendered outside → ended up edge-to-edge while every other
          Card on the page was inset 16 px. Now visually flush with
          PreviewSummaryCard / ActiveRunPanel. */}
      <RunHistorySection
        runs={runsQuery.data ?? []}
        productName={productName}
        storeById={storeById}
        i18n={i18n}
        onOpenAll={() => setHistoryPageOpen(true)}
        onOpen={(r) =>
          setHistoryDetailFor({
            runId: r.id,
            runIndex: r.runIndex,
            runDate: r.runDate,
            status: r.status,
          })
        }
      />
      </div>

      {/* "Plan run" sheet — preview + lock-warning + confirm. Inside
          Telegram the MainButton drives the planRun action; outside
          Telegram (web preview) we still need an in-sheet button. */}
      <Sheet
        open={createOpen}
        onOpenChange={setCreateOpen}
        title={i18n.t('run.action.createNewRun')}
        description={i18n.t('run.action.aggregateInfo', {
          n: previewQuery.data?.sessions.length ?? 0,
        })}
        footer={
          // M3.49 (2026-05-23): dropped the `!getTg()` check — the
          // in-page PageMainButton is hidden behind any open sheet
          // (Radix Dialog z-50), so we MUST render the sheet's own
          // footer button regardless of Telegram presence.
          <Button
            block
            loading={create.isPending}
            disabled={!previewQuery.data?.sessions.length}
            onClick={() => {
              const sessionIds = previewQuery.data?.sessions.map((s) => s.id) ?? [];
              if (sessionIds.length === 0) return;
              create.mutate({ sessionIds, startImmediately: true });
            }}
          >
            {i18n.t('run.action.planRun')}
          </Button>
        }
      >
        <div className="flex flex-col gap-3 py-2">
          {previewQuery.data?.sessions.length ? (
            <Banner
              tone="warn"
              title={i18n.t('run.banner.planLockWarning', {
                n: previewQuery.data.sessions.length,
              })}
            />
          ) : null}
          <ul className="flex flex-col gap-2 text-body">
            {(previewQuery.data?.plannedItems ?? []).map((it) => {
              const sku = skuById.get(it.skuId);
              return (
                <li
                  key={it.skuId}
                  className="flex justify-between border-b border-[var(--c-divider)] py-2 last:border-b-0"
                >
                  <span>{sku ? productName(sku) : it.skuId.slice(0, 8)}</span>
                  <span className="font-mono tabular-nums">
                    {formatQty(it.qty)} {sku?.unit}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </Sheet>

      {/* M1.12: ⋯ run-actions Sheet removed — its three buttons
          (Undo start purchase / Undo start delivery / Cancel run)
          now live in Telegram's gear ⚙️ via usePageMenu(). */}

      <PurchaseSheet
        draft={purchaseDraft}
        skuById={skuById}
        storeById={storeById}
        suppliers={suppliersQuery.data ?? []}
        productName={productName}
        photoUploader={photoUploader}
        i18n={i18n}
        priceInThousands={priceInThousands}
        onCancel={() => setPurchaseDraft(null)}
        onChange={setPurchaseDraft}
        onSubmit={(d) => {
          const payload = {
            runId: d.runId,
            skuId: d.skuId,
            supplierId: d.supplierId,
            unitPrice: d.unitPrice,
            actualQty: d.actualQty,
            receiptPhotoUrl: d.receiptPhotoUrl,
            storeSplits: [...d.splits.entries()]
              .filter(([, q]) => Number(q) > 0)
              .map(([storeId, qty]) => ({
                storeId,
                qty,
                ...(d.perStorePricing
                  ? {
                      unitPrice: d.splitPrices.get(storeId) || d.unitPrice,
                      paymentMethod: d.splitPaymentMethods.get(storeId) ?? d.paymentMethod,
                    }
                  : {}),
              })),
            paymentMethod: d.paymentMethod,
          };
          if (d.isEdit) {
            revisePurchase.mutate({ ...payload, reason: d.reason });
          } else {
            purchaseItem.mutate(payload);
          }
        }}
        submitting={purchaseItem.isPending || revisePurchase.isPending}
      />

      {/* M3.41 (2026-05-21): mid-run "+ add item" sheet. SKU search +
          single-store selection + qty/price + payment + reason.
          Multi-store split deferred to v2 — single-store covers the
          90% case (chef-call-in, impromptu buy for a specific
          store). storeChoices is constrained to stores already in
          the run's scope (matches the domain layer's storeNotInRun
          guard). */}
      <AddItemSheet
        draft={addItemDraft}
        runStoreIds={(() => {
          const ids = new Set<string>();
          for (const it of runDetailQuery.data?.items ?? []) {
            for (const sp of runDetailQuery.data?.splits ?? []) {
              if (sp.skuId === it.skuId) ids.add(sp.storeId);
            }
          }
          for (const d of runDetailQuery.data?.perStoreDemand ?? []) ids.add(d.storeId);
          for (const sp of runDetailQuery.data?.splits ?? []) ids.add(sp.storeId);
          return [...ids];
        })()}
        existingStoreIdsBySku={(() => {
          // M3.54 (2026-05-23): for each SKU in the run, which stores
          // already have demand. AddItemSheet uses this to (1) still
          // SHOW in-run SKUs as long as some store hasn't claimed them
          // yet, (2) restrict the store dropdown to non-conflicting
          // stores, (3) print the "augmenting existing item" hint.
          const m = new Map<string, { storeIds: Set<string>; status: string }>();
          for (const it of runDetailQuery.data?.items ?? []) {
            m.set(it.skuId, { storeIds: new Set<string>(), status: it.status });
          }
          for (const sp of runDetailQuery.data?.splits ?? []) {
            const e = m.get(sp.skuId);
            if (e) e.storeIds.add(sp.storeId);
          }
          for (const d of runDetailQuery.data?.perStoreDemand ?? []) {
            const e = m.get(d.skuId);
            if (e) e.storeIds.add(d.storeId);
          }
          return m;
        })()}
        skus={skusQuery.data ?? []}
        expenseTemplates={expenseTemplatesQuery.data ?? []}
        storeById={storeById}
        productName={productName}
        photoUploader={photoUploader}
        i18n={i18n}
        priceInThousands={priceInThousands}
        onCancel={() => setAddItemDraft(null)}
        onChange={setAddItemDraft}
        onSubmit={(d) => {
          const storeSplits = [...d.splits.entries()]
            .filter(([, q]) => Number(q) > 0)
            .map(([storeId, qty]) => ({ storeId, qty }));
          if (d.mode === 'sku') {
            if (!d.skuId) return;
            // M3.54: detect cross-store augmentation case. If the SKU
            // is already in this run for OTHER stores (no overlap with
            // the new storeSplits — sheet's store-picker filter
            // already enforced that), route the submit through the
            // right existing-item mutation:
            //   - pending  → purchaseItem, merging existing demand
            //     splits with the new store split(s). The whole item
            //     gets marked purchased at the typed unitPrice (the
            //     purchaser is at the stall buying it now anyway).
            //   - purchased → revisePurchase, merging actual splits
            //     with the new store split(s). Reason gets reused
            //     from the sheet's reason field.
            //   - unavailable → blocked at the picker stage (SKU is
            //     filtered out), so this branch shouldn't fire.
            // Falls back to addPurchaserItem when the SKU is truly
            // new to the run (the only path that creates a fresh
            // purchaser-added row).
            const existingItem = runDetailQuery.data?.items.find(
              (it) => it.skuId === d.skuId,
            );
            const existingSplits = (runDetailQuery.data?.splits ?? []).filter(
              (sp) => sp.skuId === d.skuId,
            );
            const existingStoreIds = new Set(existingSplits.map((sp) => sp.storeId));
            const overlapsExistingStore = storeSplits.some((sp) =>
              existingStoreIds.has(sp.storeId),
            );
            if (
              existingItem &&
              (d.skuCostMode === 'separateExpense' || overlapsExistingStore)
            ) {
              const sku = skusQuery.data?.find((s) => s.id === d.skuId) ?? null;
              addExpense.mutate({
                runId: d.runId,
                expenseId: d.expenseId,
                label: sku ? productName(sku) : d.skuId.slice(0, 8),
                ...(sku?.unit ? { unitHint: sku.unit } : {}),
                qty: d.actualQty,
                unitPrice: d.unitPrice,
                storeSplits,
                paymentMethod: d.paymentMethod,
                receiptPhotoUrl: d.receiptPhotoUrl,
                reason: d.reason.trim(),
              });
              return;
            }
            if (existingItem) {
              const combinedSplits = [
                ...existingSplits.map((sp) => ({
                  storeId: sp.storeId,
                  qty: sp.qty,
                })),
                ...storeSplits,
              ];
              const combinedQty = combinedSplits
                .reduce((s, sp) => s + Number(sp.qty), 0)
                .toString();
              if (existingItem.status === 'pending') {
                purchaseItem.mutate({
                  runId: d.runId,
                  skuId: d.skuId,
                  supplierId: d.supplierId,
                  unitPrice: d.unitPrice,
                  actualQty: combinedQty,
                  receiptPhotoUrl: d.receiptPhotoUrl,
                  storeSplits: combinedSplits,
                  paymentMethod: d.paymentMethod,
                });
                setAddItemDraft(null);
                return;
              }
              if (existingItem.status === 'purchased') {
                revisePurchase.mutate({
                  runId: d.runId,
                  skuId: d.skuId,
                  supplierId: d.supplierId,
                  unitPrice: d.unitPrice,
                  actualQty: combinedQty,
                  receiptPhotoUrl: d.receiptPhotoUrl,
                  storeSplits: combinedSplits,
                  paymentMethod: d.paymentMethod,
                  reason:
                    d.reason.trim() ||
                    i18n.t('run.action.addItem.defaultCrossStoreReason'),
                });
                setAddItemDraft(null);
                return;
              }
              // unavailable — should be unreachable (filtered out
              // in the picker). Fall through and let the backend
              // 400 just in case the data races.
            }
            addPurchaserItem.mutate({
              runId: d.runId,
              skuId: d.skuId,
              supplierId: d.supplierId,
              unitPrice: d.unitPrice,
              actualQty: d.actualQty,
              receiptPhotoUrl: d.receiptPhotoUrl,
              storeSplits,
              paymentMethod: d.paymentMethod,
              reason: d.reason.trim(),
            });
          } else {
            // M3.44: expense mode → run.addExpense
            if (!d.label.trim()) return;
            addExpense.mutate({
              runId: d.runId,
              expenseId: d.expenseId,
              label: d.label.trim(),
              ...(d.unitHint.trim() ? { unitHint: d.unitHint.trim() } : {}),
              qty: d.actualQty,
              unitPrice: d.unitPrice,
              storeSplits,
              paymentMethod: d.paymentMethod,
              receiptPhotoUrl: d.receiptPhotoUrl,
              reason: d.reason.trim(),
            });
          }
        }}
        submitting={
          addPurchaserItem.isPending ||
          addExpense.isPending ||
          purchaseItem.isPending ||
          revisePurchase.isPending
        }
      />

      {/* Mark-unavailable sheet — primary action handled by MainButton
          inside Telegram. Footer button only outside Telegram. */}
      <Sheet
        open={!!unavailableFor}
        onOpenChange={(open) => !open && setUnavailableFor(null)}
        title={i18n.t('run.action.markUnavailable')}
        description={i18n.t('run.action.markUnavailableDesc')}
        footer={
          // M3.49: see RunPage's plan-run sheet for the rationale.
          <Button
            block
            variant="danger"
            disabled={!unavailableNote.trim()}
            loading={markUnavailable.isPending}
            onClick={() => {
              if (!unavailableFor) return;
              markUnavailable.mutate({
                runId: unavailableFor.runId,
                skuId: unavailableFor.skuId,
                note: unavailableNote.trim(),
              });
            }}
          >
            {i18n.t('run.action.markNa')}
          </Button>
        }
      >
        <div className="py-3">
          <Input
            value={unavailableNote}
            onChange={(e) => setUnavailableNote(e.target.value)}
            placeholder={i18n.t('run.action.unavailableReasonPlaceholder')}
            autoFocus
          />
        </div>
      </Sheet>

      {/* Generic confirm sheet for ALL the major transitions. Centralized
          so every "I changed my mind" path looks identical. */}
      <ConfirmSheet
        config={confirmConfig}
        reason={confirmReason}
        onReasonChange={setConfirmReason}
        onCancel={() => setConfirmAction(null)}
        i18n={i18n}
      />

      {/* Item & store action sheets removed (2026-05-03):
          User feedback was that for 100s of SKUs, opening a menu sheet
          for each tap is unbearable. Replaced with direct in-page editing:
          - Pending item rows: inline qty + price inputs + "N/A" link
          - Purchased item rows: tap-to-edit (opens PurchaseSheet for full
            form because edit requires reason field)
          - Unavailable item rows: "Restore" link (direct confirm sheet)
          - Pending store rows: tap → deliver-confirm sheet
          - Delivered store rows: tap → recall-confirm sheet
          - Confirmed store rows: read-only, not tappable. */}

      <RunHistoryDetailSheet
        target={historyDetailFor}
        skuById={skuById}
        storeById={storeById}
        productName={productName}
        i18n={i18n}
        onClose={() => setHistoryDetailFor(null)}
      />
    </div>
  );
}

// formatQty / formatMoney are imported from `../lib/format` —
// thousand-separator + max-1-decimal display rule applied everywhere.

/**
 * Active-run panel — INLINE-EDIT list rows.
 *
 * Design rationale (rewritten 2026-05-03 after user feedback):
 *
 *   "真正采购时物品很多,几百种东西要采购,一个一个点开非常麻烦"
 *
 * Translation: "When purchasing for real there are many items — hundreds.
 * Tapping each one open is intolerable." So we ditch the tap-row → action
 * sheet pattern entirely and edit IN PLACE:
 *
 *   - Purchasing phase, pending row:
 *       inline qty input + price input + N/A pill + (sometimes)
 *       "更多 splits…" link if multi-store and qty changes from planned.
 *       Auto-saves on price-field blur once qty AND price are valid.
 *   - Purchasing phase, purchased row:
 *       shows current values + small "Edit" link → opens PurchaseSheet
 *       (full form because RevisePurchase requires a reason field).
 *   - Purchasing phase, unavailable row:
 *       shows reason + small "Restore" link → opens "Mark available?"
 *       confirm sheet.
 *   - Delivering phase store rows:
 *       Tap row routes directly to the appropriate confirm sheet.
 *       Confirmed stores are read-only (not tappable).
 *
 * No more stacked menu sheets. Page-level Telegram MainButton still
 * drives Start purchase / Start delivery / Finish run.
 */
function ActiveRunPanel({
  run,
  skuById,
  categoryById,
  storeById,
  productName,
  i18n,
  priceInThousands,
  savingSkuId,
  onSavePurchaseInline,
  onMarkNa,
  onEditPurchased,
  onUnmark,
  onUndoPurchase,
  onOpenAdvancedPurchase,
  onDeliverStore,
  onRecallStore,
  onMarkExtraStatus,
  onRecordExtraExpense,
  onRemoveExpense,
  onOpenExpense,
}: {
  run: ActiveRun;
  skuById: Map<
    string,
    { id: string; names: Record<string, string>; unit: string; step: string; categoryId?: string | null }
  >;
  categoryById: Map<string, { id: string; names: Record<string, string> }>;
  storeById: Map<string, { id: string; name: string; code: string | null }>;
  productName: (item: { names: Record<string, string> | null | undefined }) => string;
  i18n: ReturnType<typeof useI18n>;
  /** M3.36: when true, inline price input + sheet input display `value/1000`
   *  and parse back to raw UZS on save. Page-level toggle in the
   *  sticky header. */
  priceInThousands: boolean;
  savingSkuId: string | null;
  onSavePurchaseInline: (payload: {
    skuId: string;
    actualQty: string;
    unitPrice: string;
    storeSplits: Array<{
      storeId: string;
      qty: string;
      unitPrice?: string;
      paymentMethod?: 'cash' | 'transfer';
    }>;
    paymentMethod: 'cash' | 'transfer';
  }) => void;
  onMarkNa: (skuId: string) => void;
  onEditPurchased: (item: ActiveRun['items'][number]) => void;
  onUnmark: (skuId: string, skuName: string) => void;
  onUndoPurchase: (skuId: string, skuName: string) => void;
  onOpenAdvancedPurchase: (item: ActiveRun['items'][number]) => void;
  onDeliverStore: (storeId: string, storeName: string) => void;
  onRecallStore: (storeId: string, storeName: string) => void;
  /** M3.37 (Wave2 #5): mark a single "其他物品" row's outcome. */
  onMarkExtraStatus: (
    sessionId: string,
    extraIndex: number,
    status: 'pending' | 'bought' | 'unavailable',
  ) => void;
  onRecordExtraExpense: (
    storeId: string,
    extra: { name: string; qty: string; unit: string; note?: string },
  ) => void;
  /** M3.44: remove an off-catalog expense (purchasing phase only). */
  onRemoveExpense: (expenseId: string, label: string) => void;
  onOpenExpense: () => void;
}) {
  const involvedStoreIds = useMemo(() => {
    const ids = new Set<string>();
    for (const sp of run.splits) ids.add(sp.storeId);
    return [...ids];
  }, [run.splits]);

  /**
   * Map of SKU → per-store demand pulled from the run's source sessions.
   * When the user just enters a price and leaves qty at planned, this is
   * what we send as `storeSplits`. Without this the client would dump
   * the entire qty into "first store" and the user would re-allocate by
   * hand on every line.
   */
  const demandBySku = useMemo(() => {
    const m = new Map<string, Array<{ storeId: string; qty: string }>>();
    for (const d of run.perStoreDemand ?? []) {
      const arr = m.get(d.skuId) ?? [];
      arr.push({ storeId: d.storeId, qty: d.qty });
      m.set(d.skuId, arr);
    }
    return m;
  }, [run.perStoreDemand]);

  /**
   * Inverse of `demandBySku` — `storeId → [{ skuId, qty }]`. Powers the
   * per-store view added 2026-05-05. We compute it once here rather
   * than per-render of each store card so a 10-store run with 50 SKUs
   * does ~500 ops instead of 5,000.
   */
  const skusByStore = useMemo(() => {
    const m = new Map<string, Array<{ skuId: string; qty: string }>>();
    for (const d of run.perStoreDemand ?? []) {
      const arr = m.get(d.storeId) ?? [];
      arr.push({ skuId: d.skuId, qty: d.qty });
      m.set(d.storeId, arr);
    }
    return m;
  }, [run.perStoreDemand]);

  /**
   * View toggle (added 2026-05-05).
   *
   * Default = `aggregate`: the current per-SKU list with inline +/- and
   * ✓-save buttons. Recording purchases happens here.
   *
   * `perStore` = read-only planning view: groups SKUs by store so the
   * purchaser can see "Store A wants 2kg apples + 1kg onions, Store B
   * wants 3kg apples". Useful before walking the market — they know
   * what to total in their head.
   *
   * Choice persists per-user via localStorage so a purchaser who
   * prefers per-store doesn't have to re-toggle every time.
   *
   * Toggle hidden when the run only spans 1 store (per-store view
   * would be a single card with the same content as aggregate).
   */
  // M3.27 (2026-05-18): third view mode — "perVendor". Same persistence
  // key; old values 'aggregate'|'perStore' continue to round-trip.
  type ViewMode = 'aggregate' | 'perStore' | 'perVendor' | 'perCategory';
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const saved = localStorage.getItem('compass.run.viewMode');
      if (saved === 'perStore' || saved === 'perVendor' || saved === 'perCategory') return saved;
      return 'aggregate';
    } catch {
      return 'aggregate';
    }
  });
  const setViewModePersist = (mode: ViewMode) => {
    setViewMode(mode);
    try {
      localStorage.setItem('compass.run.viewMode', mode);
    } catch {
      /* localStorage disabled / quota — non-fatal */
    }
  };
  // Distinct stores referenced by perStoreDemand. Falls back to splits
  // (legacy runs without perStoreDemand still have splits once they
  // start delivering).
  const demandStoreIds = useMemo(() => {
    const ids = new Set<string>();
    for (const d of run.perStoreDemand ?? []) ids.add(d.storeId);
    if (ids.size === 0) {
      for (const sp of run.splits) ids.add(sp.storeId);
    }
    return [...ids];
  }, [run.perStoreDemand, run.splits]);
  // Distinct suppliers (including unassigned bucket) across the run's
  // SKUs — gates whether the vendor toggle is worth showing.
  const distinctSupplierCount = useMemo(() => {
    if (!run.supplierBySku) return 0;
    const ids = new Set<string>();
    for (const it of run.items) {
      ids.add(run.supplierBySku[it.skuId]?.id ?? '__unassigned__');
    }
    return ids.size;
  }, [run.items, run.supplierBySku]);
  const distinctCategoryCount = useMemo(() => {
    const ids = new Set<string>();
    for (const it of run.items) {
      ids.add(skuById.get(it.skuId)?.categoryId ?? '__uncategorized__');
    }
    return ids.size;
  }, [run.items, skuById]);
  // M3.27 (2026-05-18): showing perStore needs ≥2 stores; showing
  // perVendor needs ≥2 supplier buckets (including unassigned). The
  // toggle itself shows when either condition holds — even if only
  // one of the two extra views would be useful, the user can pick.
  const showPerStore = demandStoreIds.length >= 2;
  const showPerVendor = distinctSupplierCount >= 2;
  const showPerCategory = distinctCategoryCount >= 2;
  const showViewToggle =
    (run.status === 'planned' || run.status === 'purchasing') &&
    (showPerStore || showPerVendor || showPerCategory);

  return (
    <div className="flex flex-col gap-2">
      {/* View-mode toggle — M3.28 (2026-05-18): dropped the "Aggregate"
          chip per user feedback. The aggregate view is the editing
          surface where price/qty get recorded; it's not a "view" the
          user thinks about toggling INTO. They wanted just two view
          chips ("by store", "by vendor") that they can toggle ON to
          see the run grouped, and toggle OFF to return to the
          edit-able aggregate. Tapping a selected chip deselects it.
          Shown only when the run actually spans multiple stores OR
          multiple vendor buckets — a single-store / single-vendor run
          short-circuits straight to aggregate. */}
      {showViewToggle ? (
        <div className="border-b border-[var(--c-divider)] bg-[var(--c-bg)] py-1">
          <ChipBar ariaLabel="Run view mode">
            {showPerStore ? (
              <Chip
                selected={viewMode === 'perStore'}
                onClick={() =>
                  setViewModePersist(viewMode === 'perStore' ? 'aggregate' : 'perStore')
                }
              >
                {i18n.t('run.view.perStore')}
              </Chip>
            ) : null}
            {showPerVendor ? (
              <Chip
                selected={viewMode === 'perVendor'}
                onClick={() =>
                  setViewModePersist(viewMode === 'perVendor' ? 'aggregate' : 'perVendor')
                }
              >
                {i18n.t('run.view.perVendor')}
              </Chip>
            ) : null}
            {showPerCategory ? (
              <Chip
                selected={viewMode === 'perCategory'}
                onClick={() =>
                  setViewModePersist(viewMode === 'perCategory' ? 'aggregate' : 'perCategory')
                }
              >
                按类型
              </Chip>
            ) : null}
          </ChipBar>
        </div>
      ) : null}
      {showViewToggle && viewMode === 'perStore' && showPerStore ? (
        <PerStoreView
          run={run}
          storeById={storeById}
          skuById={skuById}
          productName={productName}
          skusByStore={skusByStore}
        />
      ) : null}
      {showViewToggle && viewMode === 'perVendor' && showPerVendor ? (
        <PerVendorView
          run={run}
          skuById={skuById}
          storeById={storeById}
          productName={productName}
          i18n={i18n}
          priceInThousands={priceInThousands}
          savingSkuId={savingSkuId}
          demandBySku={demandBySku}
          onSavePurchaseInline={onSavePurchaseInline}
          onMarkNa={onMarkNa}
          onUndoPurchase={onUndoPurchase}
          onOpenAdvancedPurchase={onOpenAdvancedPurchase}
          onEditPurchased={onEditPurchased}
          onUnmark={onUnmark}
          onMarkExtraStatus={onMarkExtraStatus}
          onRecordExtraExpense={onRecordExtraExpense}
        />
      ) : null}
      {showViewToggle && viewMode === 'perCategory' && showPerCategory ? (
        <PerCategoryView
          run={run}
          skuById={skuById}
          categoryById={categoryById}
          storeById={storeById}
          productName={productName}
          i18n={i18n}
          priceInThousands={priceInThousands}
          savingSkuId={savingSkuId}
          demandBySku={demandBySku}
          onSavePurchaseInline={onSavePurchaseInline}
          onMarkNa={onMarkNa}
          onUndoPurchase={onUndoPurchase}
          onOpenAdvancedPurchase={onOpenAdvancedPurchase}
          onEditPurchased={onEditPurchased}
          onUnmark={onUnmark}
        />
      ) : null}
      {(!showViewToggle ||
        viewMode === 'aggregate' ||
        (viewMode === 'perStore' && !showPerStore) ||
        (viewMode === 'perVendor' && !showPerVendor) ||
        (viewMode === 'perCategory' && !showPerCategory)) &&
      (run.status === 'planned' || run.status === 'purchasing') && run.items.length > 0 ? (
        <Card>
          {/* M2.1: SectionLabel (was 3-line ad-hoc div). Same visual,
              standardised primitive so every section eyebrow renders
              identically across the app. */}
          <SectionLabel
            meta={i18n.t('run.label.pendingFraction', {
              done: run.items.filter((i) => i.status === 'pending').length,
              total: run.items.length,
            })}
          >
            {i18n.t('run.section.items')}
          </SectionLabel>
          <ul className="flex flex-col" role="list">
            {run.items.map((it) => {
              const sku = skuById.get(it.skuId);
              const skuName = sku ? productName(sku) : it.skuId.slice(0, 8);
              // M3.52: pluck this SKU's recorded splits for the
              // per-store breakdown chips shown under purchased rows.
              // Pending rows fall back to planned demand inside the
              // row component — so we pass both regardless of status.
              const actualSplits = run.splits
                .filter((sp) => sp.skuId === it.skuId)
                .map((sp) => ({
                  storeId: sp.storeId,
                  qty: sp.qty,
                  unitPrice: sp.unitPrice,
                  paymentMethod: sp.paymentMethod,
                }));
              return (
                <PurchaseRow
                  key={it.skuId}
                  item={it}
                  skuName={skuName}
                  unit={sku?.unit ?? ''}
                  step={sku?.step ?? '0.1'}
                  demand={demandBySku.get(it.skuId) ?? []}
                  storeById={storeById}
                  actualSplits={actualSplits}
                  isMultiStoreRun={demandStoreIds.length > 1}
                  lastPrice={run.lastPriceBySku?.[it.skuId] ?? null}
                  i18n={i18n}
                  priceInThousands={priceInThousands}
                  saving={savingSkuId === it.skuId}
                  onSave={onSavePurchaseInline}
                  onMarkNa={onMarkNa}
                  onEdit={onEditPurchased}
                  onUnmark={onUnmark}
                  onUndoPurchase={onUndoPurchase}
                  onOpenAdvanced={onOpenAdvancedPurchase}
                />
              );
            })}
          </ul>
        </Card>
      ) : null}

      {/* M3.31 (2026-05-18, A.1): "其他物品" footer for the aggregate edit
          surface too. Until this fix, staff-typed extras (structured
          M3.16-C entries) disappeared from the purchaser's view the
          moment a run started — they only existed in the preview
          UI. Now they sit right under the per-SKU list so the
          purchaser sees them while recording buys. */}
      {(!showViewToggle ||
        viewMode === 'aggregate' ||
        (viewMode === 'perStore' && !showPerStore) ||
        (viewMode === 'perVendor' && !showPerVendor) ||
        (viewMode === 'perCategory' && !showPerCategory)) &&
      (run.status === 'planned' || run.status === 'purchasing') ? (
        <RunExtrasCard
          sessionExtrasByStore={run.sessionExtrasByStore}
          sessionNotesByStore={run.sessionNotesByStore}
          storeById={storeById}
          i18n={i18n}
          editable={run.status === 'purchasing'}
          onMarkExtraStatus={onMarkExtraStatus}
          onRecordExtraExpense={onRecordExtraExpense}
        />
      ) : null}

      {/* M3.44 (2026-05-22): off-catalog expenses card. Rendered in
          aggregate / perVendor view BELOW the items + extras
          sections. Always visible (read-only in non-purchasing
          phases) so the manager can see "what off-plan was spent"
          from any page state. */}
      {(!showViewToggle ||
        viewMode === 'aggregate' ||
        (viewMode === 'perStore' && !showPerStore) ||
        (viewMode === 'perVendor' && !showPerVendor) ||
        (viewMode === 'perCategory' && !showPerCategory)) &&
      (run.status === 'purchasing' || (run.expenses?.length ?? 0) > 0) ? (
        <ExpensesCard
          expenses={run.expenses}
          storeById={storeById}
          i18n={i18n}
          priceInThousands={priceInThousands}
          editable={run.status === 'purchasing'}
          onRemove={onRemoveExpense}
          onOpenExpense={onOpenExpense}
        />
      ) : null}

      {run.status === 'delivering' && involvedStoreIds.length > 0 ? (
        <Card>
          {/* M2.1: SectionLabel (was ad-hoc eyebrow div). */}
          <SectionLabel
            meta={i18n.t('run.label.confirmedFraction', {
              done: involvedStoreIds.filter((sid) =>
                run.splits.filter((sp) => sp.storeId === sid).every((sp) => !!sp.confirmedAt),
              ).length,
              total: involvedStoreIds.length,
            })}
          >
            {i18n.t('run.section.stores')}
          </SectionLabel>
          <ul className="flex flex-col" role="list">
            {involvedStoreIds.map((storeId) => {
              const store = storeById.get(storeId);
              const storeName = store?.name ?? storeId.slice(0, 8);
              const splitsHere = run.splits.filter((sp) => sp.storeId === storeId);
              const allDelivered = splitsHere.every((sp) => !!sp.deliveredAt);
              const allConfirmed = splitsHere.every((sp) => !!sp.confirmedAt);
              const stage: 'pending' | 'delivered' | 'confirmed' = allConfirmed
                ? 'confirmed'
                : allDelivered
                  ? 'delivered'
                  : 'pending';
              // M1.9-fix (2026-05-07): subtitle/badge label were rendered
              // as raw English. The delivery store list is the
              // purchaser's main during-run view; non-English users were
              // seeing English on every store row.
              const subtitle = i18n.t(('run.deliveryStage.' + stage) as Parameters<typeof i18n.t>[0]);
              const stageLabel = i18n.t(('run.deliveryStageBadge.' + stage) as Parameters<typeof i18n.t>[0]);
              const tone =
                stage === 'confirmed' ? 'success' : stage === 'delivered' ? 'info' : 'muted';
              const tappable = stage !== 'confirmed';
              /* Single-line layout: name + meta + badge.
                 Was a 2-line stacked block (~64px); now ~40px tappable. */
              const inner = (
                <>
                  <span className="shrink-0 truncate text-body font-semibold">{storeName}</span>
                  <span className="min-w-0 flex-1 truncate text-label text-[var(--c-fg-muted)]">
                    {i18n.t('run.label.itemsCount', { n: splitsHere.length })} · {subtitle}
                  </span>
                  <Badge tone={tone}>{stageLabel}</Badge>
                </>
              );
              return (
                <li
                  key={storeId}
                  className="border-b border-[var(--c-divider)] last:border-b-0"
                >
                  {tappable ? (
                    <button
                      type="button"
                      onClick={() =>
                        stage === 'pending'
                          ? onDeliverStore(storeId, storeName)
                          : onRecallStore(storeId, storeName)
                      }
                      className="flex w-full items-center gap-2 px-4 py-2 text-left active:bg-[var(--c-surface-2)]"
                    >
                      {inner}
                    </button>
                  ) : (
                    <div className="flex w-full items-center gap-2 px-4 py-2 text-[var(--c-fg-muted)]">
                      {inner}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      ) : null}

      {/* M1.11: dropped run.banner.readyToStart — its content
          ("Tap Start Purchase when ready") is already conveyed by the
          MainButton sitting at the bottom of the page in the same state.
          The banner just took up vertical space without adding info. */}
    </div>
  );
}

/**
 * Per-store view (added 2026-05-05).
 *
 * Read-only planning aid for multi-store runs. Groups SKUs by store
 * so a purchaser can mentally tally "Store A wants 2kg apples, Store
 * B wants 3kg apples" before walking the market. The actual purchase
 * recording happens in the Aggregate view — keeping a single source
 * of truth avoids the "did I already buy these?" footgun the agent
 * flagged in the audit.
 *
 * Each store card shows:
 *   - Store name + a 12px "X SKUs · total Y units" line
 *   - One row per SKU: name + qty for that store
 *
 * Sort: stores by name; SKUs within store by sortIndex (which
 * mirrors the catalog order in OrderPage).
 */

/**
 * PreviewSummaryCard — the "ready to plan" summary on RunPage with
 * three views (M1.5, 2026-05-06):
 *
 *   - Overall    : flat SKU list (legacy behavior, unchanged shape).
 *   - By store   : each store's combined order list, with a "Copy
 *                  list" button per store.
 *   - By supplier: each preferred-vendor's preparation list, with a
 *                  per-store breakdown under each item and a "Copy →
 *                  send to vendor" button that produces a localized
 *                  text template the operator can paste into the
 *                  vendor's chat. SKUs with no preferred vendor land
 *                  in an "Unassigned" group.
 *
 * The user explicitly asked for both views: "采购员发给摊位 让他们提前
 * 按每个店铺的采购量分开准备好". This is the per-supplier flow. The
 * per-store view is the inverse — useful when the chain owner wants
 * to see "what is each store getting today" at a glance.
 *
 * Persists view choice in localStorage so the operator's preference
 * survives page navigation.
 */
type PreviewView = 'overall' | 'byStore' | 'bySupplier';
const PREVIEW_VIEW_STORAGE_KEY = 'compass.runPreview.view';

type PreviewLine = {
  id: string;
  kind: 'sku' | 'extra';
  skuId: string | null;
  name: string;
  qty: string;
  unit: string;
  unitPrice: string | null;
  total: number | null;
  note?: string;
};

type PreviewStoreGroup = {
  storeId: string;
  storeName: string;
  items: PreviewLine[];
  total: number;
  unknownCount: number;
  legacyNote?: string;
};

type PreviewSupplierGroup = {
  supplierId: string | null;
  supplierName: string;
  contactPhone: string | null;
  contactTg: string | null;
  stores: PreviewStoreGroup[];
  total: number;
  unknownCount: number;
};

function previewLineTotal(qty: string, unitPrice: string | null): number | null {
  if (!unitPrice) return null;
  const qtyNum = Number(qty);
  const priceNum = Number(unitPrice);
  if (!Number.isFinite(qtyNum) || !Number.isFinite(priceNum)) return null;
  return qtyNum * priceNum;
}

function addPreviewLine(group: PreviewStoreGroup, line: PreviewLine): void {
  group.items.push(line);
  if (line.total === null) group.unknownCount += 1;
  else group.total += line.total;
}

function PreviewSummaryCard({
  preview,
  skuById,
  productName,
  i18n,
  toast,
}: {
  preview: {
    // M3.24 (2026-05-18): nullable when the caller didn't ask for a
    // specific date — preview then spans every approved-not-in-run
    // session regardless of order_date.
    date: string | null;
    sessions: ReadonlyArray<{ id: string; storeId: string; storeName?: string; orderDate?: string }>;
    plannedItems: ReadonlyArray<{ skuId: string; qty: string }>;
    perStoreDemand: ReadonlyArray<{
      storeId: string;
      storeName: string;
      skuId: string;
      qty: string;
    }>;
    supplierBySku: Record<string, {
      id: string;
      name: string;
      contactPhone: string | null;
      contactTg: string | null;
      defaultPrice?: string | null;
      lastSeenPrice?: string | null;
      estimatedUnitPrice?: string | null;
    } | null>;
    lastPurchasePriceBySku?: Record<string, string>;
    perStoreBudgets?: ReadonlyArray<{
      storeId: string;
      storeName: string;
      estimatedTotal: string;
      unknownPriceCount: number;
    }>;
    /** M1.8: per-store concatenated session notes ("其他物品", legacy). */
    sessionNotesByStore?: Record<string, string>;
    /** M3.16-C: per-store structured extras. */
    sessionExtrasByStore?: Record<
      string,
      Array<{ name: string; qty: string; unit: string; note?: string; sessionId?: string; idx?: number }>
    >;
  };
  skuById: Map<
    string,
    { id: string; names: Record<string, string>; unit: string; step: string; categoryId?: string | null }
  >;
  productName: (item: { names: Record<string, string> | null | undefined }) => string;
  i18n: ReturnType<typeof useI18n>;
  toast: ReturnType<typeof useToast>;
}) {
  const [view, setView] = useState<PreviewView>(() => {
    if (typeof window === 'undefined') return 'overall';
    const v = window.localStorage.getItem(PREVIEW_VIEW_STORAGE_KEY);
    return v === 'byStore' || v === 'bySupplier' ? v : 'overall';
  });
  // M1.6 #1: when set, the VendorPickerSheet is open for this skuId.
  const [vendorPickerFor, setVendorPickerFor] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const currency = useAuthStore((s) => s.session?.member.currency) ?? 'UZS';
  const currentUnitLabel = useCallback(
    (unit: string | null | undefined): string => {
      if (!unit) return '';
      const canonical = unit.toLowerCase();
      const key = ('unit.' + canonical) as Parameters<typeof i18n.t>[0];
      const localized = i18n.t(key);
      return localized === key ? unit : localized;
    },
    [i18n],
  );
  const currentSkuName = useCallback(
    (item: { names: Record<string, string> | null | undefined }): string => {
      const names = item.names ?? {};
      return (
        names[i18n.locale] ??
        names.en ??
        names.ru ??
        names.zh ??
        names.uz ??
        Object.values(names)[0] ??
        '—'
      );
    },
    [i18n.locale],
  );
  useEffect(() => {
    if (typeof window !== 'undefined')
      window.localStorage.setItem(PREVIEW_VIEW_STORAGE_KEY, view);
  }, [view]);

  const storeNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const row of preview.perStoreDemand) m.set(row.storeId, row.storeName);
    for (const row of preview.perStoreBudgets ?? []) m.set(row.storeId, row.storeName);
    for (const row of preview.sessions) {
      if (row.storeName) m.set(row.storeId, row.storeName);
    }
    return m;
  }, [preview.perStoreBudgets, preview.perStoreDemand, preview.sessions]);

  const estimatedPriceForSku = useCallback(
    (skuId: string): string | null =>
      preview.lastPurchasePriceBySku?.[skuId] ??
      preview.supplierBySku[skuId]?.estimatedUnitPrice ??
      null,
    [preview.lastPurchasePriceBySku, preview.supplierBySku],
  );

  const ensurePreviewStoreGroup = useCallback(
    (m: Map<string, PreviewStoreGroup>, storeId: string, storeName?: string) => {
      let cur = m.get(storeId);
      if (!cur) {
        cur = {
          storeId,
          storeName: storeName ?? storeNameById.get(storeId) ?? storeId.slice(0, 8),
          items: [],
          total: 0,
          unknownCount: 0,
        };
        m.set(storeId, cur);
      } else if (storeName && cur.storeName === storeId.slice(0, 8)) {
        cur.storeName = storeName;
      }
      return cur;
    },
    [storeNameById],
  );

  const byStore = useMemo(() => {
    const m = new Map<string, PreviewStoreGroup>();
    for (const row of preview.perStoreDemand) {
      const sku = skuById.get(row.skuId);
      const unitPrice = estimatedPriceForSku(row.skuId);
      const group = ensurePreviewStoreGroup(m, row.storeId, row.storeName);
      addPreviewLine(group, {
        id: `sku:${row.storeId}:${row.skuId}`,
        kind: 'sku',
        skuId: row.skuId,
        name: sku ? productName(sku) : row.skuId.slice(0, 8),
        qty: row.qty,
        unit: currentUnitLabel(sku?.unit),
        unitPrice,
        total: previewLineTotal(row.qty, unitPrice),
      });
    }

    for (const [storeId, extras] of Object.entries(preview.sessionExtrasByStore ?? {})) {
      const group = ensurePreviewStoreGroup(m, storeId);
      for (const ex of extras) {
        addPreviewLine(group, {
          id: `extra:${storeId}:${ex.sessionId ?? ''}:${ex.idx ?? group.items.length}:${ex.name}`,
          kind: 'extra',
          skuId: null,
          name: ex.name,
          qty: ex.qty,
          unit: ex.unit,
          unitPrice: null,
          total: null,
          note: ex.note,
        });
      }
    }

    for (const [storeId, note] of Object.entries(preview.sessionNotesByStore ?? {})) {
      const trimmed = note.trim();
      if (!trimmed) continue;
      ensurePreviewStoreGroup(m, storeId).legacyNote = trimmed;
    }

    return [...m.values()]
      .filter((g) => g.items.length > 0 || g.legacyNote)
      .sort((a, b) => a.storeName.localeCompare(b.storeName));
  }, [
    ensurePreviewStoreGroup,
    currentUnitLabel,
    estimatedPriceForSku,
    preview.perStoreDemand,
    preview.sessionExtrasByStore,
    preview.sessionNotesByStore,
    productName,
    skuById,
  ]);

  const bySupplier = useMemo(() => {
    const buckets = new Map<string, PreviewSupplierGroup>();
    const ensureSupplier = (
      supplierId: string | null,
      supplierName: string,
      contactPhone: string | null,
      contactTg: string | null,
    ) => {
      const key = supplierId ?? '__unassigned__';
      let cur = buckets.get(key);
      if (!cur) {
        cur = {
          supplierId,
          supplierName,
          contactPhone,
          contactTg,
          stores: [],
          total: 0,
          unknownCount: 0,
        };
        buckets.set(key, cur);
      }
      return cur;
    };
    const ensureSupplierStore = (
      supplier: PreviewSupplierGroup,
      storeId: string,
      storeName: string,
    ) => {
      let cur = supplier.stores.find((s) => s.storeId === storeId);
      if (!cur) {
        cur = {
          storeId,
          storeName,
          items: [],
          total: 0,
          unknownCount: 0,
        };
        supplier.stores.push(cur);
      }
      return cur;
    };

    for (const store of byStore) {
      for (const line of store.items) {
        const supplier =
          line.kind === 'sku' && line.skuId
            ? preview.supplierBySku[line.skuId] ?? null
            : null;
        const bucket = ensureSupplier(
          supplier?.id ?? null,
          supplier?.name ?? i18n.t('run.previewSupplier.unassigned'),
          supplier?.contactPhone ?? null,
          supplier?.contactTg ?? null,
        );
        const storeBucket = ensureSupplierStore(bucket, store.storeId, store.storeName);
        addPreviewLine(storeBucket, line);
        if (line.total === null) bucket.unknownCount += 1;
        else bucket.total += line.total;
      }
      if (store.legacyNote) {
        const bucket = ensureSupplier(
          null,
          i18n.t('run.previewSupplier.unassigned'),
          null,
          null,
        );
        ensureSupplierStore(bucket, store.storeId, store.storeName).legacyNote =
          store.legacyNote;
      }
    }

    return [...buckets.values()]
      .map((b) => ({
        ...b,
        stores: b.stores.sort((a, b2) => a.storeName.localeCompare(b2.storeName)),
      }))
      .sort((a, b) => {
        if (a.supplierId === null) return 1;
        if (b.supplierId === null) return -1;
        return a.supplierName.localeCompare(b.supplierName);
      });
  }, [byStore, i18n, preview.supplierBySku]);

  const groupMoneyMeta = (total: number, unknownCount: number): string => {
    const parts = [
      `${i18n.t('run.preview.groupTotal')} ${formatMoney(total)} ${currency}`,
    ];
    if (unknownCount > 0) {
      parts.push(i18n.t('run.preview.unknownPrices', { n: unknownCount }));
    }
    return parts.join(' · ');
  };

  const lineFormula = (line: PreviewLine): string => {
    const qtyUnit = `${formatQty(line.qty)} ${line.unit}`.trim();
    if (line.total === null || !line.unitPrice) {
      return `${qtyUnit} * ${i18n.t('run.preview.priceUnknown')} = ${i18n.t(
        'run.preview.priceUnknown',
      )}`;
    }
    return `${qtyUnit} * ${formatMoney(line.unitPrice)} = ${formatMoney(line.total)}`;
  };

  const copyToClipboard = async (text: string): Promise<boolean> => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
      } else {
        // Fallback for environments without clipboard API.
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      return true;
    } catch {
      return false;
    }
  };

  const shareOrCopyText = async (text: string): Promise<void> => {
    const copied = await copyToClipboard(text);
    let opened = false;
    const url = shareLink({ url: '', text });
    try {
      const tg = getTg();
      if (tg?.openTelegramLink) {
        tg.openTelegramLink(url);
        opened = true;
      } else if (typeof window !== 'undefined') {
        opened = window.open(url, '_blank', 'noopener,noreferrer') !== null;
      }
    } catch {
      opened = false;
    }
    if (opened) {
      toast.success(
        i18n.t(copied ? 'run.previewShare.openedWithCopy' : 'run.previewShare.opened'),
      );
      haptic('success');
      return;
    }
    if (copied) {
      toast.success(i18n.t('run.previewStore.copied'));
      haptic('success');
      return;
    }
    toast.error(i18n.t('common.error'));
  };

  const formatLineForText = (line: PreviewLine): string => {
    const sku = line.skuId ? skuById.get(line.skuId) : null;
    const name = sku ? currentSkuName(sku) : line.name;
    const unit = sku ? currentUnitLabel(sku.unit) : line.unit;
    const qtyUnit = `${formatQty(line.qty)} ${unit}`.trim();
    const prefix = line.kind === 'extra' ? `${i18n.t('order.extras.label')} · ` : '';
    const note = line.note ? `\n  ${line.note}` : '';
    return `${prefix}${name}: ${qtyUnit}${note}`;
  };

  const buildStoreText = (group: PreviewStoreGroup): string => {
    const lines = [group.storeName, ''];
    for (const line of group.items) lines.push(formatLineForText(line));
    if (group.legacyNote) {
      lines.push('', `${i18n.t('order.notes.label')}:`, group.legacyNote);
    }
    return lines.join('\n').trim();
  };

  const buildSupplierText = (group: PreviewSupplierGroup): string => {
    const lines = [group.supplierName, ''];
    for (const store of group.stores) {
      lines.push(store.storeName);
      for (const line of store.items) lines.push(formatLineForText(line));
      if (store.legacyNote) {
        lines.push(`${i18n.t('order.notes.label')}:`, store.legacyNote);
      }
      lines.push('');
    }
    return lines.join('\n').trim();
  };

  const buildAllVendorsText = (): string => {
    return bySupplier.map(buildSupplierText).filter(Boolean).join('\n\n');
  };

  const isCollapsed = (key: string): boolean => collapsedGroups[key] === true;
  const toggleGroup = (key: string): void => {
    setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };
  const handleGroupHeaderKeyDown = (e: KeyboardEvent<HTMLDivElement>, key: string): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    toggleGroup(key);
  };

  const renderLine = (
    line: PreviewLine,
    index: number,
    opts?: { editableSupplier?: boolean },
  ) => {
    const rowBg = index % 2 === 0 ? 'bg-[var(--c-surface)]' : 'bg-[var(--c-surface-2)]';
    const formulaTone =
      line.total === null ? 'text-[var(--c-warning)]' : 'text-[var(--c-fg-muted)]';
    const nameNode =
      opts?.editableSupplier && line.kind === 'sku' && line.skuId ? (
        <button
          type="button"
          onClick={() => setVendorPickerFor(line.skuId)}
          className="press min-w-0 max-w-full text-left text-[var(--c-fg)]"
          title={i18n.t('run.previewSupplier.changeVendor')}
        >
          {line.name}
        </button>
      ) : (
        <span className="min-w-0 max-w-full text-[var(--c-fg)]">{line.name}</span>
      );
    return (
      <li
        key={line.id}
        className={`px-2 py-1.5 ${rowBg}`}
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-body">
            {line.kind === 'extra' ? (
              <span className="shrink-0 rounded-[var(--r-pill)] bg-[var(--c-warn-bg)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--c-warning)] ring-hairline">
                {i18n.t('order.extras.label')}
              </span>
            ) : null}
            {nameNode}
            <span className={`min-w-0 font-mono text-label tabular-nums ${formulaTone}`}>
              {lineFormula(line)}
            </span>
          </div>
          {line.note ? (
            <div className="mt-0.5 whitespace-pre-wrap text-label leading-snug text-[var(--c-fg-muted)]">
              {line.note}
            </div>
          ) : null}
        </div>
      </li>
    );
  };

  return (
    <Card className="-mx-2 overflow-hidden rounded-[var(--r-capsule)]">
      <CardHeader className="px-3 pt-3">
        <CardTitle>{i18n.t('run.section.readyToPlan')}</CardTitle>
        <Badge>{i18n.t('run.label.sessionsCount', { n: preview.sessions.length })}</Badge>
      </CardHeader>
      {/* Segmented control — sticky horizontal pill bar, same visual
          language as ScopeTab in MemberPermissionsSheet. Three taps
          here, all instant (no async work — all data is in `preview`). */}
      <div className="flex gap-1 px-3 pb-2 pt-1">
        {(['overall', 'byStore', 'bySupplier'] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={
              'press flex-1 rounded-[var(--r-pill)] px-3 py-1.5 text-label font-medium ring-hairline ' +
              (view === v
                ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
                : 'bg-[var(--c-surface-2)] text-[var(--c-fg)]')
            }
          >
            {i18n.t(
              v === 'overall'
                ? 'run.previewView.overall'
                : v === 'byStore'
                  ? 'run.previewView.byStore'
                  : 'run.previewView.bySupplier',
            )}
          </button>
        ))}
      </div>

      {preview.perStoreBudgets?.length ? (
        <div className="border-t border-[var(--c-divider)] px-3 py-2">
          <div className="mb-1 text-label font-semibold text-[var(--c-fg-muted)]">
            分店预算
          </div>
          <div className="flex flex-col gap-1">
            {preview.perStoreBudgets.map((b) => (
              <div key={b.storeId} className="flex items-baseline gap-2 text-body-sm">
                <span className="min-w-0 flex-1 truncate">{b.storeName}</span>
                {b.unknownPriceCount > 0 ? (
                  <span className="shrink-0 text-label text-[var(--c-warning)]">
                    {b.unknownPriceCount} 个无参考价
                  </span>
                ) : null}
                <span className="shrink-0 font-mono tabular-nums text-[var(--c-fg)]">
                  {formatMoney(b.estimatedTotal)} {currency}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {view === 'overall' ? (
        /* M1.11: dropped the "+N more" tail row. We still slice to 8
            so the summary card stays bounded, but the teaser line just
            advertised content the user can't expand here — they'll see
            the full list once the run is created. */
        <ul className="flex flex-col gap-1 px-3 py-2">
          {preview.plannedItems.slice(0, 8).map((it) => {
            const sku = skuById.get(it.skuId);
            return (
              <li key={it.skuId} className="flex justify-between text-body">
                <span>{sku ? productName(sku) : it.skuId.slice(0, 8)}</span>
                <span className="font-mono tabular-nums">
                  {formatQty(it.qty)} {sku?.unit}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}

      {view === 'byStore' ? (
        <div className="px-2 py-2">
          {byStore.map((g) => {
            const collapsed = isCollapsed(`store:${g.storeId}`);
            const storeNote = g.legacyNote;
            const groupKey = `store:${g.storeId}`;
            return (
            <section
              key={g.storeId}
              className="border-t border-[var(--c-divider)] py-2 first:border-t-0 first:pt-0 last:pb-0"
            >
              <div
                role="button"
                tabIndex={0}
                aria-expanded={!collapsed}
                onClick={() => toggleGroup(groupKey)}
                onKeyDown={(e) => handleGroupHeaderKeyDown(e, groupKey)}
                className="press mb-1.5 flex cursor-pointer items-start gap-2 rounded-[var(--r-utility)] bg-[var(--c-surface-2)] px-2 py-1.5 outline-none focus-visible:ring-1 focus-visible:ring-[var(--c-ring)]"
              >
                <span className="mt-0.5 shrink-0 font-mono text-label text-[var(--c-fg-muted)]">
                  {collapsed ? '+' : '-'}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-body font-semibold text-[var(--c-fg)]">
                    {g.storeName}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-label tabular-nums text-[var(--c-fg-muted)]">
                    {groupMoneyMeta(g.total, g.unknownCount)}
                  </div>
                </div>
                {/* M2.1: Button component (was raw <button>). */}
                <Button
                  variant="pearl"
                  size="sm"
                  className="shrink-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    void shareOrCopyText(buildStoreText(g));
                  }}
                >
                  {i18n.t('run.previewShare.sendList')}
                </Button>
              </div>
              <ul className={collapsed ? 'hidden' : 'overflow-hidden rounded-[var(--r-utility)]'}>
                {g.items.map((line, idx) => renderLine(line, idx))}
              </ul>
              {/* M1.8 / M3.16-C: surface the staff's "其他物品" requests
                  inline. M3.16-C structured extras render as one row
                  per item; legacy free-text notes (pre-M3.16) appended
                  underneath in italic. The purchaser scrolls the by-
                  store view at the market and needs requests right
                  next to the SKU list. */}
              {!collapsed && storeNote ? (
                <div className="mt-1.5 rounded-[var(--r-utility)] bg-[var(--c-warn-bg)] px-2 py-1.5">
                  <SectionLabel padded={false}>
                    {i18n.t('order.extras.label')}
                  </SectionLabel>
                  {storeNote ? (
                    <div className="mt-1 whitespace-pre-wrap text-body-sm italic leading-snug text-[var(--c-fg-muted)]">
                      {storeNote}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>
            );
          })}
        </div>
      ) : null}

      {view === 'bySupplier' ? (
        <div className="px-2 py-2">
          {/* M3.26 (2026-05-18): top-of-list "copy everything" button so
              the purchaser can paste one block into a notebook and walk
              the bazaar. Hidden when there's nothing to copy (no rows
              with qty > 0 in any bucket). */}
          {bySupplier.length > 0 ? (
            <div className="mb-2 flex justify-end">
              <Button
                variant="pearl"
                size="sm"
                onClick={() => void shareOrCopyText(buildAllVendorsText())}
              >
                {i18n.t('run.previewShare.sendAll')}
              </Button>
            </div>
          ) : null}
          {bySupplier.map((b) => {
            const supplierKey = b.supplierId ?? '__unassigned__';
            const groupKey = `supplier:${supplierKey}`;
            const collapsed = isCollapsed(groupKey);
            return (
            <section
              key={supplierKey}
              className="border-t border-[var(--c-divider)] py-2 first:border-t-0 first:pt-0 last:pb-0"
            >
              <div
                role="button"
                tabIndex={0}
                aria-expanded={!collapsed}
                onClick={() => toggleGroup(groupKey)}
                onKeyDown={(e) => handleGroupHeaderKeyDown(e, groupKey)}
                className="press mb-1.5 flex cursor-pointer items-start gap-2 rounded-[var(--r-utility)] bg-[var(--c-surface-2)] px-2 py-1.5 outline-none focus-visible:ring-1 focus-visible:ring-[var(--c-ring)]"
              >
                <span className="mt-0.5 shrink-0 font-mono text-label text-[var(--c-fg-muted)]">
                  {collapsed ? '+' : '-'}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-body font-semibold text-[var(--c-fg)]">
                    {b.supplierId ? `🛒 ${b.supplierName}` : `❓ ${b.supplierName}`}
                  </div>
                  {b.contactTg ? (
                    <div className="text-label text-[var(--c-fg-muted)]">@{b.contactTg}</div>
                  ) : b.contactPhone ? (
                    <div className="text-label text-[var(--c-fg-muted)]">{b.contactPhone}</div>
                  ) : null}
                  <div className="mt-0.5 truncate font-mono text-label tabular-nums text-[var(--c-fg-muted)]">
                    {groupMoneyMeta(b.total, b.unknownCount)}
                  </div>
                </div>
                {/* M3.26 (2026-05-18): copy button is now visible for the
                    unassigned bucket too — items to buy individually
                    deserve their own paste — and switched to the same
                    pearl style + "Copy list" label as the by-store
                    view per the user's UX preference. */}
                <Button
                  variant="pearl"
                  size="sm"
                  className="shrink-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    void shareOrCopyText(buildSupplierText(b));
                  }}
                >
                  {i18n.t('run.previewShare.sendList')}
                </Button>
              </div>
              {!collapsed && !b.supplierId ? (
                <p className="mb-1.5 px-2 text-label text-[var(--c-fg-muted)]">
                  {i18n.t('run.previewSupplier.unassignedHint')}
                </p>
              ) : null}
              {/* M1.7-fix2 (2026-05-07): pivot to store-major within
                  each supplier — same data, cleaner layout. The
                  previous SKU-major rendering put the store name
                  under EVERY SKU even when consecutive items went to
                  the same store, doubling vertical space and visually
                  fragmenting what's really one store's pickup list.
                  Now each store is a small section header with its
                  items underneath — matches the copy template format
                  the user asked for in the previous round. */}
              <div className={collapsed ? 'hidden' : 'flex flex-col gap-2'}>
                {b.stores.map((store) => (
                  <div key={store.storeId}>
                    <div className="mb-1 flex items-baseline gap-2 px-2 text-label font-semibold text-[var(--c-fg-muted)]">
                      <span>{store.storeName}</span>
                      <span className="ml-auto font-mono font-normal tabular-nums">
                        {groupMoneyMeta(store.total, store.unknownCount)}
                      </span>
                    </div>
                    <ul className="overflow-hidden rounded-[var(--r-utility)]">
                      {store.items.map((line, idx) =>
                        renderLine(line, idx, { editableSupplier: true }),
                      )}
                    </ul>
                    {store.legacyNote ? (
                      <div className="mt-1.5 rounded-[var(--r-utility)] bg-[var(--c-warn-bg)] px-2 py-1.5">
                        <SectionLabel padded={false}>
                          {i18n.t('order.notes.label')}
                        </SectionLabel>
                        <div className="mt-1 whitespace-pre-wrap text-body-sm leading-snug text-[var(--c-fg-muted)]">
                          {store.legacyNote}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
            );
          })}
        </div>
      ) : null}
      {vendorPickerFor ? (
        <VendorPickerSheet
          skuId={vendorPickerFor}
          skuName={
            skuById.get(vendorPickerFor)
              ? productName(skuById.get(vendorPickerFor)!)
              : vendorPickerFor.slice(0, 8)
          }
          currentSupplierId={preview.supplierBySku[vendorPickerFor]?.id ?? null}
          onClose={() => setVendorPickerFor(null)}
          i18n={i18n}
          toast={toast}
        />
      ) : null}
    </Card>
  );
}

/**
 * VendorPickerSheet (M1.6 #1, 2026-05-06).
 *
 * Reuses the existing supplier list (loaded fresh per open so it
 * reflects new suppliers without restarts). Calls
 * `run.setSkuPreferredSupplier` and invalidates the preview query so
 * the by-supplier view re-aggregates.
 */
function VendorPickerSheet({
  skuId,
  skuName,
  currentSupplierId,
  onClose,
  i18n,
  toast,
}: {
  skuId: string;
  skuName: string;
  currentSupplierId: string | null;
  onClose: () => void;
  i18n: ReturnType<typeof useI18n>;
  toast: ReturnType<typeof useToast>;
}) {
  const utils = trpc.useUtils();
  const suppliersQuery = trpc.admin.supplierList.useQuery();
  // M1.21: route the error toast through the i18n-aware helper. The
  // server returns localized message keys (e.g. `run.errors.xxx`);
  // dumping `err.message` raw shows the key string to non-EN users.
  const errToast = useErrToast();
  const setSupplier = trpc.run.setSkuPreferredSupplier.useMutation({
    onSuccess: (_data, vars) => {
      void utils.run.previewCreatable.invalidate();
      toast.success(
        i18n.t(
          vars.supplierId
            ? 'run.previewSupplier.assigned'
            : 'run.previewSupplier.cleared',
        ),
      );
      onClose();
    },
    onError: errToast('common.error'),
  });

  return (
    <Sheet
      open
      onOpenChange={(o) => !o && !setSupplier.isPending && onClose()}
      title={i18n.t('run.previewSupplier.pickVendorTitle')}
      description={skuName}
    >
      <div className="flex flex-col gap-2 py-3">
        <p className="px-1 text-label text-[var(--c-fg-muted)]">
          {i18n.t('run.previewSupplier.pickVendorHint')}
        </p>
        <button
          type="button"
          onClick={() => setSupplier.mutate({ skuId, supplierId: null })}
          disabled={setSupplier.isPending}
          className={
            'press flex items-center justify-between gap-3 rounded-[var(--r-card)] px-4 py-3 text-left ring-hairline ' +
            (currentSupplierId === null
              ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
              : 'bg-[var(--c-surface-2)]')
          }
        >
          <span className="text-body">
            {i18n.t('run.previewSupplier.clearVendor')}
          </span>
          {currentSupplierId === null ? <span aria-hidden>✓</span> : null}
        </button>
        {(suppliersQuery.data ?? []).map((sup) => {
          const selected = sup.id === currentSupplierId;
          return (
            <button
              key={sup.id}
              type="button"
              onClick={() => setSupplier.mutate({ skuId, supplierId: sup.id })}
              disabled={setSupplier.isPending}
              className={
                'press flex items-center justify-between gap-3 rounded-[var(--r-card)] px-4 py-3 text-left ring-hairline ' +
                (selected
                  ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
                  : 'bg-[var(--c-surface-2)]')
              }
            >
              <div className="min-w-0">
                <div className="text-body font-medium">{sup.name}</div>
                {sup.contactTg ? (
                  <div className="mt-0.5 text-label opacity-80">@{sup.contactTg}</div>
                ) : sup.contactPhone ? (
                  <div className="mt-0.5 text-label opacity-80">{sup.contactPhone}</div>
                ) : null}
              </div>
              {selected ? <span aria-hidden>✓</span> : null}
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}

function RunSessionsCard({
  sessions,
  storeById,
  i18n,
  ejecting,
  onEject,
}: {
  sessions: NonNullable<ActiveRun['sessions']>;
  storeById: Map<string, { id: string; name: string; code: string | null }>;
  i18n: ReturnType<typeof useI18n>;
  ejecting: boolean;
  onEject: (session: NonNullable<ActiveRun['sessions']>[number]) => void;
}) {
  return (
    <Card>
      <SectionLabel meta={i18n.t('run.sessions.meta', { n: sessions.length })}>
        {i18n.t('run.section.sessions')}
      </SectionLabel>
      <ul className="flex flex-col" role="list">
        {sessions.map((sessionRow) => {
          const storeName =
            storeById.get(sessionRow.storeId)?.name ?? sessionRow.storeId.slice(0, 8);
          const submitter =
            sessionRow.submittedByDisplayName ?? i18n.t('run.sessions.unknownSubmitter');
          return (
            <li
              key={sessionRow.id}
              className="flex items-center gap-2 border-b border-[var(--c-divider)] px-3 py-2 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-body font-semibold">{storeName}</span>
                  <span className="shrink-0 text-label text-[var(--c-fg-muted)]">
                    {submitter}
                  </span>
                </div>
                <div className="truncate text-label text-[var(--c-fg-muted)]">
                  {i18n.t(
                    sessionRow.extrasCount > 0
                      ? 'run.sessions.stats'
                      : 'run.sessions.statsNoExtras',
                    {
                      items: sessionRow.itemCount,
                      qty: formatQty(sessionRow.totalQty),
                      extras: sessionRow.extrasCount,
                    },
                  )}
                </div>
              </div>
              <Button
                variant="pearl"
                size="sm"
                disabled={ejecting}
                loading={ejecting}
                onClick={() => onEject(sessionRow)}
              >
                {i18n.t('run.action.ejectSession')}
              </Button>
            </li>
          );
        })}
      </ul>
      <div className="border-t border-[var(--c-divider)] px-3 py-2 text-label text-[var(--c-fg-muted)]">
        {i18n.t('run.sessions.ejectHint')}
      </div>
    </Card>
  );
}

