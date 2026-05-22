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
  Badge,
  Banner,
  Button,
  Card,
  CardHeader,
  CardMeta,
  CardTitle,
  Chip,
  ChipBar,
  DataState,
  EmptyState,
  Input,
  NumberInput,
  PhotoCapture,
  SectionLabel,
  Sheet,
  useToast,
} from '@compass/ui';
import { trpc } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { usePageMainButton, haptic, getTg } from '../hooks/useTelegram';
import {
  useI18n,
  useProductName,
  useVendorName,
  useVendorUnitLabel,
} from '../hooks/useI18n';
import { usePhotoUploader } from '../hooks/usePhotoUploader';
// M3.5: StoreSwitcher pill removed from page chrome; picker lives in
// SettingsSheet now. RunPage still uses useStoreContext indirectly
// through other paths if needed.
import { usePageMenu } from '../app/PageMenuContext';
import { useOfflineQueue } from '../hooks/useOfflineQueue';
import { isLikelyNetworkError } from '../lib/networkError';
import { useErrToast } from '../lib/errToast';
import { formatQty, formatMoney } from '../lib/format';

/**
 * Convert a raw UZS price string to its thousands-mode display form.
 * "147500" → "147.5" when in thousands mode; pass-through otherwise.
 * Used at every input boundary so the stored / network-sent value
 * stays in raw UZS and only the visible string is divided. Returns
 * the input unchanged on empty / NaN so intermediate typing states
 * ("147.") don't get clobbered.
 *
 * M3.36 (2026-05-19): UZS prices typically run 20–150k; typing the
 * trailing "000" on every row was the operator's #1 friction
 * complaint mid-purchase. The `.toFixed(3)` clamp keeps results
 * within the contract's `^\d+(\.\d{1,3})?$` regex — without it,
 * float drift (e.g. 147.555 × 1000 = 147555.00000000003) would let
 * the server reject otherwise-valid inputs.
 */
function toDisplayPrice(rawStr: string, inThousands: boolean): string {
  if (!inThousands || !rawStr) return rawStr;
  const n = Number(rawStr);
  if (!Number.isFinite(n)) return rawStr;
  return String(Number((n / 1000).toFixed(3)));
}

/** Inverse of toDisplayPrice — used when committing back to the
 *  domain (purchaseItem / revisePurchase always speak raw UZS).
 *  The .toFixed(3) avoids the float-drift "147.555 * 1000 =
 *  147555.00000000003" trap that would fail server validation. */
function fromDisplayPrice(displayStr: string, inThousands: boolean): string {
  if (!inThousands || !displayStr) return displayStr;
  const n = Number(displayStr);
  if (!Number.isFinite(n)) return displayStr;
  return String(Number((n * 1000).toFixed(3)));
}

/**
 * M3.41 + M3.44 (2026-05-21 / 2026-05-22): draft state for the "+ add"
 * sheet. Dual-mode:
 *   - `mode: 'sku'`   → AddPurchaserItem mutation (target an existing
 *     SKU, single-store v1, requires supplierId/skuId).
 *   - `mode: 'expense'` → AddRunExpense mutation (free-text label,
 *     multi-store auto-split, target porter/taxi/off-catalog buys).
 *
 * Both modes share the qty/price/split/payment/reason fields so the
 * sheet can switch modes without losing what the user has typed. The
 * mode-specific fields (skuId/supplierId vs expenseId/label/unitHint)
 * stay populated either way; the renderer + submit handler only
 * reads the ones relevant to the active mode.
 *
 * expenseId is pre-generated when the sheet opens so the FE owns the
 * id from the start — enables an instant local "saved!" indicator
 * without a roundtrip, and the same id replays idempotently if the
 * mutation retries.
 */
interface AddItemDraft {
  mode: 'sku' | 'expense';
  runId: string;
  /** SKU mode — selected SKU id; null until the user picks one. */
  skuId: string | null;
  /** SKU mode — preferred supplier on the SKU (optional override). */
  supplierId: string | null;
  /** Expense mode — pre-generated UUID. */
  expenseId: string;
  /** Expense mode — free-text identity. */
  label: string;
  /** Expense mode — optional unit hint ("trip", "pack", null). */
  unitHint: string;
  // Shared across both modes
  actualQty: string;
  unitPrice: string;
  /** storeId → qty. Only stores in the run's existing scope are valid. */
  splits: Map<string, string>;
  paymentMethod: 'cash' | 'transfer';
  receiptPhotoUrl: string | null;
  reason: string;
}

interface PurchaseDraft {
  /** When set, this is an EDIT of an existing purchase. The submit button
   *  switches to revisePurchase and the reason field becomes required. */
  isEdit: boolean;
  skuId: string;
  runId: string;
  unitPrice: string;
  actualQty: string;
  supplierId: string | null;
  splits: Map<string, string>; // storeId -> qty
  receiptPhotoUrl: string | null;
  reason: string;
  /** M1.14: cash | transfer. Defaults to 'cash' for new purchases (the
   *  common case at the market). Edit pre-fills from the existing item. */
  paymentMethod: 'cash' | 'transfer';
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
  | { kind: 'undoPurchase'; skuId: string; skuName: string };

export function RunPage() {
  const i18n = useI18n();
  const productName = useProductName();
  // M3.45 (2026-05-22): vendor-language variant for per-vendor copy
  // templates. Returns ONLY the secondary locale's name (so the text
  // pasted into the vendor's chat is clean Uzbek, no parenthetical
  // Chinese noise). Falls back to primary locale when no secondary
  // is set.
  const vendorName = useVendorName();
  // M3.48 (2026-05-23): unit-label resolver for the SAME copy templates.
  // Without this, copy emitted raw canonical units ("bunch", "kg") even
  // when the user's primary locale was Chinese — bug the user reported
  // when "把" showed as "bunch" in the pasted text.
  const vendorUnitLabel = useVendorUnitLabel();
  const session = useAuthStore((s) => s.session);
  const toast = useToast();
  const photoUploader = usePhotoUploader('receipt');

  const [createOpen, setCreateOpen] = useState(false);
  const [purchaseDraft, setPurchaseDraft] = useState<PurchaseDraft | null>(null);
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
  const [historyDetailFor, setHistoryDetailFor] = useState<{
    runId: string;
    runIndex: number;
    runDate: string;
    status: string;
  } | null>(null);

  const previewQuery = trpc.run.previewCreatable.useQuery({});
  const runsQuery = trpc.run.list.useQuery();
  const skusQuery = trpc.catalog.skus.useQuery({ includeArchived: false });
  const storesQuery = trpc.catalog.stores.useQuery();
  const suppliersQuery = trpc.catalog.suppliers.useQuery();

  const utils = trpc.useUtils();
  const offline = useOfflineQueue({
    'run.purchaseItem': async (entry) => {
      await utils.client.run.purchaseItem.mutate(
        entry.input as Parameters<typeof utils.client.run.purchaseItem.mutate>[0],
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
  });

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
      void utils.run.get.invalidate();
      void utils.run.list.invalidate();
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
      void utils.run.get.invalidate();
      void utils.run.list.invalidate();
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
      void utils.run.get.invalidate();
      haptic('success');
      toast.info(i18n.t('run.toast.expenseRemoved'));
    },
    onError: errToast('common.error'),
  });
  const purchaseItem = trpc.run.purchaseItem.useMutation({
    onSuccess: () => {
      void utils.run.get.invalidate();
      void utils.run.list.invalidate();
      setPurchaseDraft(null);
      haptic('success');
      toast.success(i18n.t('run.toast.purchaseRecorded'));
    },
    onError: (err, vars) => {
      if (isLikelyNetworkError(err)) {
        void offline.enqueue('run.purchaseItem', vars);
        setPurchaseDraft(null);
        toast.info(i18n.t('run.toast.purchaseSavedOffline'));
      } else {
        errToast('run.toast.couldNotSavePurchase')(err);
      }
    },
  });
  const revisePurchase = trpc.run.revisePurchase.useMutation({
    onSuccess: () => {
      void utils.run.get.invalidate();
      setPurchaseDraft(null);
      haptic('success');
      toast.success(i18n.t('run.toast.purchaseRevised'));
    },
    onError: errToast('run.toast.couldNotSavePurchase'),
  });
  const markUnavailable = trpc.run.markUnavailable.useMutation({
    onSuccess: () => {
      void utils.run.get.invalidate();
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
      void utils.run.get.invalidate();
      haptic('success');
      toast.success(i18n.t('run.toast.unmarkedUnavailable'));
    },
    onError: errToast('common.error'),
  });
  const undoPurchase = trpc.run.undoPurchase.useMutation({
    onSuccess: () => {
      void utils.run.get.invalidate();
      haptic('success');
      toast.success(i18n.t('run.toast.purchaseUndone'));
    },
    onError: errToast('common.error'),
  });
  const startDelivery = trpc.run.startDelivery.useMutation({
    onSuccess: () => {
      void utils.run.list.invalidate();
      void utils.run.get.invalidate();
      haptic('success');
      toast.success(i18n.t('run.toast.deliveryStarted'));
    },
    onError: errToast('common.error'),
  });
  const deliverToStore = trpc.run.deliverToStore.useMutation({
    onSuccess: () => {
      void utils.run.list.invalidate();
      void utils.run.get.invalidate();
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
      void utils.run.get.invalidate();
      void utils.run.list.invalidate();
      haptic('success');
      toast.success(i18n.t('run.toast.deliveryRecalled'));
    },
    onError: errToast('common.error'),
  });
  const undoStartPurchase = trpc.run.undoStartPurchase.useMutation({
    onSuccess: () => {
      void utils.run.get.invalidate();
      void utils.run.list.invalidate();
      haptic('success');
      toast.success(i18n.t('run.toast.startPurchaseUndone'));
    },
    onError: errToast('common.error'),
  });
  const undoStartDelivery = trpc.run.undoStartDelivery.useMutation({
    onSuccess: () => {
      void utils.run.get.invalidate();
      void utils.run.list.invalidate();
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
      void utils.run.get.invalidate();
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
      { id: string; names: Record<string, string>; unit: string; step: string }
    >();
    for (const sku of skusQuery.data ?? []) {
      m.set(sku.id, {
        id: sku.id,
        names: sku.names as Record<string, string>,
        unit: sku.unit,
        step: sku.step,
      });
    }
    return m;
  }, [skusQuery.data]);

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
  ]);
  // Auto-release on page hide. Best-effort fire-and-forget; the
  // worker timeout sweep handles cases where this never fires
  // (force-close, network gone, etc.). Only releases if WE hold the
  // claim — visibility events fire for any user, not just claimers.
  useEffect(() => {
    if (!activeRun || !isClaimedByMe) return;
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
  }, [activeRun?.id, isClaimedByMe]);

  const finishSummary = useMemo(() => {
    const items = runDetailQuery.data?.items ?? [];
    const splits = runDetailQuery.data?.splits ?? [];
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
        const line = Number(it.unitPrice) * Number(it.purchasedQty);
        total += line;
        // M1.14: split by payment method for the in-progress summary so
        // the FinishRun confirm dialog can preview the breakdown that
        // the server-side aggregate is about to compute.
        if (it.paymentMethod === 'transfer') totalTransfer += line;
        else totalCash += line;
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
    for (const ex of runDetailQuery.data?.expenses ?? []) {
      const line = Number(ex.qty) * Number(ex.unitPrice);
      expensesCount += 1;
      expensesTotal += line;
      total += line;
      if (ex.paymentMethod === 'transfer') totalTransfer += line;
      else totalCash += line;
    }
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
          .map(([storeId, qty]) => ({ storeId, qty })),
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
    const canSubmit = !!(
      Number(purchaseDraft.actualQty) > 0 &&
      Number(purchaseDraft.unitPrice) > 0 &&
      splitMatches &&
      reasonOk
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
              expensesLine,
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
      }
    }
    return null;
  }, [
    confirmAction,
    confirmReason,
    finishSummary,
    activeRun,
    i18n,
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
          {activeRun.status === 'purchasing' && isClaimedByMe ? (
            <button
              type="button"
              onClick={() =>
                setAddItemDraft({
                  mode: 'sku',
                  runId: activeRun.id,
                  skuId: null,
                  supplierId: null,
                  // M3.44: pre-generate expense UUID even when opening
                  // in SKU mode so a mid-flow tab switch to expense
                  // mode already has the id ready (idempotency).
                  expenseId:
                    typeof crypto !== 'undefined' && 'randomUUID' in crypto
                      ? crypto.randomUUID()
                      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
                  label: '',
                  unitHint: '',
                  actualQty: '',
                  unitPrice: '',
                  splits: new Map(),
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
      {activeRun && isClaimedByOther ? (
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
                vendorName={vendorName}
                vendorUnitLabel={vendorUnitLabel}
                i18n={i18n}
                toast={toast}
              />
            )
          }
        </DataState>
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
          vendorName={vendorName}
          vendorUnitLabel={vendorUnitLabel}
          i18n={i18n}
          toast={toast}
        />
      ) : null}

      {activeRun && runDetailQuery.data && activeRun.status !== 'planned' ? (
        <ActiveRunPanel
          run={runDetailQuery.data}
          skuById={skuById}
          storeById={storeById}
          productName={productName}
          i18n={i18n}
          priceInThousands={priceInThousands}
          onSavePurchaseInline={({ skuId, actualQty, unitPrice, storeSplits, paymentMethod }) => {
            // Direct in-page save — no sheet involved. Triggered when
            // the user blurs the price input on a row whose qty
            // matches planned. Splits come from per-store demand.
            // M1.14: paymentMethod comes from the in-row toggle
            // (defaults to 'cash'; user can flip to 'transfer' before
            // saving for the relatively rare transfer items).
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
            for (const sp of runDetailQuery.data!.splits) {
              if (sp.skuId === item.skuId) splits.set(sp.storeId, sp.qty);
            }
            setPurchaseDraft({
              isEdit: true,
              skuId: item.skuId,
              runId: activeRun.id,
              unitPrice: item.unitPrice ?? '',
              actualQty: item.purchasedQty ?? '',
              supplierId: item.supplierId ?? null,
              splits,
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
          onRemoveExpense={(expenseId) =>
            removeExpense.mutate({
              runId: activeRun.id,
              expenseId,
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
        i18n={i18n}
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
          !getTg() ? (
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
          ) : null
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
              .map(([storeId, qty]) => ({ storeId, qty })),
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
        runItems={runDetailQuery.data?.items ?? []}
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
        skus={skusQuery.data ?? []}
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
        submitting={addPurchaserItem.isPending || addExpense.isPending}
      />

      {/* Mark-unavailable sheet — primary action handled by MainButton
          inside Telegram. Footer button only outside Telegram. */}
      <Sheet
        open={!!unavailableFor}
        onOpenChange={(open) => !open && setUnavailableFor(null)}
        title={i18n.t('run.action.markUnavailable')}
        description={i18n.t('run.action.markUnavailableDesc')}
        footer={
          !getTg() ? (
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
          ) : null
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

interface ActiveRun {
  id: string;
  status: string;
  items: Array<{
    skuId: string;
    plannedQty: string;
    purchasedQty: string | null;
    status: string;
    unavailableNote: string | null;
    unitPrice: string | null;
    supplierId?: string | null;
    receiptPhotoUrl?: string | null;
    /** M1.14: 'cash' | 'transfer'. Optional because legacy data
     *  pre-migration may be missing the column on rare occasions; the
     *  inline row defaults to 'cash' when undefined. */
    paymentMethod?: string | null;
    /** M3.41 (2026-05-21): true when this row was added mid-run by the
     *  purchaser via AddPurchaserItem. Drives the "+" badge on the row
     *  and the breakdown in finish summary. Default false. */
    addedByPurchaser?: boolean;
  }>;
  splits: Array<{
    runId: string;
    skuId: string;
    storeId: string;
    qty: string;
    deliveredAt: Date | string | null;
    confirmedAt: Date | string | null;
  }>;
  perStoreDemand?: Array<{ storeId: string; skuId: string; qty: string }>;
  lastPriceBySku?: Record<string, string>;
  /** M1.8: per-store concatenated session notes ("其他物品", legacy). */
  sessionNotesByStore?: Record<string, string>;
  /** M3.16-C: per-store structured extras ("其他物品" rows).
   *  M3.37: each row now also carries `sessionId` + `idx` + optional
   *  `status` so the FE can route taps into `order.markExtraStatus`. */
  sessionExtrasByStore?: Record<
    string,
    Array<{
      name: string;
      qty: string;
      unit: string;
      note?: string;
      status?: 'pending' | 'bought' | 'unavailable';
      sessionId?: string;
      idx?: number;
    }>
  >;
  /** M3.44 (2026-05-22): active (non-removed) off-catalog expenses. */
  expenses?: Array<{
    id: string;
    label: string;
    unitHint: string | null;
    qty: string;
    unitPrice: string;
    storeSplits: Array<{ storeId: string; qty: string }>;
    paymentMethod: string;
    receiptPhotoUrl: string | null;
    reason: string;
    addedByMemberId: string;
    addedAt: string;
  }>;
  /** M3.27: preferred-supplier per SKU (mirrors preview.supplierBySku),
   *  powers the active-run "by vendor" view. Null entries = SKUs
   *  with no preferred link — bucketed under "unassigned" in the FE. */
  supplierBySku?: Record<
    string,
    { id: string; name: string; contactPhone: string | null; contactTg: string | null } | null
  >;
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
  storeById,
  productName,
  i18n,
  priceInThousands,
  onSavePurchaseInline,
  onMarkNa,
  onEditPurchased,
  onUnmark,
  onUndoPurchase,
  onOpenAdvancedPurchase,
  onDeliverStore,
  onRecallStore,
  onMarkExtraStatus,
  onRemoveExpense,
}: {
  run: ActiveRun;
  skuById: Map<
    string,
    { id: string; names: Record<string, string>; unit: string; step: string }
  >;
  storeById: Map<string, { id: string; name: string; code: string | null }>;
  productName: (item: { names: Record<string, string> | null | undefined }) => string;
  i18n: ReturnType<typeof useI18n>;
  /** M3.36: when true, inline price input + sheet input display `value/1000`
   *  and parse back to raw UZS on save. Page-level toggle in the
   *  sticky header. */
  priceInThousands: boolean;
  onSavePurchaseInline: (payload: {
    skuId: string;
    actualQty: string;
    unitPrice: string;
    storeSplits: Array<{ storeId: string; qty: string }>;
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
  /** M3.44: remove an off-catalog expense (purchasing phase only). */
  onRemoveExpense: (expenseId: string, label: string) => void;
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
  type ViewMode = 'aggregate' | 'perStore' | 'perVendor';
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const saved = localStorage.getItem('compass.run.viewMode');
      if (saved === 'perStore' || saved === 'perVendor') return saved;
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
  // M3.27 (2026-05-18): showing perStore needs ≥2 stores; showing
  // perVendor needs ≥2 supplier buckets (including unassigned). The
  // toggle itself shows when either condition holds — even if only
  // one of the two extra views would be useful, the user can pick.
  const showPerStore = demandStoreIds.length >= 2;
  const showPerVendor = distinctSupplierCount >= 2;
  const showViewToggle =
    (run.status === 'planned' || run.status === 'purchasing') &&
    (showPerStore || showPerVendor);

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
          demandBySku={demandBySku}
          onSavePurchaseInline={onSavePurchaseInline}
          onMarkNa={onMarkNa}
          onUndoPurchase={onUndoPurchase}
          onOpenAdvancedPurchase={onOpenAdvancedPurchase}
          onEditPurchased={onEditPurchased}
          onUnmark={onUnmark}
          onMarkExtraStatus={onMarkExtraStatus}
        />
      ) : null}
      {(!showViewToggle ||
        viewMode === 'aggregate' ||
        (viewMode === 'perStore' && !showPerStore) ||
        (viewMode === 'perVendor' && !showPerVendor)) &&
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
              return (
                <PurchaseRow
                  key={it.skuId}
                  item={it}
                  skuName={skuName}
                  unit={sku?.unit ?? ''}
                  step={sku?.step ?? '0.1'}
                  demand={demandBySku.get(it.skuId) ?? []}
                  lastPrice={run.lastPriceBySku?.[it.skuId] ?? null}
                  i18n={i18n}
                  priceInThousands={priceInThousands}
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
        (viewMode === 'perVendor' && !showPerVendor)) &&
      (run.status === 'planned' || run.status === 'purchasing') ? (
        <RunExtrasCard
          sessionExtrasByStore={run.sessionExtrasByStore}
          sessionNotesByStore={run.sessionNotesByStore}
          storeById={storeById}
          i18n={i18n}
          editable={run.status === 'purchasing'}
          onMarkExtraStatus={onMarkExtraStatus}
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
        (viewMode === 'perVendor' && !showPerVendor)) &&
      (run.expenses?.length ?? 0) > 0 ? (
        <ExpensesCard
          expenses={run.expenses}
          storeById={storeById}
          i18n={i18n}
          priceInThousands={priceInThousands}
          editable={run.status === 'purchasing'}
          onRemove={onRemoveExpense}
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

/**
 * Pivot a supplier's items from SKU-major (each SKU has a list of
 * stores it goes to) into store-major (each store has the SKUs the
 * supplier delivers there) — used by the by-supplier preview view
 * (M1.7-fix2, 2026-05-07).
 *
 * Stores are sorted alphabetically so the rendered output is stable
 * across re-renders, matching the copy template's order.
 */
function pivotSupplierToStoreMajor(
  items: ReadonlyArray<{
    skuId: string;
    total: string;
    perStore: ReadonlyArray<{ storeId: string; storeName: string; qty: string }>;
  }>,
): Array<{
  storeId: string;
  storeName: string;
  items: Array<{ skuId: string; qty: string }>;
}> {
  const byStore = new Map<
    string,
    {
      storeId: string;
      storeName: string;
      items: Array<{ skuId: string; qty: string }>;
    }
  >();
  for (const it of items) {
    for (const ps of it.perStore) {
      const bucket = byStore.get(ps.storeId) ?? {
        storeId: ps.storeId,
        storeName: ps.storeName,
        items: [],
      };
      bucket.items.push({ skuId: it.skuId, qty: ps.qty });
      byStore.set(ps.storeId, bucket);
    }
  }
  return [...byStore.values()].sort((a, b) =>
    a.storeName.localeCompare(b.storeName),
  );
}

function PreviewSummaryCard({
  preview,
  skuById,
  productName,
  vendorName,
  vendorUnitLabel,
  i18n,
  toast,
}: {
  preview: {
    // M3.24 (2026-05-18): nullable when the caller didn't ask for a
    // specific date — preview then spans every approved-not-in-run
    // session regardless of order_date.
    date: string | null;
    sessions: ReadonlyArray<{ id: string; storeId: string; orderDate?: string }>;
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
    } | null>;
    /** M1.8: per-store concatenated session notes ("其他物品", legacy). */
    sessionNotesByStore?: Record<string, string>;
    /** M3.16-C: per-store structured extras. */
    sessionExtrasByStore?: Record<
      string,
      Array<{ name: string; qty: string; unit: string; note?: string }>
    >;
  };
  skuById: Map<
    string,
    { id: string; names: Record<string, string>; unit: string; step: string }
  >;
  productName: (item: { names: Record<string, string> | null | undefined }) => string;
  /** M3.45 (2026-05-22): used inside the copy templates so the text
   *  sent to vendors is in the secondary locale only (no Chinese
   *  noise when the vendor only reads Uzbek). Falls back to the
   *  primary locale name when the user hasn't opted into bilingual. */
  vendorName: (item: { names: Record<string, string> | null | undefined }) => string;
  /** M3.48 (2026-05-23): unit-label resolver for the copy templates
   *  so "bunch" → "把" / "bog'lam" instead of leaking the canonical
   *  storage value. Mirrors vendorName's locale resolution. */
  vendorUnitLabel: (unit: string | null | undefined) => string;
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
  useEffect(() => {
    if (typeof window !== 'undefined')
      window.localStorage.setItem(PREVIEW_VIEW_STORAGE_KEY, view);
  }, [view]);

  // Group perStoreDemand by storeId for the "by store" view.
  const byStore = useMemo(() => {
    const m = new Map<
      string,
      { storeId: string; storeName: string; items: Array<{ skuId: string; qty: string }> }
    >();
    for (const row of preview.perStoreDemand) {
      const cur = m.get(row.storeId) ?? {
        storeId: row.storeId,
        storeName: row.storeName,
        items: [],
      };
      cur.items.push({ skuId: row.skuId, qty: row.qty });
      m.set(row.storeId, cur);
    }
    return [...m.values()].sort((a, b) => a.storeName.localeCompare(b.storeName));
  }, [preview.perStoreDemand]);

  // Group plannedItems by supplier for the "by supplier" view. Each
  // SKU group holds a per-store breakdown drawn from perStoreDemand.
  const bySupplier = useMemo(() => {
    type SkuPerStore = { storeId: string; storeName: string; qty: string };
    type SkuRow = { skuId: string; total: string; perStore: SkuPerStore[] };
    type Bucket = {
      supplierId: string | null; // null = unassigned
      supplierName: string;
      contactPhone: string | null;
      contactTg: string | null;
      items: SkuRow[];
    };
    // Index per-store breakdown by skuId.
    const psBySku = new Map<string, SkuPerStore[]>();
    for (const row of preview.perStoreDemand) {
      const arr = psBySku.get(row.skuId) ?? [];
      arr.push({ storeId: row.storeId, storeName: row.storeName, qty: row.qty });
      psBySku.set(row.skuId, arr);
    }
    const buckets = new Map<string, Bucket>();
    for (const it of preview.plannedItems) {
      const sup = preview.supplierBySku[it.skuId] ?? null;
      const key = sup?.id ?? '__unassigned__';
      const cur = buckets.get(key) ?? {
        supplierId: sup?.id ?? null,
        supplierName: sup?.name ?? i18n.t('run.previewSupplier.unassigned'),
        contactPhone: sup?.contactPhone ?? null,
        contactTg: sup?.contactTg ?? null,
        items: [] as SkuRow[],
      };
      const perStore = (psBySku.get(it.skuId) ?? []).slice().sort((a, b) =>
        a.storeName.localeCompare(b.storeName),
      );
      cur.items.push({ skuId: it.skuId, total: it.qty, perStore });
      buckets.set(key, cur);
    }
    // Sort: real suppliers (alphabetical) before "unassigned".
    return [...buckets.values()].sort((a, b) => {
      if (a.supplierId === null) return 1;
      if (b.supplierId === null) return -1;
      return a.supplierName.localeCompare(b.supplierName);
    });
  }, [preview.plannedItems, preview.perStoreDemand, preview.supplierBySku, i18n]);

  const copyToClipboard = async (text: string, successKey: 'run.previewStore.copied' | 'run.previewSupplier.copied') => {
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
      toast.success(i18n.t(successKey));
      haptic('success');
    } catch {
      toast.error(i18n.t('common.error'));
    }
  };

  const buildStoreText = (
    storeId: string,
    storeName: string,
    items: ReadonlyArray<{ skuId: string; qty: string }>,
  ): string => {
    const lines = [`🏪 ${storeName}`, ''];
    for (const it of items) {
      const sku = skuById.get(it.skuId);
      // M3.45 (2026-05-22): use vendorName not productName so the
      // pasted text reads cleanly in the vendor's language (no
      // parenthetical primary-locale noise).
      const name = sku ? vendorName(sku) : it.skuId.slice(0, 8);
      // M3.48 (2026-05-23): localized unit — was raw `sku.unit`
      // (canonical "bunch" / "kg" / …) leaking into pasted text.
      lines.push(`• ${name}: ${formatQty(it.qty)} ${vendorUnitLabel(sku?.unit)}`);
    }
    // M1.8 / M3.16-C: append the staff's "其他物品" requests so the
    // purchaser sees them on the same copy-paste they ship to the
    // chat group. Structured extras (M3.16-C+) listed line-by-line;
    // legacy free-text notes (pre-M3.16) appended after.
    const extras = preview.sessionExtrasByStore?.[storeId] ?? [];
    if (extras.length > 0) {
      lines.push('');
      lines.push(`📝 ${i18n.t('order.extras.label')}:`);
      for (const ex of extras) {
        lines.push(`  ${ex.name} ${ex.qty} ${ex.unit}`.trim());
      }
    }
    const note = preview.sessionNotesByStore?.[storeId];
    if (note && note.trim()) {
      if (extras.length === 0) {
        lines.push('');
        lines.push(`📝 ${i18n.t('order.notes.label')}:`);
      }
      lines.push(note.trim());
    }
    return lines.join('\n');
  };

  /**
   * Build the vendor copy-paste text (M1.7-fix, 2026-05-06).
   *
   * Format intentionally minimal — the user pointed out the previous
   * version was over-engineered:
   *
   *   - No greeting "Hi {vendor}" — they're already in the chat with
   *     this vendor; the salutation is noise.
   *   - No date line — implicit from when the message lands.
   *   - No closing "Thanks!" — same reason.
   *   - Group by STORE, not by SKU. The vendor's job is to prepare
   *     N separate piles, one per store. SKU-grouped output makes
   *     them mentally re-pivot the data.
   *
   * Output shape (one block per store, separated by blank line):
   *
   *     红旗店:
   *     牛肉 8kg
   *     番茄 5kg
   *
   *     解放店:
   *     牛肉 7kg
   *     番茄 5kg
   */
  /**
   * Build "all vendors at once" copy-paste text (M3.26, 2026-05-18).
   *
   * User feedback: walking the bazaar with N WeChat chats open is a
   * pain. They wanted a single paste they can drop into a notebook /
   * note app and tick off as they go. Format mirrors per-vendor:
   * vendor header → store-major lines, separated by blank lines.
   * The unassigned bucket gets its own block at the end so items
   * without a fixed stall don't disappear.
   */
  const buildAllVendorsText = (): string => {
    const blocks: string[] = [];
    for (const b of bySupplier) {
      const body = buildVendorText(b);
      if (!body) continue;
      const header = b.supplierId ? `🛒 ${b.supplierName}` : `❓ ${b.supplierName}`;
      blocks.push(`${header}\n${body}`);
    }
    return blocks.join('\n\n');
  };

  const buildVendorText = (b: (typeof bySupplier)[number]): string => {
    // Pivot from SKU-grouped (`b.items[].perStore[]`) to store-grouped.
    type StoreLine = { skuId: string; qty: string };
    const byStoreId = new Map<string, { name: string; lines: StoreLine[] }>();
    for (const it of b.items) {
      for (const ps of it.perStore) {
        const bucket = byStoreId.get(ps.storeId) ?? {
          name: ps.storeName,
          lines: [],
        };
        bucket.lines.push({ skuId: it.skuId, qty: ps.qty });
        byStoreId.set(ps.storeId, bucket);
      }
    }
    const blocks: string[] = [];
    // Stable ordering: store name alphabetical so the message reads
    // the same every time the same vendor copies it twice.
    const ordered = [...byStoreId.values()].sort((a, b2) =>
      a.name.localeCompare(b2.name),
    );
    for (const store of ordered) {
      const lines = [`${store.name}:`];
      for (const line of store.lines) {
        const sku = skuById.get(line.skuId);
        // M3.45: vendor-language copy
        const name = sku ? vendorName(sku) : line.skuId.slice(0, 8);
        // No bullet, no spaces around the unit — the user wants
        // "牛肉 8kg" form, not "• 牛肉 (8 kg)".
        // M3.48 (2026-05-23): localized unit (was raw canonical).
        lines.push(`${name} ${formatQty(line.qty)}${vendorUnitLabel(sku?.unit)}`);
      }
      blocks.push(lines.join('\n'));
    }
    return blocks.join('\n\n');
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{i18n.t('run.section.readyToPlan')}</CardTitle>
        <Badge>{i18n.t('run.label.sessionsCount', { n: preview.sessions.length })}</Badge>
      </CardHeader>
      {/* Segmented control — sticky horizontal pill bar, same visual
          language as ScopeTab in MemberPermissionsSheet. Three taps
          here, all instant (no async work — all data is in `preview`). */}
      <div className="flex gap-1 px-4 pb-2 pt-1">
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

      {view === 'overall' ? (
        /* M1.11: dropped the "+N more" tail row. We still slice to 8
            so the summary card stays bounded, but the teaser line just
            advertised content the user can't expand here — they'll see
            the full list once the run is created. */
        <ul className="flex flex-col gap-1 px-4 py-3">
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
        <div className="flex flex-col gap-3 px-4 py-3">
          {byStore.map((g) => {
            const storeNote = preview.sessionNotesByStore?.[g.storeId]?.trim();
            const storeExtras = preview.sessionExtrasByStore?.[g.storeId] ?? [];
            return (
            <section key={g.storeId} className="rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-3">
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <span className="text-body font-semibold text-[var(--c-fg)]">
                  🏪 {g.storeName}
                </span>
                {/* M2.1: Button component (was raw <button>). */}
                <Button
                  variant="pearl"
                  size="sm"
                  onClick={() =>
                    copyToClipboard(
                      buildStoreText(g.storeId, g.storeName, g.items),
                      'run.previewStore.copied',
                    )
                  }
                >
                  {i18n.t('run.previewStore.copyList')}
                </Button>
              </div>
              <ul className="flex flex-col gap-1">
                {g.items.map((it) => {
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
              {/* M1.8 / M3.16-C: surface the staff's "其他物品" requests
                  inline. M3.16-C structured extras render as one row
                  per item; legacy free-text notes (pre-M3.16) appended
                  underneath in italic. The purchaser scrolls the by-
                  store view at the market and needs requests right
                  next to the SKU list. */}
              {storeExtras.length > 0 || storeNote ? (
                <div className="mt-2 rounded-[var(--r-card)] bg-[var(--c-warn-bg)] px-3 py-2 ring-hairline">
                  <SectionLabel padded={false}>
                    📝 {i18n.t('order.extras.label')}
                  </SectionLabel>
                  {storeExtras.length > 0 ? (
                    <ul className="mt-0.5 flex flex-col gap-0.5">
                      {storeExtras.map((e, idx) => (
                        <li
                          key={`${e.name}-${idx}`}
                          className="flex items-baseline justify-between gap-2 text-body-sm"
                        >
                          <span className="min-w-0 flex-1 truncate text-[var(--c-fg)]">
                            {e.name}
                          </span>
                          <span className="shrink-0 font-mono tabular-nums text-[var(--c-fg-muted)]">
                            {e.qty} {e.unit}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
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
        <div className="flex flex-col gap-3 px-4 py-3">
          {/* M3.26 (2026-05-18): top-of-list "copy everything" button so
              the purchaser can paste one block into a notebook and walk
              the bazaar. Hidden when there's nothing to copy (no rows
              with qty > 0 in any bucket). */}
          {bySupplier.length > 0 ? (
            <div className="flex justify-end">
              <Button
                variant="pearl"
                size="sm"
                onClick={() =>
                  copyToClipboard(buildAllVendorsText(), 'run.previewSupplier.copied')
                }
              >
                {i18n.t('run.previewSupplier.copyAll')}
              </Button>
            </div>
          ) : null}
          {bySupplier.map((b) => (
            <section
              key={b.supplierId ?? '__unassigned__'}
              className="rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-3"
            >
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-body font-semibold text-[var(--c-fg)]">
                    {b.supplierId ? `🛒 ${b.supplierName}` : `❓ ${b.supplierName}`}
                  </div>
                  {b.contactTg ? (
                    <div className="text-label text-[var(--c-fg-muted)]">@{b.contactTg}</div>
                  ) : b.contactPhone ? (
                    <div className="text-label text-[var(--c-fg-muted)]">{b.contactPhone}</div>
                  ) : null}
                </div>
                {/* M3.26 (2026-05-18): copy button is now visible for the
                    unassigned bucket too — items to buy individually
                    deserve their own paste — and switched to the same
                    pearl style + "Copy list" label as the by-store
                    view per the user's UX preference. */}
                <Button
                  variant="pearl"
                  size="sm"
                  onClick={() =>
                    copyToClipboard(buildVendorText(b), 'run.previewSupplier.copied')
                  }
                >
                  {i18n.t('run.previewStore.copyList')}
                </Button>
              </div>
              {!b.supplierId ? (
                <p className="mb-2 text-label text-[var(--c-fg-muted)]">
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
              <div className="flex flex-col gap-3">
                {pivotSupplierToStoreMajor(b.items).map((store) => (
                  <div key={store.storeId}>
                    <div className="mb-1 flex items-baseline gap-2 text-label font-semibold text-[var(--c-fg-muted)]">
                      <span>🏪 {store.storeName}</span>
                    </div>
                    <ul className="flex flex-col gap-0.5">
                      {store.items.map((it) => {
                        const sku = skuById.get(it.skuId);
                        return (
                          <li
                            key={`${store.storeId}-${it.skuId}`}
                            className="flex items-baseline justify-between gap-2 text-body"
                          >
                            <button
                              type="button"
                              onClick={() => setVendorPickerFor(it.skuId)}
                              // M3.15 (2026-05-16): drop the dotted
                              // underline. On dark theme it read as
                              // "broken link" rather than "tap to change
                              // vendor"; the row tap area is the
                              // affordance, and a long-press hint can
                              // be added later if discovery is an issue.
                              className="press min-w-0 flex-1 text-left text-[var(--c-fg)]"
                              title={i18n.t('run.previewSupplier.changeVendor')}
                            >
                              {sku ? productName(sku) : it.skuId.slice(0, 8)}
                            </button>
                            <span className="font-mono tabular-nums text-[var(--c-fg-muted)]">
                              {formatQty(it.qty)} {sku?.unit}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            </section>
          ))}
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
                <div className="text-body font-medium">🛒 {sup.name}</div>
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

function PerStoreView({
  run,
  storeById,
  skuById,
  productName,
  skusByStore,
}: {
  run: ActiveRun;
  storeById: Map<string, { id: string; name: string; code: string | null }>;
  skuById: Map<
    string,
    { id: string; names: Record<string, string>; unit: string; step: string }
  >;
  productName: (item: { names: Record<string, string> | null | undefined }) => string;
  skusByStore: Map<string, Array<{ skuId: string; qty: string }>>;
}) {
  const i18n = useI18n();
  const orderedStores = useMemo(() => {
    const ids = [...skusByStore.keys()];
    ids.sort((a, b) => {
      const an = storeById.get(a)?.name ?? a;
      const bn = storeById.get(b)?.name ?? b;
      return an.localeCompare(bn);
    });
    return ids;
  }, [skusByStore, storeById]);

  return (
    <div className="flex flex-col gap-2">
      {orderedStores.map((storeId) => {
        const store = storeById.get(storeId);
        const rows = skusByStore.get(storeId) ?? [];
        const totalQty = rows.reduce((s, r) => s + Number(r.qty || 0), 0);
        const storeNote = run.sessionNotesByStore?.[storeId]?.trim();
        return (
          <Card key={storeId}>
            <div className="flex items-baseline justify-between gap-2 px-4 py-1.5 text-label text-[var(--c-fg-muted)]">
              <span className="truncate text-body font-semibold text-[var(--c-fg)]">
                {store?.name ?? storeId.slice(0, 8)}
              </span>
              <span className="tabular-nums">
                {i18n.t('run.label.skuCountAndQty', {
                  n: rows.length,
                  qty: formatQty(String(totalQty)),
                })}
              </span>
            </div>
            {/* M3.31 (2026-05-18, A.1): "其他物品" surfaces here in three
                forms — M3.16-C structured extras (one row per item) +
                M1.8 legacy free-text note + the section eyebrow. Until
                this fix, the active-run views only rendered the legacy
                storeNote; the structured extras (the format staff have
                actually been using since M3.16-C) silently disappeared
                between approval and the purchaser's screen. */}
            {(() => {
              const extras = run.sessionExtrasByStore?.[storeId] ?? [];
              if (extras.length === 0 && !storeNote) return null;
              return (
                <div className="mx-4 mb-2 mt-1 rounded-[var(--r-card)] bg-[var(--c-warn-bg)] px-3 py-2 ring-hairline">
                  <SectionLabel padded={false}>
                    📝 {i18n.t('order.extras.label')}
                  </SectionLabel>
                  {extras.length > 0 ? (
                    <ul className="mt-0.5 flex flex-col gap-0.5">
                      {extras.map((e, idx) => (
                        <li
                          key={`${e.name}-${idx}`}
                          className="flex items-baseline justify-between gap-2 text-body-sm"
                        >
                          <span className="min-w-0 flex-1 truncate text-[var(--c-fg)]">
                            {e.name}
                            {e.note ? (
                              <span className="ml-1 text-[var(--c-fg-muted)]">· {e.note}</span>
                            ) : null}
                          </span>
                          <span className="shrink-0 font-mono tabular-nums text-[var(--c-fg-muted)]">
                            {e.qty} {e.unit}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {storeNote ? (
                    <div className="mt-1 whitespace-pre-wrap text-body-sm italic leading-snug text-[var(--c-fg-muted)]">
                      {storeNote}
                    </div>
                  ) : null}
                </div>
              );
            })()}
            <ul className="flex flex-col" role="list">
              {rows
                .map((r) => ({
                  ...r,
                  sku: skuById.get(r.skuId),
                  // Look up the run-level item so we can show the status
                  // (purchased / pending / unavailable) of the rolled-up
                  // SKU. Even read-only the purchaser wants to know
                  // they've already bought half the rows.
                  runItem: run.items.find((it) => it.skuId === r.skuId) ?? null,
                }))
                .sort((a, b) => {
                  const ai = a.sku?.id ? 0 : 1;
                  const bi = b.sku?.id ? 0 : 1;
                  if (ai !== bi) return ai - bi;
                  const an = a.sku ? productName(a.sku) : a.skuId;
                  const bn = b.sku ? productName(b.sku) : b.skuId;
                  return an.localeCompare(bn);
                })
                .map((r) => {
                  const skuName = r.sku ? productName(r.sku) : r.skuId.slice(0, 8);
                  const status = r.runItem?.status ?? 'pending';
                  const tone =
                    status === 'purchased'
                      ? 'text-[var(--c-success)]'
                      : status === 'unavailable'
                        ? 'text-[var(--c-danger)]'
                        : 'text-[var(--c-fg-muted)]';
                  const mark =
                    status === 'purchased' ? '✓' : status === 'unavailable' ? '✗' : '·';
                  return (
                    <li
                      key={r.skuId}
                      className="flex items-center gap-2 border-b border-[var(--c-divider)] px-4 py-2 last:border-b-0"
                    >
                      <span aria-hidden className={`shrink-0 text-body ${tone}`}>
                        {mark}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-body">{skuName}</span>
                      <span className="shrink-0 font-mono text-body tabular-nums text-[var(--c-fg-muted)]">
                        {formatQty(r.qty)} {r.sku?.unit ?? ''}
                      </span>
                    </li>
                  );
                })}
            </ul>
          </Card>
        );
      })}
    </div>
  );
}

/**
 * Per-vendor read-only view for an ACTIVE run (M3.27, 2026-05-18).
 *
 * Mirrors `PerStoreView`'s look-and-feel but groups by the preferred
 * supplier resolved server-side (`run.supplierBySku`). SKUs with no
 * preferred link land in an "Unassigned" bucket so single-buy items
 * stay visible. Rows show the same status mark (·/✓/✗) the per-store
 * view uses, so the purchaser can see at a glance which stalls still
 * have outstanding work.
 *
 * Read-only: actual purchase recording happens in the aggregate view.
 * Switching to per-vendor at the bazaar is for "what do I still need
 * from stall X" planning, not for editing.
 */
function PerVendorView({
  run,
  skuById,
  storeById,
  productName,
  i18n,
  priceInThousands,
  demandBySku,
  onSavePurchaseInline,
  onMarkNa,
  onUndoPurchase,
  onOpenAdvancedPurchase,
  onEditPurchased,
  onUnmark,
  onMarkExtraStatus,
}: {
  run: ActiveRun;
  skuById: Map<
    string,
    { id: string; names: Record<string, string>; unit: string; step: string }
  >;
  storeById: Map<string, { id: string; name: string; code: string | null }>;
  productName: (item: { names: Record<string, string> | null | undefined }) => string;
  i18n: ReturnType<typeof useI18n>;
  /** M3.43 (2026-05-22): per-vendor view now reuses the SAME inline
   *  PurchaseRow component the aggregate view uses, so the purchaser
   *  can type qty + price + ✓ Save directly inside the vendor card —
   *  no more sheet-roundtrip per row. The original M3.36 tap-row →
   *  sheet pattern is preserved as the FALLBACK for rows whose qty
   *  diverges from the planned demand (handled by PurchaseRow
   *  internally via onOpenAdvanced). */
  priceInThousands: boolean;
  demandBySku: Map<string, Array<{ storeId: string; qty: string }>>;
  onSavePurchaseInline: (payload: {
    skuId: string;
    actualQty: string;
    unitPrice: string;
    storeSplits: Array<{ storeId: string; qty: string }>;
    paymentMethod: 'cash' | 'transfer';
  }) => void;
  onMarkNa: (skuId: string) => void;
  onUndoPurchase: (skuId: string, skuName: string) => void;
  onOpenAdvancedPurchase: (item: ActiveRun['items'][number]) => void;
  onEditPurchased: (item: ActiveRun['items'][number]) => void;
  onUnmark: (skuId: string, skuName: string) => void;
  /** M3.37 (Wave2 #5): tap-to-cycle extras status. */
  onMarkExtraStatus: (
    sessionId: string,
    extraIndex: number,
    status: 'pending' | 'bought' | 'unavailable',
  ) => void;
}) {
  // Bucket run.items by their preferred supplier (id) or '__unassigned__'.
  const buckets = useMemo(() => {
    type Bucket = {
      supplierId: string | null;
      supplierName: string;
      items: Array<{ skuId: string; plannedQty: string; status: string }>;
    };
    const m = new Map<string, Bucket>();
    for (const it of run.items) {
      const sup = run.supplierBySku?.[it.skuId] ?? null;
      const key = sup?.id ?? '__unassigned__';
      const bucket = m.get(key) ?? {
        supplierId: sup?.id ?? null,
        supplierName: sup?.name ?? i18n.t('run.previewSupplier.unassigned'),
        items: [],
      };
      bucket.items.push({
        skuId: it.skuId,
        plannedQty: it.plannedQty,
        status: it.status,
      });
      m.set(key, bucket);
    }
    // Real vendors first (alphabetical), unassigned last.
    return [...m.values()].sort((a, b) => {
      if (a.supplierId && !b.supplierId) return -1;
      if (!a.supplierId && b.supplierId) return 1;
      return a.supplierName.localeCompare(b.supplierName);
    });
  }, [run.items, run.supplierBySku, i18n]);

  return (
    <div className="flex flex-col gap-2">
      {buckets.map((b) => {
        const totalQty = b.items.reduce((s, r) => s + Number(r.plannedQty || 0), 0);
        return (
          <Card key={b.supplierId ?? '__unassigned__'}>
            <div className="flex items-baseline justify-between gap-2 px-4 py-1.5 text-label text-[var(--c-fg-muted)]">
              <span className="truncate text-body font-semibold text-[var(--c-fg)]">
                {b.supplierId ? `🛒 ${b.supplierName}` : `❓ ${b.supplierName}`}
              </span>
              <span className="tabular-nums">
                {i18n.t('run.label.skuCountAndQty', {
                  n: b.items.length,
                  qty: formatQty(String(totalQty)),
                })}
              </span>
            </div>
            <ul className="flex flex-col" role="list">
              {b.items
                .map((r) => ({ ...r, sku: skuById.get(r.skuId) }))
                .sort((a, c) => {
                  // M3.43: keep pending rows on top so the purchaser
                  // sees what's left to buy at this stall before the
                  // already-resolved (purchased / N/A) rows below. The
                  // aggregate view sorts by sortIndex; here the stall
                  // grouping makes "still TODO at this stall" the
                  // more useful first-line ordering.
                  const order: Record<string, number> = {
                    pending: 0,
                    purchased: 1,
                    unavailable: 2,
                  };
                  const oa = order[a.status] ?? 3;
                  const ob = order[c.status] ?? 3;
                  if (oa !== ob) return oa - ob;
                  const ai = a.sku ? 0 : 1;
                  const bi = c.sku ? 0 : 1;
                  if (ai !== bi) return ai - bi;
                  const an = a.sku ? productName(a.sku) : a.skuId;
                  const bn = c.sku ? productName(c.sku) : c.skuId;
                  return an.localeCompare(bn);
                })
                .map((r) => {
                  const skuName = r.sku ? productName(r.sku) : r.skuId.slice(0, 8);
                  // M3.43 (2026-05-22): reuse PurchaseRow inline so the
                  // purchaser can record qty+price+✓ at the stall without
                  // a sheet roundtrip. PurchaseRow handles all three row
                  // states (pending input, purchased read-only with edit,
                  // unavailable with unmark) and the auto-split logic
                  // against `demand`. Per-vendor view now lives up to its
                  // original purpose: standing at stall X, see everything
                  // I'm buying here, type prices in one go.
                  const runItem = run.items.find((it) => it.skuId === r.skuId);
                  if (!runItem) {
                    // Defensive — the bucket was derived from run.items;
                    // if lookup fails, render a read-only stub instead
                    // of crashing.
                    return (
                      <li
                        key={r.skuId}
                        className="flex items-center gap-2 border-b border-[var(--c-divider)] px-4 py-2 last:border-b-0"
                      >
                        <span className="min-w-0 flex-1 truncate text-body">{skuName}</span>
                        <span className="shrink-0 font-mono text-body tabular-nums text-[var(--c-fg-muted)]">
                          {formatQty(r.plannedQty)} {r.sku?.unit ?? ''}
                        </span>
                      </li>
                    );
                  }
                  return (
                    <PurchaseRow
                      key={r.skuId}
                      item={runItem}
                      skuName={skuName}
                      unit={r.sku?.unit ?? ''}
                      step={r.sku?.step ?? '0.1'}
                      demand={demandBySku.get(r.skuId) ?? []}
                      lastPrice={run.lastPriceBySku?.[r.skuId] ?? null}
                      i18n={i18n}
                      priceInThousands={priceInThousands}
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
        );
      })}
      {/* M3.31 (2026-05-18, A.1): extras footer. "其他物品" rows don't
          carry a supplier link, so they naturally fall outside the
          per-vendor buckets above. Render them in one card at the
          bottom, grouped by store so the purchaser knows which store
          asked for each one-off pickup. Without this section the
          per-vendor view was structurally hiding all extras even
          though run.get already ships them. */}
      <RunExtrasCard
        sessionExtrasByStore={run.sessionExtrasByStore}
        sessionNotesByStore={run.sessionNotesByStore}
        storeById={storeById}
        i18n={i18n}
        editable={run.status === 'purchasing'}
        onMarkExtraStatus={onMarkExtraStatus}
      />
    </div>
  );
}

/**
 * Shared "其他物品" footer card used by the active-run by-vendor view
 * and (in M3.31) the aggregate edit list. Renders each store's
 * structured extras + legacy free-text note inside a single yellow-
 * tinted block. Returns null when there are no extras and no notes
 * anywhere — keeps the perVendor/aggregate trailing margin clean.
 */
function RunExtrasCard({
  sessionExtrasByStore,
  sessionNotesByStore,
  storeById,
  i18n,
  editable = false,
  onMarkExtraStatus,
}: {
  sessionExtrasByStore?: Record<
    string,
    Array<{
      name: string;
      qty: string;
      unit: string;
      note?: string;
      status?: 'pending' | 'bought' | 'unavailable';
      sessionId?: string;
      idx?: number;
    }>
  >;
  sessionNotesByStore?: Record<string, string>;
  storeById: Map<string, { id: string; name: string; code: string | null }>;
  i18n: ReturnType<typeof useI18n>;
  /** M3.37 (Wave2 #5): when true, tap a row to cycle pending → bought
   *  → unavailable → pending. Only true during run.status='purchasing'. */
  editable?: boolean;
  onMarkExtraStatus?: (
    sessionId: string,
    extraIndex: number,
    status: 'pending' | 'bought' | 'unavailable',
  ) => void;
}) {
  const resolveStoreName = (id: string) => storeById.get(id)?.name ?? id.slice(0, 8);
  const storeIds = [
    ...new Set([
      ...Object.keys(sessionExtrasByStore ?? {}),
      ...Object.keys(sessionNotesByStore ?? {}),
    ]),
  ].filter((id) => {
    const extras = sessionExtrasByStore?.[id] ?? [];
    const note = (sessionNotesByStore?.[id] ?? '').trim();
    return extras.length > 0 || note.length > 0;
  });
  if (storeIds.length === 0) return null;
  // M3.37: small lookup for the visual + accessible label per status.
  const statusVisual = (
    status: 'pending' | 'bought' | 'unavailable',
  ): { mark: string; tone: string; label: string } => {
    switch (status) {
      case 'bought':
        return {
          mark: '✓',
          tone: 'text-[var(--c-success)]',
          label: i18n.t('run.extras.status.bought'),
        };
      case 'unavailable':
        return {
          mark: '✗',
          tone: 'text-[var(--c-danger)]',
          label: i18n.t('run.extras.status.unavailable'),
        };
      default:
        return {
          mark: '·',
          tone: 'text-[var(--c-fg-muted)]',
          label: i18n.t('run.extras.status.pending'),
        };
    }
  };
  const cycle = (
    s: 'pending' | 'bought' | 'unavailable',
  ): 'pending' | 'bought' | 'unavailable' =>
    s === 'pending' ? 'bought' : s === 'bought' ? 'unavailable' : 'pending';

  return (
    <Card>
      <SectionLabel meta="">📝 {i18n.t('order.extras.label')}</SectionLabel>
      <div className="flex flex-col gap-3 px-4 pb-3">
        {storeIds.map((storeId) => {
          const extras = sessionExtrasByStore?.[storeId] ?? [];
          const note = (sessionNotesByStore?.[storeId] ?? '').trim();
          return (
            <div key={storeId}>
              <div className="mb-1 text-label font-semibold text-[var(--c-fg-muted)]">
                🏪 {resolveStoreName(storeId)}
              </div>
              {extras.length > 0 ? (
                <ul className="flex flex-col gap-0.5">
                  {extras.map((e, idx) => {
                    const status = e.status ?? 'pending';
                    const v = statusVisual(status);
                    const hasAddress =
                      typeof e.sessionId === 'string' && typeof e.idx === 'number';
                    const canTap = editable && !!onMarkExtraStatus && hasAddress;
                    const inner = (
                      <>
                        <span aria-hidden className={`shrink-0 text-body ${v.tone}`}>
                          {v.mark}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[var(--c-fg)]">
                          {e.name}
                          {e.note ? (
                            <span className="ml-1 text-[var(--c-fg-muted)]">
                              · {e.note}
                            </span>
                          ) : null}
                        </span>
                        <span className="shrink-0 font-mono tabular-nums text-[var(--c-fg-muted)]">
                          {e.qty} {e.unit}
                        </span>
                      </>
                    );
                    return (
                      <li
                        key={`${e.sessionId ?? storeId}-${e.idx ?? idx}-${e.name}`}
                        className="text-body-sm"
                      >
                        {canTap ? (
                          <button
                            type="button"
                            title={i18n.t('run.extras.status.cycleHint', { current: v.label })}
                            onClick={() =>
                              onMarkExtraStatus!(e.sessionId!, e.idx!, cycle(status))
                            }
                            className="-mx-2 flex w-[calc(100%+1rem)] items-baseline gap-2 rounded-md px-2 py-0.5 text-left active:bg-[var(--c-surface-2)]"
                          >
                            {inner}
                          </button>
                        ) : (
                          <div className="flex items-baseline gap-2 py-0.5">{inner}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {note ? (
                <div className="mt-1 whitespace-pre-wrap text-body-sm italic leading-snug text-[var(--c-fg-muted)]">
                  {note}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/**
 * M3.44 (2026-05-22): off-catalog expenses card. Renders below the SKU
 * items list (in aggregate / perVendor view) so the purchaser sees
 * EVERYTHING they bought / spent against this run in one continuous
 * scroll. Each row carries a delete (✗) affordance so a typo'd
 * expense can be retracted before finish — the server emits a
 * RunExpenseRemoved event and the read-model row is soft-deleted
 * (admin reports can still see the add → remove timeline).
 *
 * Display per row:
 *   {label} · {qty} {unitHint} × {unitPrice} = {total} · 💵/🏦 · [✗ del?]
 *
 * The card's section header summarizes total expense count + sum so
 * the manager glancing at the run page has the off-plan number front
 * and center, no need to hunt through individual rows.
 */
function ExpensesCard({
  expenses,
  storeById,
  i18n,
  priceInThousands,
  editable,
  onRemove,
}: {
  expenses: ActiveRun['expenses'];
  storeById: Map<string, { id: string; name: string; code: string | null }>;
  i18n: ReturnType<typeof useI18n>;
  priceInThousands: boolean;
  /** When true (status='purchasing' + claim is mine), show the ✗ delete
   *  button on each row. Read-only otherwise. */
  editable: boolean;
  onRemove: (expenseId: string, label: string) => void;
}) {
  const currency = useAuthStore((s) => s.session?.member.currency) ?? 'UZS';
  const list = expenses ?? [];
  if (list.length === 0) return null;
  const grandTotal = list.reduce(
    (s, e) => s + Number(e.qty) * Number(e.unitPrice),
    0,
  );
  return (
    <Card>
      <SectionLabel meta={`${list.length} · ${formatMoney(grandTotal)} ${currency}`}>
        🧾 {i18n.t('run.section.expenses')}
      </SectionLabel>
      <ul className="flex flex-col" role="list">
        {list.map((e) => {
          const total = Number(e.qty) * Number(e.unitPrice);
          const isTransfer = e.paymentMethod === 'transfer';
          // Show the store names this expense was allocated to,
          // helpful for the "shared porter" / "split between 3 stores"
          // narrative. Falls back to short id slice if a store row
          // was archived after the expense landed.
          const storeNames = e.storeSplits
            .map((sp) => storeById.get(sp.storeId)?.name ?? sp.storeId.slice(0, 8))
            .join(' · ');
          const unitPriceDisplay = priceInThousands
            ? `${formatMoney(Number(e.unitPrice) / 1000)}K`
            : formatMoney(e.unitPrice);
          return (
            <li
              key={e.id}
              className="border-b border-[var(--c-divider)] px-4 py-2 last:border-b-0"
            >
              <div className="flex items-baseline gap-2">
                <span className="shrink-0 truncate text-body font-semibold">
                  {e.label}
                </span>
                {isTransfer ? (
                  <span
                    aria-label={i18n.t('run.label.paymentTransfer')}
                    title={i18n.t('run.label.paymentTransfer')}
                    className="shrink-0 rounded-[var(--r-pill)] bg-[var(--c-action)]/15 px-1.5 py-0.5 text-label text-[var(--c-action)] ring-1 ring-[var(--c-action)]"
                  >
                    🏦
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 truncate text-label text-[var(--c-fg-muted)]">
                  {storeNames}
                </span>
                {editable ? (
                  <button
                    type="button"
                    onClick={() => onRemove(e.id, e.label)}
                    aria-label={i18n.t('run.action.removeExpense')}
                    className="shrink-0 rounded-[var(--r-pill)] border border-[var(--c-divider)] px-2 py-0.5 text-label text-[var(--c-danger)] active:bg-[var(--c-surface-2)]"
                  >
                    ✗
                  </button>
                ) : null}
              </div>
              <div className="mt-0.5 text-label text-[var(--c-fg-muted)]">
                <span className="font-mono tabular-nums">
                  {formatQty(e.qty)} {e.unitHint ?? ''} × {unitPriceDisplay}
                </span>
                {' = '}
                <span className="font-mono font-semibold tabular-nums text-[var(--c-fg)]">
                  {formatMoney(total)} {currency}
                </span>
                {e.reason ? (
                  <>
                    {' · '}
                    <span className="italic">{e.reason}</span>
                  </>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/**
 * One row of the purchasing list. Holds its OWN qty/price input state
 * (not in the parent) so typing one row doesn't re-render the whole list.
 *
 * Auto-save logic: fires `onSave` when (a) the row is `pending`, (b) qty
 * matches the per-store demand we know about (so we can derive splits
 * automatically), (c) price > 0. If qty differs from planned and the run
 * has multiple stores, we don't try to guess the new split — instead we
 * surface a "more options" link that opens the full PurchaseSheet, where
 * the user manually allocates.
 *
 * Save fires on price-input BLUR (Telegram numeric keyboard's "Done"
 * button blurs the input — natural commit point). We don't save on every
 * keystroke; that would race the network on slow links.
 */
function PurchaseRow({
  item,
  skuName,
  unit,
  step,
  demand,
  lastPrice,
  i18n,
  priceInThousands,
  onSave,
  onMarkNa,
  onEdit,
  onUnmark,
  onUndoPurchase,
  onOpenAdvanced,
}: {
  item: ActiveRun['items'][number];
  skuName: string;
  unit: string;
  step: string;
  demand: Array<{ storeId: string; qty: string }>;
  lastPrice: string | null;
  i18n: ReturnType<typeof useI18n>;
  /** M3.36: when true, the price input shows raw UZS / 1000. Save still
   *  emits raw UZS. */
  priceInThousands: boolean;
  onSave: (payload: {
    skuId: string;
    actualQty: string;
    unitPrice: string;
    storeSplits: Array<{ storeId: string; qty: string }>;
    paymentMethod: 'cash' | 'transfer';
  }) => void;
  onMarkNa: (skuId: string) => void;
  onEdit: (item: ActiveRun['items'][number]) => void;
  onUnmark: (skuId: string, skuName: string) => void;
  onUndoPurchase: (skuId: string, skuName: string) => void;
  onOpenAdvanced: (item: ActiveRun['items'][number]) => void;
}) {
  // Default qty = planned (formatted to 1 decimal). Price defaults to
  // the last observed market price for this SKU — saves typing when
  // prices are unchanged from the previous run, which is the common
  // case for staple goods. User can overwrite.
  const [qty, setQty] = useState<string>(
    formatQty(item.purchasedQty ?? item.plannedQty),
  );
  // M3.36: `price` holds the DISPLAYED value (divided by 1000 when in
  // thousands mode). Stays as the user typed it through intermediate
  // states like "147." — the raw conversion only happens at save.
  const [price, setPrice] = useState<string>(
    toDisplayPrice(item.unitPrice ?? lastPrice ?? '', priceInThousands),
  );
  // M1.14: per-item payment method. Default cash (the common case at
  // the market). User taps the chip to flip cash ↔ transfer before
  // pressing ✓. Edit-existing uses the persisted value.
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'transfer'>(
    (item.paymentMethod as 'cash' | 'transfer') ?? 'cash',
  );
  // M1.21: pull the org-wide currency from session so the inline
  // suffix shows RUB / KZT / USD for non-UZS tenants. Hardcoded "UZS"
  // pre-M1.21; harmless on the UZS launch tenant but blocked multi-
  // tenant rollout.
  const currency = useAuthStore((s) => s.session?.member.currency) ?? 'UZS';
  const savedRef = useRef(false);

  // When server data updates (e.g. ws push, edit landed), reconcile
  // the local input values UNLESS the user is mid-edit (the row is
  // pending and they may have typed something we shouldn't clobber).
  useEffect(() => {
    if (item.status === 'pending') return;
    setQty(formatQty(item.purchasedQty ?? item.plannedQty));
    setPrice(toDisplayPrice(item.unitPrice ?? lastPrice ?? '', priceInThousands));
    savedRef.current = false;
  }, [item.status, item.purchasedQty, item.unitPrice, item.plannedQty, lastPrice, priceInThousands]);

  // M3.36: when the page-level toggle flips while a row is mid-edit
  // (pending), rescale the displayed price so the same underlying
  // UZS value rides through the mode change. Without this, flipping
  // mid-typing would silently mis-scale the next save (e.g. user
  // typed 147500 in raw mode, toggles K mode → handleSave would
  // re-multiply ×1000 → 147,500,000).
  const prevThousandsRef = useRef(priceInThousands);
  useEffect(() => {
    if (prevThousandsRef.current === priceInThousands) return;
    setPrice((p) => {
      if (!p) return p;
      const n = Number(p);
      if (!Number.isFinite(n)) return p;
      return priceInThousands ? String(n / 1000) : String(n * 1000);
    });
    prevThousandsRef.current = priceInThousands;
  }, [priceInThousands]);

  /**
   * Mis-tap protection: previously this fired automatically on input
   * blur, which the user reported as risky in chaotic market
   * conditions. Now it only fires when the explicit ✓ Save button
   * is tapped. After save, the row flips to read-only "purchased"
   * state — no more accidental edits.
   *
   * Returns true on success so the caller can update local "saved"
   * state before the server roundtrip lands.
   */
  /**
   * Inline save with proportional auto-split.
   *
   * Workflow the user described:
   *   "如果同一种物品多店铺都要购买,而出于各种原因购买数量重量与店铺
   *    申请的不一样,这个需要能在写价格的时候就能更改。我们只需要写
   *    单价,根据具体的总价来自动计算"
   *
   * So: user enters whatever actual qty they got, we scale the
   * per-store demand to match. E.g. 3 stores planned 1+1.5+0.5kg
   * (total 3kg), bought only 2kg → splits become 0.67+1.0+0.33kg.
   *
   * Float drift: scaled portions can sum to actualQty ± a tiny
   * rounding error. The domain validates `Math.abs(sum-actual) < 1e-6`.
   * Workaround: assign exact-rounded values to every store except the
   * last, and have the last store absorb whatever's left so the total
   * matches actualQty bit-perfectly.
   */
  const computeProportionalSplits = (
    actualQtyStr: string,
  ): Array<{ storeId: string; qty: string }> | null => {
    if (demand.length === 0) return null;
    const actualQtyNum = Number(actualQtyStr);
    if (!Number.isFinite(actualQtyNum) || actualQtyNum <= 0) return null;
    const plannedTotal = demand.reduce((s, d) => s + Number(d.qty), 0);
    if (plannedTotal <= 0) return null;
    if (demand.length === 1) {
      // Trivial single-store case — no proportional math needed.
      return [{ storeId: demand[0]!.storeId, qty: actualQtyStr }];
    }
    const out: Array<{ storeId: string; qty: string }> = [];
    let allocated = 0;
    for (let i = 0; i < demand.length; i++) {
      const d = demand[i]!;
      let qtyStr: string;
      if (i === demand.length - 1) {
        // Last store absorbs rounding error so the sum is exact.
        qtyStr = (actualQtyNum - allocated).toFixed(3);
      } else {
        const portion = (Number(d.qty) / plannedTotal) * actualQtyNum;
        qtyStr = portion.toFixed(3);
        allocated += Number(qtyStr);
      }
      out.push({ storeId: d.storeId, qty: qtyStr });
    }
    return out;
  };

  const handleSave = () => {
    if (item.status !== 'pending') return;
    if (savedRef.current) return;
    const actualQty = qty.trim();
    const displayPrice = price.trim();
    if (!actualQty || Number(actualQty) <= 0) return;
    if (!displayPrice || Number(displayPrice) <= 0) return;

    const splits = computeProportionalSplits(actualQty);
    if (!splits || splits.length === 0) {
      // No demand info available (legacy run pre-perStoreDemand).
      // Fall back to opening the full sheet.
      onOpenAdvanced(item);
      return;
    }
    savedRef.current = true;
    onSave({
      skuId: item.skuId,
      actualQty,
      // M3.36: convert display → raw UZS at the network boundary.
      unitPrice: fromDisplayPrice(displayPrice, priceInThousands),
      storeSplits: splits,
      paymentMethod,
    });
  };

  // Live "total = qty × price" hint shown below the inputs. Helps the
  // user sanity-check before tapping Save. M3.36: in thousands mode the
  // displayed `price` is divided by 1000, so multiply back so the
  // total reflects the actual UZS the operator will pay.
  const totalHint = useMemo(() => {
    const q = Number(qty);
    const p = Number(price);
    if (!Number.isFinite(q) || !Number.isFinite(p) || q <= 0 || p <= 0) {
      return null;
    }
    const effectiveP = priceInThousands ? p * 1000 : p;
    return Math.round(q * effectiveP);
  }, [qty, price, priceInThousands]);

  const canSave =
    item.status === 'pending' &&
    !savedRef.current &&
    Number(qty) > 0 &&
    Number(price) > 0;

  if (item.status === 'pending') {
    return (
      <li className="border-b border-[var(--c-divider)] px-4 py-2 last:border-b-0">
        {/* Line 1: name + meta (planned · last price) + N/A.
            One row instead of two — meta sits on the same baseline as the
            title in muted 12px so it's scannable but not distracting. */}
        <div className="flex items-baseline gap-2">
          {/* M2.2: pending-row primary unified to text-body
              font-semibold (was text-h3 = 15px, mismatched with the
              same role on Order/Confirm pages). */}
          <span className="shrink-0 truncate text-body font-semibold">{skuName}</span>
          <span className="min-w-0 flex-1 truncate text-label text-[var(--c-fg-muted)]">
            {formatQty(item.plannedQty)} {unit}
            {lastPrice ? (
              <>
                {' · '}
                {/* M3.36: in thousands mode the lastPrice hint is shown
                   as the same scale the user is typing — so a row that
                   says "K·UZS" with input "147.5" lines up with a hint
                   "147.5K" rather than "147,500". Tooltip preserves the
                   raw UZS for a long-press inspection. */}
                <span
                  className="font-mono tabular-nums"
                  title={priceInThousands ? `${formatMoney(lastPrice)} ${currency}` : undefined}
                >
                  {priceInThousands
                    ? `${formatMoney(Number(lastPrice) / 1000)}K`
                    : formatMoney(lastPrice)}
                </span>
              </>
            ) : null}
          </span>
          <button
            type="button"
            onClick={() => onMarkNa(item.skuId)}
            className="shrink-0 rounded-[var(--r-pill)] border border-[var(--c-divider)] px-2 py-0.5 text-label text-[var(--c-fg-muted)] active:bg-[var(--c-surface-2)]"
          >
            {i18n.t('run.action.markNa')}
          </button>
        </div>
        {/* Line 2: qty × price = total ✓ — everything on one line.
            Total hint is inline (right of price, before ✓) so the user
            sees their math without an extra row. */}
        <div className="mt-1.5 grid items-center gap-1.5"
             style={{ gridTemplateColumns: '4.5rem auto minmax(0,1fr) auto minmax(0,auto) auto auto' }}>
          <NumberInput
            step={step}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            aria-label="actual qty"
          />
          <span className="text-body text-[var(--c-fg-muted)]">×</span>
          <NumberInput
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="price"
            aria-label="unit price"
          />
          <span className="text-label text-[var(--c-fg-muted)]">
            {priceInThousands ? `K·${currency}` : currency}
          </span>
          <span className="truncate text-right text-label text-[var(--c-fg-muted)]">
            {totalHint !== null ? (
              <>
                ={' '}
                <span className="font-mono font-semibold tabular-nums text-[var(--c-fg)]">
                  {formatMoney(totalHint)}
                </span>
              </>
            ) : null}
          </span>
          {/* M1.14: payment-method toggle. Default 💵 cash; tap to
              flip to 🏦 transfer. Sits before ✓ save so the muscle
              memory is "set method → confirm". Tooltip on long-press
              spells out the active label for accessibility. */}
          <button
            type="button"
            onClick={() =>
              setPaymentMethod((m) => (m === 'cash' ? 'transfer' : 'cash'))
            }
            aria-label={
              paymentMethod === 'cash'
                ? i18n.t('run.label.paymentCash')
                : i18n.t('run.label.paymentTransfer')
            }
            title={
              paymentMethod === 'cash'
                ? i18n.t('run.label.paymentCash')
                : i18n.t('run.label.paymentTransfer')
            }
            className={
              'flex h-8 min-w-8 items-center justify-center rounded-[var(--r-pill)] px-2 text-body active:opacity-70 ' +
              (paymentMethod === 'transfer'
                ? 'bg-[var(--c-action)]/15 text-[var(--c-action)] ring-1 ring-[var(--c-action)]'
                : 'bg-[var(--c-surface-2)] text-[var(--c-fg-muted)]')
            }
          >
            {paymentMethod === 'cash' ? '💵' : '🏦'}
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            aria-label="save purchase"
            className={
              'flex h-8 min-w-8 items-center justify-center rounded-[var(--r-pill)] px-2.5 text-body font-semibold ' +
              (canSave
                ? 'bg-[var(--c-action)] text-[var(--c-action-fg)] active:opacity-80'
                : 'bg-[var(--c-surface-2)] text-[var(--c-fg-muted)]')
            }
          >
            ✓
          </button>
        </div>
      </li>
    );
  }

  if (item.status === 'purchased') {
    /* Single line: ✓ name · qty unit × price = total   [edit] [undo]
       Was a two-line block; the badge + math is now inline and the
       row actions slim down to icon buttons. */
    const total =
      Number(item.purchasedQty) > 0 && Number(item.unitPrice) > 0
        ? formatMoney(Number(item.purchasedQty) * Number(item.unitPrice))
        : null;
    // M1.14: show 🏦 next to transfer purchases so the purchaser can
    // scan the run at a glance and see which items hit the bank wire.
    // Cash is the implicit default — no icon needed (avoids visual
    // noise on the 90%+ rows that are cash).
    const isTransfer = item.paymentMethod === 'transfer';
    const isAdded = item.addedByPurchaser === true;
    return (
      <li className="flex items-center gap-2 border-b border-[var(--c-divider)] px-4 py-2 last:border-b-0">
        <span aria-hidden className="shrink-0 text-body text-[var(--c-success)]">✓</span>
        <span className="shrink-0 truncate text-body font-semibold">{skuName}</span>
        {isAdded ? (
          // M3.41 (2026-05-21): "+" badge marks rows the purchaser added
          // mid-run. The +ring outline disambiguates from the 🏦 transfer
          // pill (which uses the same action accent). Tooltip carries
          // the localized "added by purchaser" label.
          <span
            aria-label={i18n.t('run.label.addedByPurchaser')}
            title={i18n.t('run.label.addedByPurchaser')}
            className="shrink-0 rounded-[var(--r-pill)] bg-[var(--c-warning)]/15 px-1.5 py-0.5 text-label text-[var(--c-warning)] ring-1 ring-[var(--c-warning)]"
          >
            +
          </span>
        ) : null}
        {isTransfer ? (
          <span
            aria-label={i18n.t('run.label.paymentTransfer')}
            title={i18n.t('run.label.paymentTransfer')}
            className="shrink-0 rounded-[var(--r-pill)] bg-[var(--c-action)]/15 px-1.5 py-0.5 text-label text-[var(--c-action)] ring-1 ring-[var(--c-action)]"
          >
            🏦
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-label text-[var(--c-fg-muted)]">
          {formatQty(item.purchasedQty)} {unit} ×{' '}
          {/* M3.36: render persisted unitPrice in the same scale the
             user is currently working in — keeps the displayed math
             visually consistent with what they typed. */}
          {priceInThousands && item.unitPrice
            ? `${formatMoney(Number(item.unitPrice) / 1000)}K`
            : formatMoney(item.unitPrice)}
          {total ? (
            <>
              {' = '}
              <span className="font-mono font-semibold tabular-nums text-[var(--c-fg)]">{total}</span>
            </>
          ) : null}
        </span>
        <button
          type="button"
          onClick={() => onEdit(item)}
          aria-label={i18n.t('run.action.editPurchase')}
          className="shrink-0 rounded-[var(--r-pill)] border border-[var(--c-divider)] px-2 py-0.5 text-label text-[var(--c-fg-muted)] active:bg-[var(--c-surface-2)]"
        >
          {i18n.t('run.action.editPurchase')}
        </button>
        <button
          type="button"
          onClick={() => onUndoPurchase(item.skuId, skuName)}
          aria-label={i18n.t('run.action.undoPurchase')}
          className="shrink-0 rounded-[var(--r-pill)] border border-[var(--c-divider)] px-2 py-0.5 text-label text-[var(--c-danger)] active:bg-[var(--c-surface-2)]"
        >
          {i18n.t('run.action.undoPurchase')}
        </button>
      </li>
    );
  }

  // unavailable — single line: ✗ name · note   [unmark]
  return (
    <li className="flex items-center gap-2 border-b border-[var(--c-divider)] px-4 py-2 last:border-b-0">
      <span aria-hidden className="shrink-0 text-body text-[var(--c-danger)]">✗</span>
      <span className="shrink-0 truncate text-body font-semibold">{skuName}</span>
      <span className="min-w-0 flex-1 truncate text-label text-[var(--c-fg-muted)]">
        {item.unavailableNote ?? ''}
      </span>
      <button
        type="button"
        onClick={() => onUnmark(item.skuId, skuName)}
        className="shrink-0 rounded-[var(--r-pill)] border border-[var(--c-divider)] px-2 py-0.5 text-label text-[var(--c-fg-muted)] active:bg-[var(--c-surface-2)]"
      >
        {i18n.t('run.action.unmarkUnavailable')}
      </button>
    </li>
  );
}

interface PurchaseSheetProps {
  draft: PurchaseDraft | null;
  skuById: Map<
    string,
    { id: string; names: Record<string, string>; unit: string; step: string }
  >;
  storeById: Map<string, { id: string; name: string; code: string | null }>;
  suppliers: Array<{ id: string; name: string }>;
  productName: (item: { names: Record<string, string> | null | undefined }) => string;
  photoUploader: import('@compass/ui').PhotoUploader | undefined;
  i18n: ReturnType<typeof useI18n>;
  /** M3.36: when true, display + accept price in thousands. Draft
   *  always stores raw UZS — only the visible input value is divided. */
  priceInThousands: boolean;
  onCancel: () => void;
  onChange: (d: PurchaseDraft | null) => void;
  onSubmit: (d: PurchaseDraft) => void;
  submitting: boolean;
}

function PurchaseSheet({
  draft,
  skuById,
  storeById,
  suppliers,
  productName,
  photoUploader,
  i18n,
  priceInThousands,
  onCancel,
  onChange,
  onSubmit,
  submitting,
}: PurchaseSheetProps) {
  const toast = useToast();
  const sku = draft ? skuById.get(draft.skuId) : null;
  const candidateStores = useMemo(() => [...storeById.values()], [storeById]);

  // M3.36: local display state for the price input. Decoupled from
  // draft.unitPrice (which always holds raw UZS) so intermediate
  // typing states like "147." don't get round-tripped through
  // String(Number()) and lose the trailing decimal. Resynced when
  // the sheet opens on a different row or the mode flips.
  const [priceInput, setPriceInput] = useState<string>('');
  useEffect(() => {
    if (!draft) {
      setPriceInput('');
      return;
    }
    setPriceInput(toDisplayPrice(draft.unitPrice, priceInThousands));
    // Intentionally exclude draft.unitPrice — we only want to resync on
    // row open / mode flip, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.skuId, draft?.isEdit, priceInThousands]);

  // If exactly one store has a value, mirror actualQty into it on change.
  useEffect(() => {
    if (!draft) return;
    if (draft.splits.size !== 1) return;
    const entries = [...draft.splits.entries()];
    const [storeId, qty] = entries[0]!;
    if (qty !== draft.actualQty) {
      const next = new Map(draft.splits);
      next.set(storeId, draft.actualQty);
      onChange({ ...draft, splits: next });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.actualQty]);

  const splitTotal = useMemo(() => {
    if (!draft) return 0;
    let s = 0;
    for (const v of draft.splits.values()) s += Number(v) || 0;
    return s;
  }, [draft]);

  const splitMatches = draft && Math.abs(splitTotal - Number(draft.actualQty || 0)) < 0.001;
  const reasonOk = !draft?.isEdit || draft.reason.trim().length > 0;
  const canSubmit = !!(
    draft &&
    Number(draft.actualQty) > 0 &&
    Number(draft.unitPrice) > 0 &&
    splitMatches &&
    reasonOk
  );

  // Inside Telegram, the parent's MainButton drives Save. We hide the
  // sheet's footer button so the user sees only ONE primary action.
  // Outside Telegram (e.g. web preview) we keep it.
  const inTelegram = !!getTg();
  return (
    <Sheet
      open={!!draft}
      onOpenChange={(open) => !open && onCancel()}
      title={
        draft?.isEdit
          ? i18n.t('run.confirm.editPurchase.title')
          : i18n.t('run.action.recordPurchase')
      }
      description={sku ? productName(sku) : ''}
      footer={
        !inTelegram ? (
          <Button
            block
            loading={submitting}
            disabled={!canSubmit}
            onClick={() =>
              draft &&
              (canSubmit
                ? onSubmit(draft)
                : toast.error(i18n.t('run.errors.splitsMustSum')))
            }
          >
            {!splitMatches
              ? i18n.t('run.label.splitsMismatch', {
                  sum: formatQty(splitTotal),
                  target: formatQty(draft?.actualQty || '0'),
                })
              : !reasonOk
                ? i18n.t('run.errors.reviseReasonRequired')
                : draft?.isEdit
                  ? i18n.t('run.action.editPurchase')
                  : i18n.t('run.action.savePurchase')}
          </Button>
        ) : null
      }
    >
      {draft ? (
        <div className="flex flex-col gap-3 py-3">
          {draft.isEdit ? (
            <Banner tone="info" title={i18n.t('run.confirm.editPurchase.body')} />
          ) : null}
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-label font-semibold text-[var(--c-fg-muted)]">
              {i18n.t('run.action.actualQty', { unit: sku?.unit ?? '' })}
              <Input
                className="mt-1"
                type="number"
                inputMode="decimal"
                step={sku?.step ?? '1'}
                value={draft.actualQty}
                onChange={(e) => onChange({ ...draft, actualQty: e.target.value })}
                autoFocus
              />
            </label>
            <label className="block text-label font-semibold text-[var(--c-fg-muted)]">
              {priceInThousands
                ? i18n.t('run.action.unitPriceUzsThousands')
                : i18n.t('run.action.unitPriceUzs')}
              <Input
                className="mt-1"
                type="number"
                inputMode="decimal"
                value={priceInput}
                onChange={(e) => {
                  const v = e.target.value;
                  setPriceInput(v);
                  // M3.36: draft always stores raw UZS — multiply
                  // back when committing. The display state is the
                  // source of truth for what's shown.
                  onChange({
                    ...draft,
                    unitPrice: fromDisplayPrice(v, priceInThousands),
                  });
                }}
              />
            </label>
          </div>
          {/* M1.14: payment method picker. Two-segment chip group so
              both options are always visible — radio behaviour without
              the OS-styled radio buttons. */}
          <div>
            <div className="mb-1 text-label font-semibold text-[var(--c-fg-muted)]">
              {i18n.t('run.label.paymentMethod')}
            </div>
            <div className="flex gap-2">
              {(['cash', 'transfer'] as const).map((m) => {
                const selected = draft.paymentMethod === m;
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => onChange({ ...draft, paymentMethod: m })}
                    className={
                      'press flex-1 rounded-[var(--r-pill)] px-3 py-2 text-label font-medium ring-hairline ' +
                      (selected
                        ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
                        : 'bg-[var(--c-surface-2)] text-[var(--c-fg)]')
                    }
                  >
                    {m === 'cash' ? '💵 ' : '🏦 '}
                    {m === 'cash'
                      ? i18n.t('run.label.paymentCash')
                      : i18n.t('run.label.paymentTransfer')}
                  </button>
                );
              })}
            </div>
          </div>
          {suppliers.length > 0 ? (
            <label className="block text-label font-semibold text-[var(--c-fg-muted)]">
              {i18n.t('run.action.supplier')}
              <select
                className="mt-1 h-11 w-full rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-4 text-h3 ring-hairline"
                value={draft.supplierId ?? ''}
                onChange={(e) => onChange({ ...draft, supplierId: e.target.value || null })}
              >
                <option value="">—</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <PhotoCapture
            label={i18n.t('run.action.receiptPhoto')}
            value={draft.receiptPhotoUrl}
            onCapture={(url) => onChange({ ...draft, receiptPhotoUrl: url })}
            onClear={() => onChange({ ...draft, receiptPhotoUrl: null })}
            uploader={photoUploader}
          />
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-label font-semibold text-[var(--c-fg-muted)]">
                {i18n.t('run.action.allocateAcrossStores')}
              </span>
              <span
                className={`font-mono text-label tabular-nums ${
                  splitMatches ? 'text-[var(--c-success)]' : 'text-[var(--c-warning)]'
                }`}
              >
                {formatQty(splitTotal)} / {formatQty(draft.actualQty || '0')}
              </span>
            </div>
            <ul className="flex flex-col gap-2">
              {candidateStores.map((store) => (
                <li key={store.id} className="flex items-center gap-2">
                  <span className="flex-1 truncate text-body">{store.name}</span>
                  <Input
                    type="number"
                    inputMode="decimal"
                    step={sku?.step ?? '1'}
                    value={draft.splits.get(store.id) ?? ''}
                    onChange={(e) => {
                      const next = new Map(draft.splits);
                      if (e.target.value === '') next.delete(store.id);
                      else next.set(store.id, e.target.value);
                      onChange({ ...draft, splits: next });
                    }}
                    className="w-24 text-right"
                  />
                </li>
              ))}
            </ul>
          </div>
          {draft.isEdit ? (
            <label className="block text-label font-semibold text-[var(--c-fg-muted)]">
              {i18n.t('run.label.reasonForChange')}
              <Input
                className="mt-1"
                value={draft.reason}
                onChange={(e) => onChange({ ...draft, reason: e.target.value })}
                placeholder={i18n.t('run.label.reasonPlaceholder')}
              />
            </label>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}

/**
 * M3.41 (2026-05-21): mid-run "+ add item" sheet. Lets the purchaser
 * record a buy for a SKU that wasn't on the original aggregated order
 * (impromptu bazaar pickup, chef-call-in top-up, vendor freebie, …).
 *
 * Workflow inside the sheet:
 *   1. Search the SKU catalog. Tap a result → that SKU is selected.
 *   2. Pick the destination store (chips of stores already in the
 *      run — server rejects stores not in scope, the chip filter
 *      mirrors that constraint).
 *   3. Enter qty + price (price input respects the K-thousands toggle
 *      from page level). Live total hint below.
 *   4. Type a reason (required — audit log answers "why was this
 *      added beyond the original order?").
 *   5. Save → server emits PurchaserItemAdded → row appears in the
 *      run with the "+" badge.
 *
 * Constraints handled by this UI (server enforces too):
 *   - SKU not already in the run (filtered out of the search list).
 *   - Destination store must already be in the run's scope.
 *   - reason is non-empty before Save is enabled.
 *
 * Multi-store split deferred to v2: v1 is single-store. Most impromptu
 * additions are "give me X for store A specifically" — multi-store
 * adds for the same SKU can be done by re-opening the sheet.
 */
function AddItemSheet({
  draft,
  runItems,
  runStoreIds,
  skus,
  storeById,
  productName,
  photoUploader,
  i18n,
  priceInThousands,
  onCancel,
  onChange,
  onSubmit,
  submitting,
}: {
  draft: AddItemDraft | null;
  /** Already-in-run items (so we can exclude them from the SKU picker). */
  runItems: Array<{ skuId: string }>;
  /** Stores already involved in this run — only these are eligible. */
  runStoreIds: string[];
  skus: Array<{
    id: string;
    names: Record<string, string>;
    unit: string;
    step: string;
    isArchived: boolean;
  }>;
  storeById: Map<string, { id: string; name: string; code: string | null }>;
  productName: (item: { names: Record<string, string> | null | undefined }) => string;
  /** M3.44: PhotoUploader for receipt capture. SKU mode doesn't use it
   *  today; expense mode requires it when total > 200,000 UZS. */
  photoUploader: import('@compass/ui').PhotoUploader | undefined;
  i18n: ReturnType<typeof useI18n>;
  priceInThousands: boolean;
  onCancel: () => void;
  onChange: (d: AddItemDraft | null) => void;
  onSubmit: (d: AddItemDraft) => void;
  submitting: boolean;
}) {
  const currency = useAuthStore((s) => s.session?.member.currency) ?? 'UZS';
  const [search, setSearch] = useState('');
  const [priceInput, setPriceInput] = useState('');

  // Reset local input states when the sheet opens/closes for a new draft.
  useEffect(() => {
    if (!draft) {
      setSearch('');
      setPriceInput('');
      return;
    }
    setPriceInput(toDisplayPrice(draft.unitPrice, priceInThousands));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.runId, draft?.skuId, draft?.mode, priceInThousands]);

  // Filter the SKU list: exclude already-in-run, archived, and (if a
  // search is typed) anything that doesn't substring-match in zh / en /
  // ru / uz. Cap displayed list at 20 to keep the picker scrollable
  // without pagination.
  const inRunSet = useMemo(() => new Set(runItems.map((it) => it.skuId)), [runItems]);
  const filteredSkus = useMemo(() => {
    const q = search.trim().toLowerCase();
    return skus
      .filter((sku) => !sku.isArchived && !inRunSet.has(sku.id))
      .filter((sku) => {
        if (!q) return true;
        const names = sku.names ?? {};
        return Object.values(names).some(
          (v) => typeof v === 'string' && v.toLowerCase().includes(q),
        );
      })
      .slice(0, 20);
  }, [skus, inRunSet, search]);

  const selectedSku = useMemo(
    () => (draft?.skuId ? skus.find((s) => s.id === draft.skuId) : null),
    [draft?.skuId, skus],
  );

  // Single-store v1: dropdown of run-involved stores. v2 can swap in a
  // multi-select chip row that drives `splits` Map directly.
  const storeChoices = useMemo(
    () =>
      runStoreIds
        .map((id) => storeById.get(id))
        .filter((s): s is { id: string; name: string; code: string | null } => !!s),
    [runStoreIds, storeById],
  );
  const selectedStoreId = draft && draft.splits.size === 1 ? [...draft.splits.keys()][0]! : '';

  const totalHint = useMemo(() => {
    if (!draft) return null;
    const q = Number(draft.actualQty);
    const p = Number(priceInput);
    if (!Number.isFinite(q) || !Number.isFinite(p) || q <= 0 || p <= 0) return null;
    const effectiveP = priceInThousands ? p * 1000 : p;
    return Math.round(q * effectiveP);
  }, [draft, priceInput, priceInThousands]);

  // M3.44: receipt threshold for expense mode — server-side enforces
  // the same 200,000 UZS line. The FE pre-validates so Save is
  // disabled rather than letting the user submit and bounce.
  const RECEIPT_THRESHOLD = 200_000;
  const total = useMemo(() => {
    if (!draft) return 0;
    const q = Number(draft.actualQty);
    const p = Number(draft.unitPrice);
    if (!Number.isFinite(q) || !Number.isFinite(p) || q <= 0 || p <= 0) return 0;
    return q * p;
  }, [draft?.actualQty, draft?.unitPrice]);
  const receiptRequired =
    draft?.mode === 'expense' && total > RECEIPT_THRESHOLD;
  const receiptOk = !receiptRequired || !!draft?.receiptPhotoUrl;

  // Mode-aware split-sum check: in expense mode the split is multi-
  // store auto-divided, so the sum may drift by 1 UZS due to integer
  // rounding. Tolerate that small delta; the domain layer uses the
  // same TOLERANCE constant.
  const splitTotal = useMemo(() => {
    if (!draft) return 0;
    let s = 0;
    for (const v of draft.splits.values()) s += Number(v) || 0;
    return s;
  }, [draft]);
  const splitMatches = !!draft && Math.abs(splitTotal - Number(draft.actualQty || 0)) < 0.001;

  const canSubmit = !!(
    draft &&
    (draft.mode === 'sku' ? draft.skuId : draft.label.trim().length > 0) &&
    Number(draft.actualQty) > 0 &&
    Number(draft.unitPrice) > 0 &&
    draft.splits.size > 0 &&
    splitMatches &&
    draft.reason.trim().length > 0 &&
    receiptOk &&
    !submitting
  );

  // M3.44: helper — auto-split actualQty evenly across selected stores,
  // rounded to integers, remainder to the last store. Matches the
  // domain TOLERANCE check. E.g. 70k / 3 = 23k, 23k, 24k.
  const evenSplit = (storeIds: string[], qtyStr: string) => {
    const next = new Map<string, string>();
    const q = Number(qtyStr);
    if (!Number.isFinite(q) || q <= 0 || storeIds.length === 0) return next;
    if (storeIds.length === 1) {
      next.set(storeIds[0]!, qtyStr);
      return next;
    }
    const base = Math.floor(q / storeIds.length);
    let allocated = 0;
    for (let i = 0; i < storeIds.length - 1; i++) {
      next.set(storeIds[i]!, String(base));
      allocated += base;
    }
    // Last store absorbs the remainder so the sum matches actualQty exactly.
    next.set(storeIds[storeIds.length - 1]!, String(q - allocated));
    return next;
  };

  return (
    <Sheet
      open={!!draft}
      onOpenChange={(open) => !open && onCancel()}
      title={
        draft?.mode === 'expense'
          ? i18n.t('run.action.addExpense.title')
          : i18n.t('run.action.addItem.title')
      }
      description={
        draft?.mode === 'sku' && selectedSku
          ? productName(selectedSku)
          : draft?.mode === 'expense'
            ? i18n.t('run.action.addExpense.subtitle')
            : i18n.t('run.action.addItem.subtitle')
      }
      footer={
        <Button
          block
          loading={submitting}
          disabled={!canSubmit}
          onClick={() => draft && canSubmit && onSubmit(draft)}
        >
          {receiptRequired && !draft?.receiptPhotoUrl
            ? i18n.t('run.action.addExpense.needReceipt')
            : draft?.mode === 'expense'
              ? i18n.t('run.action.addExpense.save')
              : i18n.t('run.action.addItem.save')}
        </Button>
      }
    >
      {draft ? (
        <div className="flex flex-col gap-3 py-3">
          {/* M3.44: mode tabs at the top. Tapping switches the form
              shape; the shared fields (qty / price / payment / reason)
              stay populated so a mistaken-mode tap doesn't wipe what
              the user typed. */}
          <div className="flex gap-1 rounded-[var(--r-pill)] bg-[var(--c-surface-2)] p-1">
            {(['sku', 'expense'] as const).map((m) => {
              const selected = draft.mode === m;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    if (draft.mode === m) return;
                    // Mode switch: clear identity-specific fields
                    // (skuId / label) and reset splits because the
                    // store-selection UI is different across modes.
                    onChange({
                      ...draft,
                      mode: m,
                      skuId: m === 'sku' ? null : draft.skuId,
                      label: m === 'expense' ? '' : draft.label,
                      splits: new Map(),
                    });
                  }}
                  className={
                    'flex-1 rounded-[var(--r-pill)] px-3 py-1.5 text-label font-medium ' +
                    (selected
                      ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
                      : 'text-[var(--c-fg-muted)]')
                  }
                >
                  {m === 'sku'
                    ? i18n.t('run.action.addItem.modeSku')
                    : i18n.t('run.action.addItem.modeExpense')}
                </button>
              );
            })}
          </div>

          {/* 1) Identity section — mode-specific. */}
          {draft.mode === 'sku' ? (
            selectedSku ? (
              <div className="flex items-center justify-between rounded-md bg-[var(--c-surface-2)] px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-body font-semibold">
                    {productName(selectedSku)}
                  </div>
                  <div className="text-label text-[var(--c-fg-muted)]">
                    {selectedSku.unit}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onChange({ ...draft, skuId: null })}
                  className="shrink-0 rounded-[var(--r-pill)] border border-[var(--c-divider)] px-2 py-0.5 text-label text-[var(--c-fg-muted)] active:bg-[var(--c-surface-2)]"
                >
                  {i18n.t('run.action.addItem.changeSku')}
                </button>
              </div>
            ) : (
              <>
                <Input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={i18n.t('run.action.addItem.searchPlaceholder')}
                  autoFocus
                />
                <ul className="flex max-h-72 flex-col overflow-y-auto rounded-md border border-[var(--c-divider)]">
                  {filteredSkus.length === 0 ? (
                    <li className="px-3 py-2 text-body-sm text-[var(--c-fg-muted)]">
                      {i18n.t('run.action.addItem.noMatch')}
                    </li>
                  ) : (
                    filteredSkus.map((sku) => (
                      <li
                        key={sku.id}
                        className="border-b border-[var(--c-divider)] last:border-b-0"
                      >
                        <button
                          type="button"
                          onClick={() => onChange({ ...draft, skuId: sku.id })}
                          className="flex w-full items-baseline justify-between gap-2 px-3 py-2 text-left active:bg-[var(--c-surface-2)]"
                        >
                          <span className="min-w-0 truncate text-body">
                            {productName(sku)}
                          </span>
                          <span className="shrink-0 text-label text-[var(--c-fg-muted)]">
                            {sku.unit}
                          </span>
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              </>
            )
          ) : (
            // M3.44: expense mode — free-text label + optional unit hint.
            <>
              <label className="block text-label font-semibold text-[var(--c-fg-muted)]">
                {i18n.t('run.action.addExpense.labelInput')}
                <Input
                  className="mt-1"
                  value={draft.label}
                  onChange={(e) => onChange({ ...draft, label: e.target.value })}
                  placeholder={i18n.t('run.action.addExpense.labelPlaceholder')}
                  autoFocus
                />
              </label>
              <label className="block text-label font-semibold text-[var(--c-fg-muted)]">
                {i18n.t('run.action.addExpense.unitHint')}
                <Input
                  className="mt-1"
                  value={draft.unitHint}
                  onChange={(e) => onChange({ ...draft, unitHint: e.target.value })}
                  placeholder={i18n.t('run.action.addExpense.unitHintPlaceholder')}
                />
              </label>
            </>
          )}

          {/* 2) Store selection — SKU mode is single-store dropdown,
                 expense mode is multi-store chips with auto-even-split. */}
          {draft.mode === 'sku' && selectedSku ? (
            <label className="block text-label font-semibold text-[var(--c-fg-muted)]">
              {i18n.t('run.action.addItem.targetStore')}
              <select
                className="mt-1 h-11 w-full rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-4 text-h3 ring-hairline"
                value={selectedStoreId}
                onChange={(e) => {
                  const next = new Map<string, string>();
                  if (e.target.value && draft.actualQty) {
                    next.set(e.target.value, draft.actualQty);
                  } else if (e.target.value) {
                    next.set(e.target.value, '');
                  }
                  onChange({ ...draft, splits: next });
                }}
              >
                <option value="">{i18n.t('run.action.addItem.pickStore')}</option>
                {storeChoices.map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {draft.mode === 'expense' && draft.label.trim() ? (
            <div>
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="text-label font-semibold text-[var(--c-fg-muted)]">
                  {i18n.t('run.action.addExpense.targetStores')}
                </span>
                <span className="text-label text-[var(--c-fg-muted)]">
                  {i18n.t('run.action.addExpense.splitHint', {
                    n: draft.splits.size,
                  })}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {storeChoices.map((st) => {
                  const selected = draft.splits.has(st.id);
                  return (
                    <button
                      key={st.id}
                      type="button"
                      onClick={() => {
                        const nextIds = selected
                          ? [...draft.splits.keys()].filter((id) => id !== st.id)
                          : [...draft.splits.keys(), st.id];
                        onChange({
                          ...draft,
                          splits: evenSplit(nextIds, draft.actualQty),
                        });
                      }}
                      className={
                        'rounded-[var(--r-pill)] px-3 py-1 text-label font-medium ' +
                        (selected
                          ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
                          : 'bg-[var(--c-surface-2)] text-[var(--c-fg)] ring-hairline')
                      }
                    >
                      {st.name}
                      {selected && draft.splits.size > 1 ? (
                        <span className="ml-1 font-mono tabular-nums opacity-80">
                          {draft.splits.get(st.id) ?? '0'}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
              {draft.splits.size > 1 ? (
                <button
                  type="button"
                  onClick={() =>
                    onChange({
                      ...draft,
                      splits: evenSplit([...draft.splits.keys()], draft.actualQty),
                    })
                  }
                  className="mt-2 text-label text-[var(--c-action)] active:opacity-70"
                >
                  {i18n.t('run.action.addExpense.resplitEvenly')}
                </button>
              ) : null}
            </div>
          ) : null}

          {/* 3) Qty + price + payment + reason + (expense) photo. */}
          {(draft.mode === 'sku' && selectedSku && selectedStoreId) ||
          (draft.mode === 'expense' &&
            draft.label.trim() &&
            draft.splits.size > 0) ? (
            <>
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-label font-semibold text-[var(--c-fg-muted)]">
                  {i18n.t('run.action.actualQty', {
                    unit:
                      draft.mode === 'sku'
                        ? selectedSku?.unit ?? ''
                        : draft.unitHint.trim() || '',
                  })}
                  <Input
                    className="mt-1"
                    type="number"
                    inputMode="decimal"
                    step={draft.mode === 'sku' ? (selectedSku?.step ?? '1') : '1'}
                    value={draft.actualQty}
                    onChange={(e) => {
                      const qty = e.target.value;
                      // M3.44: in expense mode multi-store, re-divide
                      // the new qty across the SAME stores via
                      // evenSplit (integer rounding, last absorbs
                      // remainder). SKU mode is single-store, so the
                      // lone store gets the full qty.
                      const storeIds = [...draft.splits.keys()];
                      const next =
                        draft.mode === 'expense' && storeIds.length > 1
                          ? evenSplit(storeIds, qty)
                          : (() => {
                              const m = new Map(draft.splits);
                              const [sid] = storeIds;
                              if (sid) m.set(sid, qty);
                              return m;
                            })();
                      onChange({ ...draft, actualQty: qty, splits: next });
                    }}
                  />
                </label>
                <label className="block text-label font-semibold text-[var(--c-fg-muted)]">
                  {priceInThousands
                    ? i18n.t('run.action.unitPriceUzsThousands')
                    : i18n.t('run.action.unitPriceUzs')}
                  <Input
                    className="mt-1"
                    type="number"
                    inputMode="decimal"
                    value={priceInput}
                    onChange={(e) => {
                      const v = e.target.value;
                      setPriceInput(v);
                      onChange({
                        ...draft,
                        unitPrice: fromDisplayPrice(v, priceInThousands),
                      });
                    }}
                  />
                </label>
              </div>
              {totalHint !== null ? (
                <div className="text-label text-[var(--c-fg-muted)]">
                  {i18n.t('run.action.addItem.totalHint')}:{' '}
                  <span className="font-mono font-semibold tabular-nums text-[var(--c-fg)]">
                    {formatMoney(totalHint)} {currency}
                  </span>
                </div>
              ) : null}

              {/* Payment method chips — mirror PurchaseSheet's shape. */}
              <div>
                <div className="mb-1 text-label font-semibold text-[var(--c-fg-muted)]">
                  {i18n.t('run.label.paymentMethod')}
                </div>
                <div className="flex gap-2">
                  {(['cash', 'transfer'] as const).map((m) => {
                    const selected = draft.paymentMethod === m;
                    return (
                      <button
                        key={m}
                        type="button"
                        onClick={() => onChange({ ...draft, paymentMethod: m })}
                        className={
                          'press flex-1 rounded-[var(--r-pill)] px-3 py-2 text-label font-medium ring-hairline ' +
                          (selected
                            ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
                            : 'bg-[var(--c-surface-2)] text-[var(--c-fg)]')
                        }
                      >
                        {m === 'cash' ? '💵 ' : '🏦 '}
                        {m === 'cash'
                          ? i18n.t('run.label.paymentCash')
                          : i18n.t('run.label.paymentTransfer')}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Reason (required) — the audit gate. The placeholder
                  cues the operator on what's expected (vendor freebie,
                  chef call-in, market deal). */}
              <label className="block text-label font-semibold text-[var(--c-fg-muted)]">
                {i18n.t('run.action.addItem.reasonLabel')}
                <Input
                  className="mt-1"
                  value={draft.reason}
                  onChange={(e) => onChange({ ...draft, reason: e.target.value })}
                  placeholder={i18n.t('run.action.addItem.reasonPlaceholder')}
                />
              </label>

              {/* M3.44 (2026-05-22): receipt photo. Only shown in
                  expense mode. Mandatory + visually flagged when the
                  total crosses 200,000 UZS — the FE label switches to
                  the "required above threshold" copy so the operator
                  knows BEFORE submitting. */}
              {draft.mode === 'expense' ? (
                <div>
                  <div className="mb-1 text-label font-semibold text-[var(--c-fg-muted)]">
                    {receiptRequired
                      ? i18n.t('run.action.addExpense.receiptRequired', {
                          threshold: formatMoney(RECEIPT_THRESHOLD),
                        })
                      : i18n.t('run.action.addExpense.receiptOptional')}
                  </div>
                  <PhotoCapture
                    label={i18n.t('run.action.receiptPhoto')}
                    value={draft.receiptPhotoUrl}
                    onCapture={(url) =>
                      onChange({ ...draft, receiptPhotoUrl: url })
                    }
                    onClear={() =>
                      onChange({ ...draft, receiptPhotoUrl: null })
                    }
                    uploader={photoUploader}
                  />
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}

/** Generic confirm sheet used by every major transition. Single component
 *  + single render slot keeps the look-and-feel identical across:
 *  Start/Stop purchase, Start/Stop delivery, Deliver to store, Recall
 *  delivery, Cancel run, Unmark unavailable. */
function ConfirmSheet({
  config,
  reason,
  onReasonChange,
  onCancel,
  i18n,
}: {
  config:
    | {
        title: string;
        body: string;
        confirmLabel: string;
        danger: boolean;
        requireReason: boolean;
        /**
         * M1.7-A (2026-05-06): "soft" reason — when true, the reason
         * input is rendered (so the operator CAN add context) but
         * submit is NOT gated on it. Used by the cancel-run flow
         * where requiring a reason produces "asdf" noise but having
         * the option to write one helps the team learn.
         * `requireReason: true` overrides this (hard requirement).
         */
        reasonOptional?: boolean;
        /** Override the default reason placeholder copy. */
        reasonPlaceholder?: string;
        isPending: boolean;
        run: () => void;
      }
    | null;
  reason: string;
  onReasonChange: (s: string) => void;
  onCancel: () => void;
  i18n: ReturnType<typeof useI18n>;
}) {
  const reasonOk = !config?.requireReason || reason.trim().length > 0;
  // M1.13 (2026-05-08): for soft-reason flows (cancel-run is the only
  // current consumer), the input is hidden behind a small "Add note
  // (optional)" toggle. Was: input always visible + autofocused →
  // keyboard popped → user felt obligated to type "asdf" or similar
  // noise. Now: 1-tap confirm by default, expand only if you actually
  // have something to say. Hard `requireReason` flows still render
  // the input unconditionally as before.
  const [reasonExpanded, setReasonExpanded] = useState(false);
  // Reset expanded state every time the sheet opens with a new config
  // so a previously-expanded reason field doesn't leak across confirms.
  useEffect(() => {
    if (!config) setReasonExpanded(false);
  }, [config]);
  const isHardReason = !!config?.requireReason;
  const isSoftReason = !!(config && !isHardReason && config.reasonOptional);
  const showReasonField = isHardReason || (isSoftReason && reasonExpanded);
  const showReasonToggle = isSoftReason && !reasonExpanded;
  // Inside Telegram the MainButton drives the primary action — the sheet
  // doesn't need its own confirm button. The Cancel button was also
  // dropped (2026-05-04, user feedback) because:
  //   - tap-on-backdrop, swipe-down, and Telegram BackButton all close the
  //     sheet — three dismiss paths is plenty for a 1-action confirmation
  //   - on a 640px WebView the trailing "Cancel" was ~52px of muted-pearl
  //     button that visually competed with the body text and made cancel
  //     feel like the default
  // We DO keep the Cancel button when the user has to type a reason —
  // the soft keyboard covers the backdrop, so without an explicit close
  // target they'd have to dismiss the keyboard first to tap outside.
  const inTelegram = !!getTg();
  // Show cancel button whenever a reason input is on screen (keyboard
  // covers the backdrop dismiss target).
  const showCancel = isHardReason || (isSoftReason && reasonExpanded);
  const showPrimary = !inTelegram;
  const hasFooter = showPrimary || showCancel;
  return (
    <Sheet
      open={!!config}
      onOpenChange={(open) => {
        // M3.10: block dismiss while the wrapped mutation is in flight.
        // Without this the operator could swipe-down (or tap-outside)
        // mid-mutation, the local reason text would clear on cancel,
        // and a subsequent failure would arrive as an error toast with
        // no way to retry without re-typing the reason. The sheet
        // naturally closes via the mutation's onSuccess callback.
        if (!open && config?.isPending) return;
        if (!open) onCancel();
      }}
      title={config?.title ?? ''}
      footer={
        hasFooter ? (
          <div className="flex flex-col gap-2">
            {showPrimary ? (
              <Button
                block
                variant={config?.danger ? 'danger' : undefined}
                loading={config?.isPending}
                disabled={!reasonOk}
                onClick={() => config?.run()}
              >
                {config?.confirmLabel ?? ''}
              </Button>
            ) : null}
            {showCancel ? (
              <Button block variant="pearl" onClick={onCancel}>
                {i18n.t('common.cancel')}
              </Button>
            ) : null}
          </div>
        ) : undefined
      }
    >
      {config ? (
        <div className="flex flex-col gap-3 py-3">
          <p className="whitespace-pre-line text-body leading-snug text-[var(--c-fg-muted)]">
            {config.body}
          </p>
          {showReasonField ? (
            <label className="block text-label font-semibold text-[var(--c-fg-muted)]">
              {i18n.t('run.label.reasonForChange')}
              <Input
                className="mt-1"
                value={reason}
                onChange={(e) => onReasonChange(e.target.value)}
                placeholder={
                  config.reasonPlaceholder ?? i18n.t('run.label.reasonPlaceholder')
                }
                autoFocus={isHardReason}
              />
            </label>
          ) : null}
          {showReasonToggle ? (
            <button
              type="button"
              onClick={() => setReasonExpanded(true)}
              className="self-start text-label text-[var(--c-action)] active:opacity-70"
            >
              {i18n.t('run.label.addReasonOptional')}
            </button>
          ) : null}
        </div>
      ) : null}
    </Sheet>
  );
}

// ====================================================================
// HISTORY VIEW
// ====================================================================
// The user explicitly asked: "配送完成、验货完成之后需要入档,需要能看到
// 每天购买的记录,数量价格这些都要能看到历史记录" — after delivery and
// confirmation, sessions should be archived; we need to see daily
// purchase history, quantities, prices.
//
// Implementation: the existing run.list endpoint already returns the
// last 50 runs (any status). We filter for finished+cancelled here and
// render them in a card. Tapping a row opens the detail sheet which
// fetches run.get for the full breakdown (items, prices, store splits).

interface RunListRow {
  id: string;
  runDate: string;
  runIndex: number;
  status: string;
  actualTotal: string | null;
  /** M1.14: cash + transfer breakdown of actualTotal. Both NULL on
   *  legacy finished runs that pre-date the field; FE falls back to
   *  showing only the lump-sum total in that case. */
  actualCashTotal?: string | null;
  actualTransferTotal?: string | null;
  finishedAt: Date | string | null;
}

function RunHistorySection({
  runs,
  i18n,
  onOpen,
}: {
  runs: RunListRow[];
  productName: ReturnType<typeof useProductName>;
  i18n: ReturnType<typeof useI18n>;
  onOpen: (r: RunListRow) => void;
}) {
  // M3.9 (2026-05-16): cancelled runs are hidden from this list
  // entirely. The earlier UX had a 3-tab filter (finished / all /
  // cancelled) but the user's mental model is "history = completed
  // outcomes; a cancelled run didn't happen — please erase it."
  // Cancellations stay in the event log + read model so admins can
  // dig them up via Operations → Submission history if forensics
  // are ever needed; here they just vanish. No localStorage state,
  // no filter chip toolbar, no count badges.
  const allHistorical = useMemo(
    () => runs.filter((r) => r.status === 'finished'),
    [runs],
  );
  // M1.13 (2026-05-08): cap the inline list at 12 rows. Anything older
  // is reachable via the "View all" link → Operations → Submission
  // history (which already has full pagination, search, filters).
  // Keeps RunPage's bottom from becoming an infinite scroll dump.
  const HISTORY_INLINE_CAP = 12;

  // Group by yyyy-mm so the section reads as a calendar
  // ("May 2026 · 8 runs · ₸4,250,000 / April 2026 · 12 runs · ...").
  const groups = useMemo(() => {
    const capped = allHistorical.slice(0, HISTORY_INLINE_CAP);
    const byMonth = new Map<string, RunListRow[]>();
    for (const r of capped) {
      // runDate is stored as "YYYY-MM-DD" — slice the year+month prefix.
      const key = r.runDate.slice(0, 7);
      const arr = byMonth.get(key) ?? [];
      arr.push(r);
      byMonth.set(key, arr);
    }
    return [...byMonth.entries()].map(([month, rows]) => {
      const total = rows.reduce(
        (sum, r) =>
          sum + (r.actualTotal ? Number(r.actualTotal) : 0),
        0,
      );
      return { month, rows, total };
    });
  }, [allHistorical]);

  const totalShown = groups.reduce((s, g) => s + g.rows.length, 0);
  const hasMore = allHistorical.length > totalShown;

  if (allHistorical.length === 0) return null;

  // Format yyyy-mm into the user's locale month-year ("May 2026" / "2026年5月").
  const formatMonth = (key: string): string => {
    const [y, m] = key.split('-');
    const d = new Date(Number(y), Number(m) - 1, 1);
    return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{i18n.t('run.history.title')}</CardTitle>
        <CardMeta>{i18n.t('run.history.subtitle')}</CardMeta>
      </CardHeader>
      {/* M3.9: filter chip toolbar removed — cancelled runs no
         longer surface here, so there's nothing to toggle. */}
      {groups.map((g) => (
        <section key={g.month} className="border-t border-[var(--c-divider)] first:border-t-0">
          {/* Month group header — sub-section label + per-month total
              spend for finished runs. Helps the operator see "we spent
              X this month" without leaving the page. */}
          {/* M2.1: SectionLabel (month group header). */}
          <SectionLabel
            meta={g.total > 0 ? formatMoney(String(g.total)) : undefined}
            className="pt-3 pb-1"
          >
            {formatMonth(g.month)}
          </SectionLabel>
          <ul className="flex flex-col" role="list">
            {/* M3.9: cancelled-row branches dropped — `allHistorical`
               above filters to status==='finished' only, so the dead
               code that used to render the ❌ badge + cancelled-reason
               line is gone. If forensics ever needs to surface
               cancelled runs back here, both the FE filter and the
               row branches need restoring together. */}
            {g.rows.map((r) => (
              <li
                key={r.id}
                className="border-b border-[var(--c-divider)] last:border-b-0"
              >
                <button
                  type="button"
                  onClick={() => onOpen(r)}
                  className="flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left active:bg-[var(--c-surface-2)]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-body font-semibold tabular-nums">
                        {r.runDate}
                      </span>
                      {r.runIndex > 0 ? (
                        <span className="text-label text-[var(--c-fg-muted)]">
                          #{r.runIndex + 1}
                        </span>
                      ) : null}
                    </div>
                    {r.actualTotal ? (
                      <div className="text-label text-[var(--c-fg-muted)]">
                        {i18n.t('run.history.totalLine', {
                          total: formatMoney(r.actualTotal),
                        })}
                        {/* M1.14: when this run mixed both methods,
                            surface a tiny "💵 X · 🏦 Y" breakdown so
                            the operator can see split at a glance.
                            Hidden when one bucket is zero (single-
                            method run) or both columns are NULL
                            (legacy run pre-M1.14). */}
                        {r.actualCashTotal != null &&
                        r.actualTransferTotal != null &&
                        Number(r.actualCashTotal) > 0 &&
                        Number(r.actualTransferTotal) > 0 ? (
                          <span className="ml-1 text-label">
                            {' · '}💵 {formatMoney(r.actualCashTotal)}
                            {' · '}🏦 {formatMoney(r.actualTransferTotal)}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  <Badge tone="success">{r.status}</Badge>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {/* "View all" tail — only when truncated. Routes the user to
          Operations → Submission history (the proper paginated view)
          rather than dumping infinite scroll into RunPage. */}
      {hasMore ? (
        <div className="border-t border-[var(--c-divider)] px-4 py-2 text-center text-label text-[var(--c-fg-muted)]">
          {i18n.t('run.history.viewAllHint')}
        </div>
      ) : null}
    </Card>
  );
}

/**
 * Drill-down sheet for one historical run.
 *
 * Fetches `run.get` lazily when opened. Shows:
 *   - Status + total + finished-at timestamp at the top
 *   - Per-item rows: name, qty bought, unit price, line total, supplier
 *   - Per-store breakdown: items received, store-level subtotal
 *
 * Receipt photos are shown inline (clickable to expand to full size — TODO
 * once we have a lightbox component).
 */
function RunHistoryDetailSheet({
  target,
  skuById,
  storeById,
  productName,
  i18n,
  onClose,
}: {
  target: { runId: string; runIndex: number; runDate: string; status: string } | null;
  skuById: Map<
    string,
    { id: string; names: Record<string, string>; unit: string; step: string }
  >;
  storeById: Map<string, { id: string; name: string; code: string | null }>;
  productName: ReturnType<typeof useProductName>;
  i18n: ReturnType<typeof useI18n>;
  onClose: () => void;
}) {
  // M1.21: org-wide currency for the headline label.
  const currency = useAuthStore((s) => s.session?.member.currency) ?? 'UZS';
  const detail = trpc.run.get.useQuery(
    target ? { runId: target.runId } : { runId: '' },
    { enabled: !!target },
  );

  const breakdown = useMemo(() => {
    if (!detail.data) return null;
    const items = detail.data.items;
    const splits = detail.data.splits;
    let total = 0;
    let totalCash = 0;
    let totalTransfer = 0;
    const purchasedCount = items.filter((i) => i.status === 'purchased').length;
    const unavailableCount = items.filter((i) => i.status === 'unavailable').length;
    for (const it of items) {
      if (it.status === 'purchased' && it.unitPrice && it.purchasedQty) {
        const line = Number(it.unitPrice) * Number(it.purchasedQty);
        total += line;
        // M1.14: payment-method breakdown of historical run totals.
        if (it.paymentMethod === 'transfer') totalTransfer += line;
        else totalCash += line;
      }
    }
    // Per-store totals — sums each store's share at each purchase price.
    const perStore = new Map<string, { storeId: string; total: number; itemCount: number }>();
    for (const sp of splits) {
      const item = items.find((i) => i.skuId === sp.skuId);
      if (!item || item.status !== 'purchased' || !item.unitPrice) continue;
      const subtotal = Number(item.unitPrice) * Number(sp.qty);
      const cur = perStore.get(sp.storeId) ?? {
        storeId: sp.storeId,
        total: 0,
        itemCount: 0,
      };
      cur.total += subtotal;
      cur.itemCount += 1;
      perStore.set(sp.storeId, cur);
    }
    return {
      items,
      splits,
      total,
      totalCash,
      totalTransfer,
      purchasedCount,
      unavailableCount,
      perStore,
    };
  }, [detail.data]);

  return (
    <Sheet
      open={!!target}
      onOpenChange={(open) => !open && onClose()}
      title={
        target
          ? `${target.runDate}${target.runIndex > 0 ? ` #${target.runIndex + 1}` : ''}`
          : ''
      }
      description={target?.status ?? undefined}
    >
      {!target ? null : detail.isLoading ? (
        <div className="py-8 text-center text-body text-[var(--c-fg-muted)]">
          {i18n.t('common.loading')}
        </div>
      ) : !breakdown ? (
        <div className="py-8 text-center text-body text-[var(--c-fg-muted)]">
          {i18n.t('common.noData')}
        </div>
      ) : (
        <div className="flex flex-col gap-4 py-3">
          {/* Top summary */}
          <div className="flex flex-col gap-2 rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <div>
                <SectionLabel padded={false}>
                  {i18n.t('run.history.totalLabel')}
                </SectionLabel>
                {/* M2.2: headline money unified to text-h2 (17 px)
                    across pages. Was text-h1 (22 px) — only Order's
                    estimate and Admin's sales tiles use text-h2 for
                    the same role, so the history headline felt
                    oversized by comparison. */}
                <div className="font-mono text-h2 font-semibold tabular-nums">
                  {formatMoney(breakdown.total)} {currency}
                </div>
              </div>
              <div className="text-right text-label text-[var(--c-fg-muted)]">
                {i18n.t('run.history.itemSummary', {
                  bought: breakdown.purchasedCount,
                  na: breakdown.unavailableCount,
                })}
                <br />
                {i18n.t('run.history.storeSummary', { stores: breakdown.perStore.size })}
              </div>
            </div>
            {/* M1.14: payment-method breakdown row. Only renders when
                the run actually mixed both methods — pure-cash and
                pure-transfer runs are unambiguous from the lump sum. */}
            {breakdown.totalCash > 0 && breakdown.totalTransfer > 0 ? (
              <div className="flex items-baseline gap-3 border-t border-[var(--c-divider)] pt-2 text-label">
                <span className="text-[var(--c-fg-muted)]">
                  💵 {i18n.t('run.label.paymentCash')}
                </span>
                <span className="font-mono tabular-nums text-[var(--c-fg)]">
                  {formatMoney(breakdown.totalCash)}
                </span>
                <span className="ml-auto text-[var(--c-fg-muted)]">
                  🏦 {i18n.t('run.label.paymentTransfer')}
                </span>
                <span className="font-mono tabular-nums text-[var(--c-fg)]">
                  {formatMoney(breakdown.totalTransfer)}
                </span>
              </div>
            ) : null}
          </div>

          {/* Per-item rows */}
          <div>
            <SectionLabel padded={false} className="mb-2">
              {i18n.t('run.history.itemsHeading')}
            </SectionLabel>
            <ul className="flex flex-col rounded-[var(--r-card)] bg-[var(--c-surface-2)] ring-hairline">
              {breakdown.items.map((it) => {
                const sku = skuById.get(it.skuId);
                const skuName = sku ? productName(sku) : it.skuId.slice(0, 8);
                const lineTotal =
                  it.status === 'purchased' && it.unitPrice && it.purchasedQty
                    ? Number(it.unitPrice) * Number(it.purchasedQty)
                    : 0;
                return (
                  <li
                    key={it.skuId}
                    className="border-b border-[var(--c-divider)] px-4 py-3 last:border-b-0"
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-body font-semibold">{skuName}</span>
                      {it.status === 'purchased' ? (
                        <span className="font-mono text-body font-semibold tabular-nums">
                          {formatMoney(lineTotal)}
                        </span>
                      ) : (
                        <Badge tone="danger">{i18n.t('run.action.markNa')}</Badge>
                      )}
                    </div>
                    <div className="text-label text-[var(--c-fg-muted)]">
                      {it.status === 'purchased'
                        ? `${formatQty(it.purchasedQty)} ${sku?.unit ?? ''} × ${formatMoney(it.unitPrice)}`
                        : it.unavailableNote ?? ''}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Per-store breakdown */}
          {breakdown.perStore.size > 0 ? (
            <div>
              <SectionLabel padded={false} className="mb-2">
                {i18n.t('run.history.storesHeading')}
              </SectionLabel>
              <ul className="flex flex-col rounded-[var(--r-card)] bg-[var(--c-surface-2)] ring-hairline">
                {[...breakdown.perStore.values()].map((ps) => {
                  const store = storeById.get(ps.storeId);
                  return (
                    <li
                      key={ps.storeId}
                      className="flex items-baseline justify-between border-b border-[var(--c-divider)] px-4 py-3 last:border-b-0"
                    >
                      <div>
                        <div className="text-body font-semibold">
                          {store?.name ?? ps.storeId.slice(0, 8)}
                        </div>
                        <div className="text-label text-[var(--c-fg-muted)]">
                          {ps.itemCount} items
                        </div>
                      </div>
                      <span className="font-mono text-body font-semibold tabular-nums">
                        {formatMoney(ps.total)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </Sheet>
  );
}
