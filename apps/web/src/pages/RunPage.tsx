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
import {
  Banner,
  Button,
  DataState,
  EmptyState,
  Input,
  Sheet,
  useToast,
} from '@compass/ui';
import { trpc, newIdempotencyKey } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { usePageMainButton, haptic } from '../hooks/useTelegram';
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
// Run money math — extracted to pages/runs/lib (Phase 4 step 1, unit-tested).
import { settleItemLine, settlePerStore } from './runs/lib/settlement';
import { countCarriedOver, STALE_PRICE_DAYS } from './runs/lib/priceState';
import {
  allItemsHandled as allItemsHandledOf,
  allStoresConfirmed as allStoresConfirmedOf,
} from './runs/lib/runProgress';
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
// Mid-level panels — extracted to runs/components (Phase 4 step 5).
import {
  ActiveRunPanel,
  PreviewSummaryCard,
  RunSessionsCard,
} from './runs/components/RunPanels';

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
  | 'refinalize'
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

  // Q7(a): `createOpen` is gone with the create sheet — starting a run
  // is the page-level button, not a modal.
  const [purchaseDraft, setPurchaseDraft] = useState<PurchaseDraft | null>(null);
  const [inlineSavingSkuId, setInlineSavingSkuId] = useState<string | null>(null);
  // Which purchased row is mid-flight on a payment-method correction, so
  // that row's toggle greys out instead of accepting a second tap on a
  // slow link.
  const [paymentBusySkuId, setPaymentBusySkuId] = useState<string | null>(null);
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
      // 2026-07-26: replay with the SAME key the first attempt used —
      // see the mutation's onMutate. Without this a lost response
      // recorded the off-catalog purchase twice.
      await utils.client.run.addPurchaserItem.mutate(
        entry.input as Parameters<typeof utils.client.run.addPurchaserItem.mutate>[0],
        entry.idempotencyKey ? { context: { idempotencyKey: entry.idempotencyKey } } : undefined,
      );
      void utils.run.get.invalidate();
      void utils.run.list.invalidate();
    },
    // M3.44 (2026-05-22): off-catalog expenses. Same retry pattern.
    'run.addExpense': async (entry) => {
      await utils.client.run.addExpense.mutate(
        entry.input as Parameters<typeof utils.client.run.addExpense.mutate>[0],
        entry.idempotencyKey ? { context: { idempotencyKey: entry.idempotencyKey } } : undefined,
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
    onSuccess: (res) => {
      void utils.run.list.invalidate();
      void utils.run.previewCreatable.invalidate();
      haptic('success');
      /**
       * `res.reused` means run.create found a live run and handed it
       * back rather than creating one. Say so — silently landing the
       * user in a trip someone else started, with a "run planned"
       * success toast, would be a lie.
       */
      if (res?.reused) {
        toast.info(i18n.t('run.toast.runAlreadyOpen'));
        return;
      }
      toast.success(i18n.t('run.toast.runPlanned'));
      /**
       * NO inline undo here, deliberately. Starting is now one tap with
       * no confirm in front of it, so an immediate "Undo" on the toast
       * is the right affordance — but the shared Toast primitive renders
       * each toast as a single <button> that dismisses on click, and
       * nesting an action button inside it is the exact invalid markup
       * (and screen-reader trap) that had to be undone in the accordion
       * header earlier today. Doing it properly means restructuring a
       * component every page uses; that is its own change, not a
       * tail-end addition to this one.
       *
       * Recovery today: the gear menu's Cancel — which actually works
       * as of RunCancelInputSchema, having previously returned
       * BAD_REQUEST for every no-reason cancel.
       */
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
  // 2026-07-26: both of these enqueue to the offline outbox on a network
  // error, but neither minted a STABLE idempotency key — so the replay
  // sent a fresh one and the server's 24h dedupe cache never matched.
  // A committed-but-lost response (the iOS "Load failed" case) therefore
  // recorded the off-catalog purchase or the expense TWICE. Same shape as
  // purchaseIdemCtx below; safe to share one ref per mutation because the
  // add-item sheet's submit is gated on isPending (see the MainButton
  // guard), so two concurrent calls of the same mutation can't interleave.
  const addItemIdemCtx = useRef<{ idempotencyKey?: string }>({}).current;
  const addExpenseIdemCtx = useRef<{ idempotencyKey?: string }>({}).current;

  const addPurchaserItem = trpc.run.addPurchaserItem.useMutation({
    trpc: { context: addItemIdemCtx },
    onMutate: () => {
      const idempotencyKey = newIdempotencyKey();
      addItemIdemCtx.idempotencyKey = idempotencyKey;
      return { idempotencyKey };
    },
    onSuccess: () => {
      invalidateRunQuietly(true);
      setAddItemDraft(null);
      haptic('success');
      toast.success(i18n.t('run.toast.itemAdded'));
    },
    onError: (err, vars, ctx) => {
      if (isLikelyNetworkError(err)) {
        const key = (ctx as { idempotencyKey?: string } | undefined)?.idempotencyKey;
        void offline.enqueue('run.addPurchaserItem', vars, key);
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
    trpc: { context: addExpenseIdemCtx },
    onMutate: () => {
      const idempotencyKey = newIdempotencyKey();
      addExpenseIdemCtx.idempotencyKey = idempotencyKey;
      return { idempotencyKey };
    },
    onSuccess: () => {
      invalidateRunQuietly(true);
      setAddItemDraft(null);
      haptic('success');
      toast.success(i18n.t('run.toast.expenseAdded'));
    },
    onError: (err, vars, ctx) => {
      if (isLikelyNetworkError(err)) {
        const key = (ctx as { idempotencyKey?: string } | undefined)?.idempotencyKey;
        void offline.enqueue('run.addExpense', vars, key);
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
  // 2026-07-06: close a super-admin correction — recompute + re-freeze
  // totals and return amending → finished.
  const refinalize = trpc.run.refinalize.useMutation({
    onSuccess: () => {
      void utils.run.list.invalidate();
      invalidateRunQuietly();
      haptic('success');
      toast.success(i18n.t('run.toast.amendSaved'));
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
  // UIUX-B1 (2026-07-06): the C.2/M3.38 exclusive-claim subsystem
  // (claim/release mutations, auto-claim/auto-release effects, the
  // claimed-by-other banner) was deleted — collaborationEnabled has
  // been hardcoded true since M3.53, which made every branch of it
  // unreachable. The server-side claim machinery + worker sweep stay;
  // re-add the FE wiring only if exclusive mode ever returns.

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

  // 2026-07-06: run.amend holders (super-admin) can reopen a finished
  // run to `amending`. Two rules keep that safe on the shared Run tab:
  //  1. An amending run surfaces ONLY for run.amend holders — a normal
  //     purchaser never sees someone's correction session hijack their
  //     tab (they get today's genuinely-active run instead).
  //  2. For an amender we PREFER the amending run so it's always
  //     reachable (and thus refinalizable) even if a newer active run
  //     exists — otherwise a reopened run could get stuck & invisible.
  const canAmend = session?.permissions.includes('run.amend') ?? false;
  const activeRun = useMemo(() => {
    const rows = runsQuery.data ?? [];
    const normal =
      rows.find(
        (r) => r.status === 'planned' || r.status === 'purchasing' || r.status === 'delivering',
      ) ?? null;
    if (canAmend) {
      const amend = rows.find((r) => r.status === 'amending');
      if (amend) return amend;
    }
    return normal;
  }, [runsQuery.data, canAmend]);
  // `amending` reuses the purchasing edit surface, so most render gates
  // treat it like purchasing; `editing` = "records are editable now".
  const amending = activeRun?.status === 'amending';
  const editing = activeRun?.status === 'purchasing' || amending;

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

  // Both predicates live in runs/lib/runProgress.ts with tests — they
  // gate MainButton VISIBILITY, so a wrong answer does not grey a
  // button out, it removes it and strands the run.
  /**
   * Open the full purchase sheet on an already-recorded row.
   *
   * Hoisted out of the JSX because the row's payment-method toggle also
   * needs it as a fallback: a row with per-store payment overrides has
   * no single method to flip, and the sheet is where those fields live.
   */
  const openPurchaseEdit = useCallback(
    (item: {
      skuId: string;
      unitPrice: string | null;
      purchasedQty: string | null;
      supplierId?: string | null;
      receiptPhotoUrl?: string | null;
      paymentMethod?: string | null;
    }) => {
      const splits = new Map<string, string>();
      const splitPrices = new Map<string, string>();
      const splitPaymentMethods = new Map<string, 'cash' | 'transfer'>();
      let perStorePricing = false;
      for (const sp of runDetailQuery.data?.splits ?? []) {
        if (sp.skuId !== item.skuId) continue;
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
      setPurchaseDraft({
        isEdit: true,
        skuId: item.skuId,
        runId: activeRun!.id,
        unitPrice: item.unitPrice ?? '',
        actualQty: item.purchasedQty ?? '',
        supplierId: item.supplierId ?? null,
        splits,
        splitPrices,
        splitPaymentMethods,
        perStorePricing,
        receiptPhotoUrl: item.receiptPhotoUrl ?? null,
        reason: '',
        // M1.14: prefill from the existing record so editing doesn't
        // accidentally flip the method back to cash.
        paymentMethod: (item.paymentMethod as 'cash' | 'transfer') ?? 'cash',
      });
    },
    [runDetailQuery.data, activeRun],
  );

  const allItemsHandled = useMemo(
    () => allItemsHandledOf(runDetailQuery.data?.items ?? []),
    [runDetailQuery.data],
  );

  const allStoresConfirmed = useMemo(() => {
    if (!runDetailQuery.data) return false;
    return allStoresConfirmedOf(runDetailQuery.data.splits);
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
    // 2026-07-26: this loop was duplicated verbatim in RunHistory's
    // detail breakdown. Same money, two copies, no tests — exactly the
    // shape that lets a later edit silently move one number and not the
    // other. It now lives in runs/lib/settlement.ts with tests; the
    // extra fields (skuIds / expense counters) are the history sheet's
    // and are simply unused here.
    const byStoreList = [...settlePerStore(items, splits, expenses).values()].sort(
      (a, b) => b.total - a.total,
    );
    // Q7(b): how many of these prices are simply last trip's price
    // again, and how many of those references were already old. See
    // countCarriedOver — this is what makes hiding the price editor
    // defensible.
    const { carried: carriedOver, stale: carriedOverStale } = countCarriedOver(
      items,
      runDetailQuery.data?.lastPriceBySku ?? {},
      runDetailQuery.data?.lastPriceObservedAtBySku ?? {},
      Date.now(),
    );
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
      carriedOver,
      carriedOverStale,
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
      /**
       * Q7(a) — one tap, no ceremony (2026-07-27).
       *
       * "点击新建采购这个流程真的必要吗，不能在生成采购单这个页面直接开始吗"
       *
       * It was two taps through a modal: "新建采购" opened a sheet that
       * re-listed the items already on screen behind it, and its confirm
       * button then created the run. The sheet's red warning claimed the
       * consequence was that the locked orders "can no longer be edited"
       * — but order/commands.ts already rejects edits the moment a
       * session is approved, so shop staff lost that ability at approval
       * time, not here. The one thing this really does take away is the
       * approver's ability to un-approve, which is reversible via
       * run.ejectSession. That is worth stating, not worth a modal, so
       * it now reads as an inline banner on the card itself.
       *
       * The run is created with startImmediately, so it lands directly
       * in `purchasing` — hence the existing startPurchase label rather
       * than a new one. Creating is undoable: the toast below offers it,
       * and run.cancel actually works now (RunCancelInputSchema).
       *
       * NOT implicit-on-first-item, which was the earlier plan. It would
       * save the same zero taps — you press the item's ✓ either way —
       * while requiring the read-only preview to become a writable
       * ActiveRunPanel, whose delivery / undo / expense callbacks are all
       * meaningless before a run exists.
       */
      const plannable = previewQuery.data?.plannedItems.length ?? 0;
      if (plannable > 0) {
        const sessionIds = previewQuery.data?.sessions.map((s) => s.id) ?? [];
        // Gate on connectivity HERE, at the point of the decision, not
        // at the first save. run.create is not in the offline outbox and
        // the replay classifier discards BAD_REQUEST permanently, so a
        // purchaser who starts offline would walk to a stall, agree a
        // price, type it in and only then discover there is no run to
        // put it in.
        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        return {
          text: offline
            ? i18n.t('run.offline.needNetworkToStart')
            : i18n.t('run.action.startPurchase'),
          onClick: () => {
            if (offline || sessionIds.length === 0 || create.isPending) return;
            create.mutate({ sessionIds, startImmediately: true });
          },
          visible: true,
          active: !offline && sessionIds.length > 0 && !create.isPending,
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
      case 'amending':
        // Super-admin correction session — close it by re-freezing totals.
        return {
          text: i18n.t('run.action.refinalize'),
          onClick: () => setConfirmAction('refinalize'),
          visible: true,
          active: true,
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
    // Q7(a): the create sheet is gone, so it no longer takes over the
    // MainButton. Starting a run is the page-level button itself.
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
           * Q7(b) safety net (2026-07-26).
           *
           * Hiding the price editor is only defensible if closing a run
           * says how much of it was billed at a price nobody re-checked.
           * Otherwise "most prices don't change" quietly becomes "we
           * charged three shops last month's number", and every accepted
           * price also writes a fresh price_history row that becomes the
           * NEXT trip's reference — the error compounds daily.
           *
           * Derived by comparing each saved price to its reference
           * rather than by tracking taps: a tap flag is per-device state
           * a reload loses, and it answers the wrong question. What the
           * manager needs is not "did someone tap" but "which of these
           * numbers is just last week's number again".
           */
          const carriedLine =
            finishSummary.carriedOver > 0
              ? '\n' +
                i18n.t('run.finish.carriedOver', { n: finishSummary.carriedOver }) +
                (finishSummary.carriedOverStale > 0
                  ? ' · ' +
                    i18n.t('run.finish.carriedOverStale', {
                      n: finishSummary.carriedOverStale,
                      days: STALE_PRICE_DAYS,
                    })
                  : '')
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
              carriedLine +
              perStoreLines,
            confirmLabel: i18n.t('run.action.finish'),
            danger: false,
            requireReason: false,
            isPending: finish.isPending,
            run: () => finish.mutate({ runId }, { onSuccess: () => setConfirmAction(null) }),
          };
        }
        case 'refinalize':
          // finishSummary reflects the live (corrected) run.get during
          // amending. Show the SKU-only total (finishSummary.total INCLUDES
          // off-catalog expenses, but RunRefinalized re-freezes items-only
          // actual_total — matching FinishRun + the finance report), so
          // the number shown is exactly what gets frozen.
          return {
            title: i18n.t('run.confirm.refinalize.title'),
            body: i18n.t('run.confirm.refinalize.body', {
              total: formatMoney(finishSummary.total - finishSummary.expensesTotal),
            }),
            confirmLabel: i18n.t('run.action.refinalize'),
            danger: false,
            requireReason: false,
            isPending: refinalize.isPending,
            run: () => refinalize.mutate({ runId }, { onSuccess: () => setConfirmAction(null) }),
          };
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
    refinalize,
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
                : activeRun.status === 'amending'
                  ? i18n.t('run.step.amend')
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
          {activeRun.status === 'planned' || editing ? (
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
          {editing ? (
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

      {/* 2026-07-06: a super-admin is correcting a finished run. Make the
          mode unmistakable — the whole page is now an edit surface and
          the MainButton re-finalizes. */}
      {amending ? (
        <div className="px-4 pt-2">
          <Banner tone="warn" title={i18n.t('run.amend.banner')}>
            {i18n.t('run.amend.bannerHint')}
          </Banner>
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
            // 2026-07-26: was missing, so every row of an EXISTING
            // planned run rendered "待询价" — the preview's price
            // fallback chain is lastPurchasePriceBySku → supplier
            // estimatedUnitPrice → null, and the middle link is dead
            // (sku_supplier_links.default_price / last_seen_price have
            // no writer anywhere in the repo, so estimatedUnitPrice is
            // always null in production). The no-run-yet mount got this
            // straight from run.preview; only this adapter dropped it.
            lastPurchasePriceBySku: runDetailQuery.data.lastPriceBySku ?? {},
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
          onSavePurchaseInline={({
            skuId,
            actualQty,
            unitPrice,
            storeSplits,
            paymentMethod,
            supplierId,
          }) => {
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
              // 2026-07-26: was hard-coded null, so every inline save wrote
              // price_history.supplier_id = NULL (runProjection.ts:678 takes
              // it straight off the event payload). That made "what did I pay
              // for this at THIS stall last time" permanently unanswerable —
              // the only price history we had was per-SKU-global.
              //
              // Only the by-stall view supplies it (see PerVendorView's
              // onSave wrapper). The aggregate / by-store / by-category views
              // have no stall context, and a SKU's *preferred* supplier is a
              // guess about where the purchase happened — recording a guess
              // would poison the very history this is meant to build, so
              // those paths still send null. A gap beats a lie.
              supplierId: supplierId ?? null,
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
          onEditPurchased={openPurchaseEdit}
          paymentBusySkuId={paymentBusySkuId}
          onSetPaymentMethod={(item, next) => {
            // Correcting the method of an ALREADY purchased row goes
            // through revisePurchase, NOT the inline purchase path.
            //
            // purchaseItem reaches PurchaseItem, which has no
            // already-purchased guard and emits a fresh ItemPurchased.
            // The projection then appends an UNDEDUPED price_history row
            // per tap (insertPriceObservations does a bare insert) and
            // upserts run_item_stores_v with
            // `unitPrice: split.unitPrice ?? null`, so a single tap on a
            // row carrying per-store price overrides would erase them.
            // revisePurchase is the command that exists for this; its
            // schema requires a reason, hence the canned localized one.
            const rows = (runDetailQuery.data?.splits ?? []).filter(
              (sp) => sp.skuId === item.skuId,
            );
            // A row with per-store payment overrides has no single
            // method to flip — send it to the sheet, where those fields
            // exist. (The row already renders a static indicator in that
            // case; this is defence in depth.)
            if (
              rows.some((sp) => sp.paymentMethod) ||
              !item.unitPrice ||
              !item.purchasedQty
            ) {
              openPurchaseEdit(item);
              return;
            }
            const storeSplits = rows
              .filter((sp) => Number(sp.qty) > 0)
              // Preserve per-store PRICE overrides; omit paymentMethod
              // so the projection writes null, which is what it already
              // was on every split of this row.
              .map((sp) => ({
                storeId: sp.storeId,
                qty: sp.qty,
                ...(sp.unitPrice ? { unitPrice: sp.unitPrice } : {}),
              }));
            if (storeSplits.length === 0) {
              openPurchaseEdit(item);
              return;
            }
            setPaymentBusySkuId(item.skuId);
            revisePurchase.mutate(
              {
                runId: activeRun.id,
                skuId: item.skuId,
                supplierId: item.supplierId ?? null,
                unitPrice: item.unitPrice,
                actualQty: item.purchasedQty,
                receiptPhotoUrl: item.receiptPhotoUrl ?? null,
                storeSplits,
                paymentMethod: next,
                reason: i18n.t('run.reason.paymentMethodChanged'),
              },
              { onSettled: () => setPaymentBusySkuId(null) },
            );
          }}
          onUnmark={(skuId, skuName) =>
            setConfirmAction({ kind: 'unmarkUnavailable', skuId, skuName })
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

      {/* Q7(a): the "Plan run" sheet is gone. It was a modal whose body
          re-listed the items already visible behind it and whose confirm
          button did what the page-level button now does in one tap. Its
          one piece of real content — that starting the run locks these
          approved orders out of un-approval — moved to an inline banner
          on the preview card. */}

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
        // Undo moved off the purchased row (where it sat one row-pitch
        // from a money-committing ✓) into this sheet. Same ConfirmSheet
        // as before.
        onUndo={
          purchaseDraft?.isEdit
            ? () => {
                const d = purchaseDraft;
                const sku = skuById.get(d.skuId);
                setPurchaseDraft(null);
                setConfirmAction({
                  kind: 'undoPurchase',
                  skuId: d.skuId,
                  skuName: sku ? productName(sku) : d.skuId.slice(0, 8),
                });
              }
            : undefined
        }
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
