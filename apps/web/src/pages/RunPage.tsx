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
import { addMoney } from '@compass/contracts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Banner,
  Button,
  Chip,
  ChipBar,
  ConfirmSheet as PriceCheckSheet,
  DataState,
  QueryErrorBanner,
  EmptyState,
  Input,
  Sheet,
  useToast,
} from '@compass/ui';
import { trpc, newIdempotencyKey } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { usePageMainButton, haptic } from '../hooks/useTelegram';
import { confirmThen } from '../lib/confirm';
import { useI18n, useProductName } from '../hooks/useI18n';
import { usePhotoUploader } from '../hooks/usePhotoUploader';
// M3.5: StoreSwitcher pill removed from page chrome; picker lives in
// SettingsSheet now. RunPage still uses useStoreContext indirectly
// through other paths if needed.
import { usePageMenu } from '../app/PageMenuContext';
import { useOfflineQueue } from '../hooks/useOfflineQueue';
import { PendingSyncNotice } from '../components/PendingSyncNotice';
import { isLikelyNetworkError } from '../lib/networkError';
import { useErrToast } from '../lib/errToast';
import { formatQty, formatMoney } from '../lib/format';
// Run money math — extracted to pages/runs/lib (Phase 4 step 1, unit-tested).
import { expenseLine, settleItemLine, settlePerStore } from './runs/lib/settlement';
import { countCarriedOver, STALE_PRICE_DAYS } from './runs/lib/priceState';
import {
  allItemsHandled as allItemsHandledOf,
  pendingItemCount as pendingItemCountOf,
  allStoresConfirmed as allStoresConfirmedOf,
  deliveryWaiting,
} from './runs/lib/runProgress';
// History subsystem lives in runs/history and is rendered by the 历史
// tab (pages/HistoryPage.tsx) as of 2026-07-30 — this page no longer
// imports any of it.
// Mutation sheets + draft types — extracted to runs/sheets (Phase 4 step 3).
import {
  PurchaseSheet,
  AddItemSheet,
  ConfirmSheet,
  type PurchaseDraft,
  type AddItemDraft,
} from './runs/sheets/RunSheets';
import { isUnusualPrice } from './runs/lib/priceMath';
import { mergeSplitsIntoExistingItem, mergeIntoPurchasedItem, runStoreIdsOf } from './runs/lib/runStores';
import { buildStorePickList } from './runs/lib/storePickList';
// Mid-level panels — extracted to runs/components (Phase 4 step 5).
import { ActiveRunPanel, PreviewSummaryCard, RunSessionsCard } from './runs/components/RunPanels';
import { SessionPicker } from './runs/components/SessionPicker';
import { selectPreview, selectedSessionIds } from './runs/lib/sessionSelection';
import { editPricingFromSplits, splitOverridesFor } from './runs/lib/purchaseOverrides';
import { NEW_RUN, isBuying, liveRunsOf, pickActiveRun } from './runs/lib/liveRuns';
import { overlayPendingWrites, withData } from './runs/lib/pendingOverlay';
import { useOfflineDropToast } from '../lib/offlineDrop';

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
  | { kind: 'undoPurchase'; skuId: string; skuName: string; added: boolean }
  | { kind: 'ejectSession'; sessionId: string; storeName: string; submitterName: string }
  // 2026-10-21 audit C-15: removing an expense was a one-tap ✗ with no
  // confirmation or undo.
  | { kind: 'removeExpense'; expenseId: string; label: string };

export function RunPage() {
  const i18n = useI18n();
  const productName = useProductName();
  const session = useAuthStore((s) => s.session);
  const currency = session?.member.currency ?? 'UZS';
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
  const previewQuery = trpc.run.previewCreatable.useQuery({});
  /**
   * 2026-10-21 CA-03: which approved sessions the next run / join takes.
   * Per-session overrides of the default (today's orders ticked, older
   * ones not) — see runs/lib/sessionSelection.ts. `runDateChoice` is the
   * booking date for a new run; null = the org's today.
   */
  const [sessionOverrides, setSessionOverrides] = useState<Map<string, boolean>>(
    () => new Map(),
  );
  const [runDateChoice, setRunDateChoice] = useState<string | null>(null);
  const [attachSheetOpen, setAttachSheetOpen] = useState(false);
  const previewToday = previewQuery.data?.today ?? null;
  const chosenSessionIds = useMemo(
    () => selectedSessionIds(previewQuery.data?.sessions ?? [], previewToday, sessionOverrides),
    [previewQuery.data?.sessions, previewToday, sessionOverrides],
  );
  const selectedPreview = useMemo(
    () => (previewQuery.data ? selectPreview(previewQuery.data, chosenSessionIds) : undefined),
    [previewQuery.data, chosenSessionIds],
  );
  /** 2026-10-21 CA-04: run-switcher choice (run id, NEW_RUN, or null = default). */
  const [selectedRunKey, setSelectedRunKey] = useState<string | null>(null);
  const runsQuery = trpc.run.list.useQuery();
  // CAT-7 (2026-10-30): include archived products so lines already ordered,
  // approved or bought still show their name and unit (they showed as an id
  // fragment, or not at all). Pickers filter archived ones out.
  const skusQuery = trpc.catalog.skus.useQuery({ includeArchived: true });
  const categoriesQuery = trpc.catalog.categories.useQuery();
  const storesQuery = trpc.catalog.stores.useQuery({ permission: 'run.purchase' });
  // 2026-10-21 audit CA-40: archived suppliers are filtered below, except
  // the one already recorded on the row being edited (so it still shows).
  const suppliersQuery = trpc.catalog.suppliers.useQuery({ includeArchived: true });
  const expenseTemplatesQuery = trpc.run.expenseTemplates.useQuery(undefined, {
    enabled:
      !!session &&
      (session.permissions.includes('run.purchase') ||
        session.permissions.includes('users.manage') ||
        session.permissions.includes('org.admin')),
  });

  const utils = trpc.useUtils();
  // RE-DLV-4 / R2-DLV-3: a refused replay says which action failed.
  const offlineDropToast = useOfflineDropToast();
  const invalidateRunQuietly = useCallback(
    (includeList = false) => {
      setTimeout(() => {
        void utils.run.get.invalidate();
        if (includeList) void utils.run.list.invalidate();
      }, 650);
    },
    [utils],
  );
  const offline = useOfflineQueue(
    {
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
          entry.idempotencyKey ? { context: { idempotencyKey: entry.idempotencyKey } } : undefined,
        );
        void utils.run.get.invalidate();
      },
      'run.deliverToStore': async (entry) => {
        await utils.client.run.deliverToStore.mutate(
          entry.input as Parameters<typeof utils.client.run.deliverToStore.mutate>[0],
          entry.idempotencyKey ? { context: { idempotencyKey: entry.idempotencyKey } } : undefined,
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
    },
    { onDrop: offlineDropToast },
  );

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
      // 2026-10-21 CA-03/CA-04: land on the run just created (or the
      // buying run handed back) and forget this trip's ticks / date.
      if (res?.runId) setSelectedRunKey(res.runId);
      setSessionOverrides(new Map());
      setRunDateChoice(null);
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
      setAttachSheetOpen(false);
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
  /**
   * True while the in-flight revisePurchase is a ROW-LEVEL payment flip
   * rather than a sheet submit. A ref, not state, because onSuccess
   * closes over the render in which mutate() was called.
   */
  const paymentFlipInFlight = useRef(false);

  const revisePurchase = trpc.run.revisePurchase.useMutation({
    onSuccess: () => {
      invalidateRunQuietly();
      // A row-level flip opened no sheet, so it must not close one.
      //
      // This handler used to clear the draft unconditionally, which was
      // correct while the sheet was its only caller. The payment toggle
      // is a second caller that opens no modal, so on a slow link a
      // purchaser who taps 💵, sees nothing happen, and then opens a row
      // to edit it would have that sheet torn away mid-keystroke when
      // the flip landed — under a green "purchase updated" toast that
      // reads as confirmation of what they had just typed and never
      // sent.
      if (!paymentFlipInFlight.current) setPurchaseDraft(null);
      haptic('success');
      toast.success(i18n.t('run.toast.purchaseRevised'));
    },
    onError: errToast('run.toast.couldNotSavePurchase'),
  });
  /**
   * Is the in-flight revisePurchase the SHEET's, rather than a row's
   * payment-method flip?
   *
   * Both callers share one mutation, so `revisePurchase.isPending` alone
   * was putting an unrelated open sheet's primary button — and the page
   * MainButton — into a loading state whenever someone tapped 💵 on a
   * row. `paymentBusySkuId` is non-null exactly while the row-level flip
   * is the request in flight.
   */
  const revisePurchaseBusyForSheet = revisePurchase.isPending && paymentBusySkuId === null;

  // BUY-9 (2026-10-30): the replay carries the first attempt's key (as
  // purchaseItem does), so a request that landed with its response lost
  // is not replayed into "item not pending" and a false "please review".
  const markUnavailableIdemCtx = useRef<{ idempotencyKey?: string }>({}).current;
  const markUnavailable = trpc.run.markUnavailable.useMutation({
    trpc: { context: markUnavailableIdemCtx },
    onMutate: () => {
      const idempotencyKey = newIdempotencyKey();
      markUnavailableIdemCtx.idempotencyKey = idempotencyKey;
      return { idempotencyKey };
    },
    onSuccess: () => {
      invalidateRunQuietly();
      setUnavailableFor(null);
      setUnavailableNote('');
      toast.info(i18n.t('run.toast.markedUnavailable'));
    },
    onError: (err, vars, ctx) => {
      if (isLikelyNetworkError(err)) {
        void offline.enqueue('run.markUnavailable', vars, ctx?.idempotencyKey);
        setUnavailableFor(null);
        setUnavailableNote('');
        toast.info(i18n.t('run.toast.purchaseSavedOffline'));
      } else {
        errToast('common.error')(err);
      }
    },
  });
  // BUY-5 (2026-10-30): the demand that joined after an item was decided
  // will not be bought.
  const dismissTopUp = trpc.run.dismissTopUp.useMutation({
    onSuccess: () => {
      invalidateRunQuietly(true);
      toast.info(i18n.t('run.topUp.dismissed'));
    },
    onError: errToast('common.error'),
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
  const deliverIdemCtx = useRef<{ idempotencyKey?: string }>({}).current;
  const deliverToStore = trpc.run.deliverToStore.useMutation({
    trpc: { context: deliverIdemCtx },
    onMutate: () => {
      const idempotencyKey = newIdempotencyKey();
      deliverIdemCtx.idempotencyKey = idempotencyKey;
      return { idempotencyKey };
    },
    onSuccess: () => {
      invalidateRunQuietly(true);
      // DLV-17 (2026-10-30): the only state change with no feedback.
      haptic('success');
      toast.success(i18n.t('run.toast.delivered'));
    },
    onError: (err, vars, ctx) => {
      if (isLikelyNetworkError(err)) {
        void offline.enqueue('run.deliverToStore', vars, ctx?.idempotencyKey);
        // RE-DLV-1: close the sheet; the store row shows the queued
        // delivery, so a second tap cannot queue it again.
        setConfirmAction(null);
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
        toast.info(i18n.t('run.toast.runCancelledWithOrphans', { n: failures }));
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
    // APR-18: refused as stale when someone else changed the order since
    // this page read it; show the current rows.
    onError: (err) => {
      invalidateRunQuietly();
      errToast('common.error')(err);
    },
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
      {
        id: string;
        names: Record<string, string>;
        unit: string;
        step: string;
        categoryId: string | null;
      }
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
  // 2026-10-21 CA-04: an org may now have one run being bought plus
  // several still out for delivery. pickActiveRun keeps the old default
  // (amending for amenders → the buying run → a delivering one) and adds
  // the run switcher's explicit choice, including "new purchase" while
  // only delivering runs are open.
  const activeRun = useMemo(
    () => pickActiveRun(runsQuery.data ?? [], { canAmend, selectedKey: selectedRunKey }),
    [runsQuery.data, canAmend, selectedRunKey],
  );
  const liveRuns = useMemo(() => liveRunsOf(runsQuery.data ?? [], canAmend), [runsQuery.data, canAmend]);
  const hasBuyingRun = liveRuns.some((r) => isBuying(r.status));
  const previewSessionCount = previewQuery.data?.sessions.length ?? 0;
  /** Offer a "new purchase" chip: nothing is being bought and orders wait. */
  const canStartNewAlongside = !hasBuyingRun && previewSessionCount > 0 && liveRuns.length > 0;
  // `amending` reuses the purchasing edit surface, so most render gates
  // treat it like purchasing; `editing` = "records are editable now".
  const amending = activeRun?.status === 'amending';
  const editing = activeRun?.status === 'purchasing' || amending;

  const runDetailQueryRaw = trpc.run.get.useQuery(
    activeRun ? { runId: activeRun.id } : { runId: '' },
    { enabled: !!activeRun, refetchInterval: activeRun ? 6_000 : false },
  );
  // R2-INT-1 / RE-DLV-1 (2026-10-31): writes saved offline show on their
  // item (bought, unavailable, delivered — waiting to sync) instead of the
  // screen looking as if nothing was saved.
  const runDetailData = useMemo(
    () => overlayPendingWrites(runDetailQueryRaw.data, offline.pendingEntries),
    [runDetailQueryRaw.data, offline.pendingEntries],
  );
  const runDetailQuery = withData(runDetailQueryRaw, runDetailData);

  // 2026-10-21 audit CA-29: the stores this run serves. The purchase sheet
  // only offers these (plus any store already on the edited row), matching
  // the server's storeNotInRun guard.
  const runStoreIds = useMemo(() => runStoreIdsOf(runDetailQuery.data), [runDetailQuery.data]);
  // D9 (2026-10-31): a purchaser of only some of the run's stores adds
  // items and expenses for those stores only (the server refuses the
  // rest); the add sheet offers just those, so a shared expense is shared
  // among them instead of failing after the form is filled.
  const addableStoreIds = useMemo(() => {
    const scope = runDetailQuery.data?.purchaseScopeStoreIds;
    return scope ? runStoreIds.filter((id) => scope.includes(id)) : runStoreIds;
  }, [runStoreIds, runDetailQuery.data?.purchaseScopeStoreIds]);
  const purchaseStoreById = useMemo(() => {
    const allowed = new Set(runStoreIds);
    for (const storeId of purchaseDraft?.splits.keys() ?? []) allowed.add(storeId);
    const m = new Map<string, { id: string; name: string; code: string | null }>();
    for (const [id, store] of storeById) if (allowed.has(id)) m.set(id, store);
    return m;
  }, [runStoreIds, purchaseDraft?.splits, storeById]);

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
      const rows = (runDetailQuery.data?.splits ?? []).filter((sp) => sp.skuId === item.skuId);
      for (const sp of rows) splits.set(sp.storeId, sp.qty);
      // 2026-10-25: open on what money uses — each store's effective
      // price and method — and in per-store mode only when the stores
      // really differ (lib/purchaseOverrides).
      const pricing = editPricingFromSplits(item, rows);
      setPurchaseDraft({
        isEdit: true,
        skuId: item.skuId,
        runId: activeRun!.id,
        unitPrice: pricing.unitPrice,
        actualQty: item.purchasedQty ?? '',
        supplierId: item.supplierId ?? null,
        splits,
        splitPrices: pricing.splitPrices,
        splitPaymentMethods: pricing.splitPaymentMethods,
        perStorePricing: pricing.perStorePricing,
        receiptPhotoUrl: item.receiptPhotoUrl ?? null,
        reason: '',
        // M1.14: prefill from the existing record so editing doesn't
        // accidentally flip the method back to cash.
        paymentMethod: pricing.paymentMethod,
      });
    },
    [runDetailQuery.data, activeRun],
  );

  const allItemsHandled = useMemo(
    () => allItemsHandledOf(runDetailQuery.data?.items ?? []),
    [runDetailQuery.data],
  );
  /** Drives the "N left to handle" bottom bar during purchasing. */
  // RE-BUY-1 (2026-10-30): a purchaser of only some stores cannot handle
  // the items that also serve other stores; counting those left a
  // "N left" they could never clear.
  const pendingCount = useMemo(() => {
    const other = new Set(runDetailQuery.data?.otherStoreSkuIds ?? []);
    return pendingItemCountOf(
      (runDetailQuery.data?.items ?? []).filter((it) => !other.has(it.skuId)),
    );
  }, [runDetailQuery.data]);

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

  /** 2026-10-21 audit C-19: mirror CancelRun's preconditions
   *  (commands.ts) so the menu stops offering a cancel the server will
   *  refuse — not while amending, not once any store has confirmed, and
   *  not without run.create. */
  const canCancelRun = useMemo(() => {
    const status = activeRun?.status;
    if (status !== 'planned' && status !== 'purchasing' && status !== 'delivering') return false;
    if (!session?.permissions.includes('run.create')) return false;
    // DLV-6: delivered (not only confirmed) stores block a cancel too.
    return (runDetailQuery.data?.splits ?? []).every((sp) => !sp.deliveredAt && !sp.confirmedAt);
  }, [activeRun?.status, session?.permissions, runDetailQuery.data]);

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
        total = addMoney(total, line);
        totalCash = addMoney(totalCash, cash);
        totalTransfer = addMoney(totalTransfer, transfer);
        if (it.addedByPurchaser) {
          addedSkus += 1;
          addedTotal = addMoney(addedTotal, line);
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
      const line = expenseLine(ex);
      expensesCount += 1;
      expensesTotal = addMoney(expensesTotal, line);
      total = addMoney(total, line);
      if (ex.paymentMethod === 'transfer') totalTransfer = addMoney(totalTransfer, line);
      else totalCash = addMoney(totalCash, line);
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
    /**
     * 2026-10-21 CA-11: the one purchase-money definition — items (with
     * per-store override prices) / expenses / total — taken from run.get's
     * server-computed `money` so the sheet shows exactly what History,
     * Finance and the finish notification show. The local sums above are
     * the fallback for an older server and still drive the cash/transfer
     * and per-store breakdowns (same math, see runs/lib/settlement.ts).
     */
    const serverMoney = runDetailQuery.data?.money;
    const money = {
      items: serverMoney ? Number(serverMoney.itemsTotal) : addMoney(total, -expensesTotal),
      expenses: serverMoney ? Number(serverMoney.expensesTotal) : expensesTotal,
      total: serverMoney ? Number(serverMoney.total) : total,
    };
    return {
      skus,
      stores,
      total,
      money,
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
  /**
   * 2026-10-11: a price 5× away from the last one paid is asked about
   * once before it is saved. Not a block — the purchaser is the one who
   * knows — but the two figures are put side by side, which is all it
   * takes to see a wrong unit or a slipped zero. Every way of recording
   * a purchase goes through here. `lastPriceBySku` leaves this run's own
   * entries out, so correcting a mistake is compared with the last trip
   * and not with the mistake.
   */
  const [priceCheck, setPriceCheck] = useState<{
    name: string;
    last: string;
    next: string;
    run: (confirmed: boolean) => void;
  } | null>(null);
  const withPriceCheck = useCallback(
    (
      skuId: string,
      prices: Array<string | undefined>,
      /** `confirmed`: the purchaser was asked about the price and kept it. */
      run: (confirmed: boolean) => void,
    ) => {
      const last = runDetailQuery.data?.lastPriceBySku?.[skuId];
      const odd = prices.find((p) => !!p && isUnusualPrice(p, last));
      if (!last || !odd) {
        run(false);
        return;
      }
      const sku = skuById.get(skuId);
      setPriceCheck({ name: sku ? productName(sku) : '', last, next: odd, run });
    },
    [runDetailQuery.data?.lastPriceBySku, skuById, productName],
  );

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
          // 2026-10-25: an override is only what differs from the item, so
          // a later change of the item's method or price reaches the store.
          .map(([storeId, qty]) => ({ storeId, qty, ...splitOverridesFor(d, storeId) })),
        paymentMethod: d.paymentMethod,
      };
      withPriceCheck(
        d.skuId,
        [d.unitPrice, ...payload.storeSplits.map((sp) => ('unitPrice' in sp ? sp.unitPrice : undefined))],
        (confirmed) => {
          const sent = confirmed ? { ...payload, priceConfirmed: true } : payload;
          if (d.isEdit) {
            revisePurchase.mutate({ ...sent, reason: d.reason });
          } else {
            purchaseItem.mutate(sent);
          }
        },
      );
    },
    [purchaseItem, revisePurchase, withPriceCheck],
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
    const splitMatches = Math.abs(splitTotal - Number(purchaseDraft.actualQty || 0)) < 0.001;
    const reasonOk = !purchaseDraft.isEdit || purchaseDraft.reason.trim().length > 0;
    const splitPricesOk =
      !purchaseDraft.perStorePricing ||
      [...purchaseDraft.splits.entries()]
        .filter(([, qty]) => Number(qty) > 0)
        .every(
          ([storeId]) =>
            Number(purchaseDraft.splitPrices.get(storeId) || purchaseDraft.unitPrice) > 0,
        );
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
      // 2026-10-21 CA-03: only the ticked sessions (default: today's), and
      // the chosen booking date (default: the org's today).
      if (previewSessionCount > 0) {
        const sessionIds = chosenSessionIds;
        const runDate = runDateChoice ?? previewToday ?? undefined;
        // Gate on connectivity HERE, at the point of the decision, not
        // at the first save. run.create is not in the offline outbox and
        // the replay classifier discards BAD_REQUEST permanently, so a
        // purchaser who starts offline would walk to a stall, agree a
        // price, type it in and only then discover there is no run to
        // put it in.
        const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
        // Server re-checks (run.errors.runDateInFuture / invalidRunDate).
        const dateOk = !runDate || !previewToday || runDate <= previewToday;
        return {
          text: offline
            ? i18n.t('run.offline.needNetworkToStart')
            : sessionIds.length === 0
              ? i18n.t('run.select.noneSelected')
              : !dateOk
                ? // BUY-19: the button only greyed out; say why.
                  i18n.t('run.errors.runDateInFuture')
                : i18n.t('run.action.startPurchase'),
          onClick: () => {
            if (offline || sessionIds.length === 0 || !dateOk || create.isPending) return;
            create.mutate({
              sessionIds,
              startImmediately: true,
              ...(runDate ? { date: runDate } : {}),
            });
          },
          visible: true,
          active: !offline && sessionIds.length > 0 && dateOk && !create.isPending,
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
        // 2026-05-04 hid this button entirely until every item was
        // handled, reasoning that a disabled "Process every item first"
        // label ate 60 px for nothing since "the user already knows from
        // the row badges what's pending".
        //
        // 2026-07-30 (flow review): walking the screen with 85 of 87
        // items outstanding, that assumption doesn't survive contact.
        // The row badges are a 7 px ring spread over ~7,000 px of list;
        // the "剩 85" counter scrolls away with the section header; and
        // the bottom strip — the one piece of chrome that is always in
        // view — was empty. The screen answered neither "what's left?"
        // nor "how do I move on?". runProgress.ts's own header calls this
        // out: a wrong answer here doesn't disable a button, it deletes
        // it and strands the purchaser.
        //
        // The fix isn't a dead disabled button. It's the same slot doing
        // useful work the whole time: it states the remaining count and
        // jumps to the next item that needs one, then becomes the advance
        // action at zero. Always visible, always actionable.
        // RE-BUY-1: starting delivery is a run-wide step; a purchaser of
        // only some of the run's stores can neither finish the other
        // stores' items nor start it, so say who does.
        if (!allItemsHandled || (runDetailQuery.data?.otherStoreSkuIds ?? []).length > 0) {
          if (pendingCount === 0) {
            // Only items of other stores remain (RE-BUY-1).
            return {
              text: i18n.t('run.action.waitingOtherStores'),
              onClick: () => {},
              visible: true,
              active: false,
            };
          }
          return {
            text: i18n.t('run.action.remainingItems', { n: pendingCount }),
            onClick: () => {
              const next = document.querySelector('[data-run-item-pending]');
              next?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            },
            visible: pendingCount > 0,
            active: true,
          };
        }
        return {
          text: i18n.t('run.action.startDelivery'),
          onClick: () => setConfirmAction('startDelivery'),
          visible: true,
          active: true,
        };
      case 'delivering': {
        // U7 (2026-10-31): the bar used to vanish until every store had
        // confirmed. It now says what delivery is waiting for: stores
        // still to be handed their goods (tap: go to the store list), then
        // the stores that have not confirmed receipt, by name.
        if (!allStoresConfirmed) {
          const waiting = deliveryWaiting(runDetailQuery.data?.splits ?? []);
          if (waiting.undelivered.length > 0) {
            return {
              text: i18n.t('run.action.deliverRemaining', { n: waiting.undelivered.length }),
              onClick: () => {
                const stores = document.querySelector('[data-run-stores]');
                stores?.scrollIntoView({ block: 'center', behavior: 'smooth' });
              },
              visible: true,
              active: true,
            };
          }
          return {
            text: i18n.t('run.action.waitingStoreConfirm', {
              stores: waiting.unconfirmed
                .map((id) => storeById.get(id)?.name ?? id.slice(0, 8))
                .join(i18n.t('common.listSeparator')),
            }),
            onClick: () => {},
            visible: true,
            active: false,
          };
        }
        // RE-DLV-3: someone the server would refuse is told so here.
        const blocked = runDetailQuery.data?.finishBlockedReason;
        if (blocked) {
          return {
            text: i18n.t(
              blocked === 'run.errors.runHasOtherStores'
                ? 'run.action.finishBlocked.otherStores'
                : 'run.action.finishBlocked.noPermission',
            ),
            onClick: () => {},
            visible: true,
            active: false,
          };
        }
        return {
          text: i18n.t('run.action.finish'),
          onClick: () => setConfirmAction('finish'),
          visible: true,
          active: true,
        };
      }
      case 'amending':
        // Super-admin correction session — close it by re-freezing totals.
        if (runDetailQuery.data?.finishBlockedReason) {
          return {
            text: i18n.t('run.errors.cannotAmend'),
            onClick: () => {},
            visible: true,
            active: false,
          };
        }
        return {
          text: i18n.t('run.action.refinalize'),
          onClick: () => setConfirmAction('refinalize'),
          visible: true,
          active: true,
        };
      default:
        return { text: '', onClick: () => {}, visible: false, active: false };
    }
  }, [
    activeRun,
    allItemsHandled,
    allStoresConfirmed,
    pendingCount,
    runDetailQuery.data?.otherStoreSkuIds,
    runDetailQuery.data?.splits,
    runDetailQuery.data?.finishBlockedReason,
    storeById,
    i18n,
    previewSessionCount,
    chosenSessionIds,
    runDateChoice,
    previewToday,
    create,
  ]);

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
      const submitting = purchaseItem.isPending || revisePurchaseBusyForSheet;
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
    revisePurchaseBusyForSheet,
    submitPurchaseDraft,
    unavailableFor,
    unavailableNote,
    markUnavailable,
    i18n,
  ]);

  /* The "multi-option sheet" branch is gone with the history drill
     (2026-07-30). Its only member was `historyDetailFor`; the history
     detail sheet lives on the 历史 tab now, so on this page there is
     no longer any sheet that hides MainButton outright. */

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
          const showBreakdown = finishSummary.totalCash > 0 && finishSummary.totalTransfer > 0;
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
                  currency,
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
                  total: formatMoney(finishSummary.money.expenses),
                  currency,
                })
              : '';
          // 2026-10-21 CA-11: always items / expenses / total.
          const moneyLine =
            '\n' +
            i18n.t('run.confirm.finish.money', {
              items: formatMoney(finishSummary.money.items),
              expenses: formatMoney(finishSummary.money.expenses),
              total: formatMoney(finishSummary.money.total),
              currency,
            });
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
                    const storeName = storeById.get(ps.storeId)?.name ?? ps.storeId.slice(0, 8);
                    const mixed = ps.cash > 0 && ps.transfer > 0;
                    const tail = mixed
                      ? ` · ${i18n.t('run.label.paymentCash')} ${formatMoney(ps.cash)}` +
                        ` · ${i18n.t('run.label.paymentTransfer')} ${formatMoney(ps.transfer)}`
                      : '';
                    return i18n.t('common.labelValue', {
                      label: storeName,
                      value: `${formatMoney(ps.total)}${tail}`,
                    });
                  })
                  .join('\n')
              : '';
          // DLV-11 (2026-10-30): the bills below still charge each store
          // for what was split to it, even where the store signed for less.
          // Say so before the run locks: every line signed short / wrong /
          // spoiled, and roughly how much was not received.
          const receiptIssues = (runDetailQuery.data?.splits ?? []).filter(
            (sp) => sp.confirmStatus != null && sp.confirmStatus !== 'ok',
          );
          const itemPrice = new Map(
            (runDetailQuery.data?.items ?? []).map((it) => [it.skuId, it.unitPrice]),
          );
          const missingValue = receiptIssues.reduce((sum, sp) => {
            const price = Number(sp.unitPrice ?? itemPrice.get(sp.skuId) ?? 0);
            const missing = Number(sp.qty) - Number(sp.confirmReceivedQty ?? 0);
            return sum + (missing > 0 ? missing * price : 0);
          }, 0);
          const receiptLine =
            receiptIssues.length > 0
              ? '\n\n' +
                i18n.t('run.confirm.finish.receiptIssues', {
                  n: receiptIssues.length,
                  amount: formatMoney(missingValue),
                  currency,
                }) +
                '\n' +
                receiptIssues
                  .slice(0, 5)
                  .map((sp) => {
                    const sku = skuById.get(sp.skuId);
                    return i18n.t('run.confirm.finish.receiptIssueLine', {
                      sku: sku ? productName(sku) : sp.skuId.slice(0, 8),
                      store: storeById.get(sp.storeId)?.name ?? sp.storeId.slice(0, 8),
                      received: formatQty(sp.confirmReceivedQty ?? '0'),
                      qty: formatQty(sp.qty),
                    });
                  })
                  .join('\n') +
                (receiptIssues.length > 5
                  ? '\n' + i18n.t('run.confirm.finish.receiptIssuesMore', { n: receiptIssues.length - 5 })
                  : '')
              : '';
          return {
            title: i18n.t('run.confirm.finish.title'),
            body:
              i18n.t('run.confirm.finish.body') +
              '\n\n' +
              i18n.t('run.confirm.finish.summary', {
                items: finishSummary.skus,
                stores: finishSummary.stores,
                total: formatMoney(finishSummary.money.total),
                currency,
              }) +
              moneyLine +
              breakdownLine +
              addedLine +
              expensesLine +
              carriedLine +
              perStoreLines +
              receiptLine,
            confirmLabel: i18n.t('run.action.finish'),
            danger: false,
            requireReason: false,
            isPending: finish.isPending,
            run: () => finish.mutate({ runId }, { onSuccess: () => setConfirmAction(null) }),
          };
        }
        case 'refinalize':
          // finishSummary reflects the live (corrected) run.get during
          // amending. 2026-10-21 CA-11: the sheet used to show an
          // items-only figure here while the finish sheet showed items +
          // expenses. Both now show the one definition — items / expenses
          // / total — and RunRefinalized freezes itemsTotal and
          // expensesTotal explicitly (actual_total stays the items part).
          return {
            title: i18n.t('run.confirm.refinalize.title'),
            body:
              i18n.t('run.confirm.refinalize.body', {
                total: formatMoney(finishSummary.money.total),
              }) +
              '\n' +
              i18n.t('run.confirm.finish.money', {
                items: formatMoney(finishSummary.money.items),
                expenses: formatMoney(finishSummary.money.expenses),
                total: formatMoney(finishSummary.money.total),
                currency,
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
        case 'deliverStore': {
          // 2026-10-21 FE-03 (F3-01): say what is being handed over — the
          // store's line count (and goods total when every line is
          // priced), plus how many ordered SKUs were unavailable.
          const runDetail = runDetailQuery.data;
          const pick = runDetail
            ? buildStorePickList({
                storeId: confirmAction.storeId,
                items: runDetail.items,
                splits: runDetail.splits,
                demand: runDetail.perStoreDemand,
              })
            : null;
          const pickSummary = pick
            ? [
                i18n.t('run.label.itemsCount', { n: pick.lines.length }),
                ...(pick.total !== null && pick.total > 0
                  ? // DLV-18 (2026-10-30): goods only; the store's share of
                    // expenses is added on the final bill.
                    [`${i18n.t('run.label.itemsTotal')} ${formatMoney(pick.total)} ${currency}`]
                  : []),
                ...(pick.unavailable.length > 0
                  ? [i18n.t('run.filter.unavailable', { n: pick.unavailable.length })]
                  : []),
              ].join(' · ') + '\n'
            : '';
          return {
            title: i18n.t('run.confirm.deliver.title', { store: confirmAction.storeName }),
            body: pickSummary + i18n.t('run.confirm.deliver.body'),
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
        }
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
            // BUY-4: a row the purchaser added is removed, not reopened.
            body: i18n.t(
              confirmAction.added
                ? 'run.confirm.undoPurchase.bodyAdded'
                : 'run.confirm.undoPurchase.body',
            ),
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
        case 'removeExpense':
          return {
            title: i18n.t('run.action.removeExpense'),
            body: confirmAction.label,
            confirmLabel: i18n.t('run.action.removeExpense'),
            danger: true,
            requireReason: false,
            isPending: removeExpense.isPending,
            run: () =>
              removeExpense.mutate(
                { runId, expenseId: confirmAction.expenseId, reason: '' },
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
    runDetailQuery.data,
    currency,
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
    removeExpense,
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
            ...(canCancelRun
              ? [
                  {
                    label: i18n.t('run.action.cancelRun'),
                    variant: 'danger' as const,
                    onClick: () => setConfirmAction('cancel'),
                  },
                ]
              : []),
          ],
        }
      : null,
  );

  if (!session) return null;

  // M1.9-extra (P4): adopted shared <PageHeader>. Subtitle folds in
  // run date + phase label so the line under the title shows
  // "2026-05-07 · Purchase" or "No active run" depending on state.
  /**
   * Whole days between the run's date and today; 0 for today's run.
   *
   * `runDate` is YYYY-MM-DD in the ORG's timezone while "today" here comes
   * from the device. On a device set to a wildly different timezone the
   * count can be off by one around midnight — acceptable, because this
   * drives a "this is old" hint, not a gate. Both sides are pinned to UTC
   * midnight so the subtraction itself can't drift.
   */
  const runAgeDays = (() => {
    if (!activeRun) return 0;
    const runMs = Date.parse(`${activeRun.runDate}T00:00:00Z`);
    if (Number.isNaN(runMs)) return 0;
    const now = new Date();
    const todayMs = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.max(0, Math.round((todayMs - runMs) / 86_400_000));
  })();

  // 2026-07-30: drop the year for runs in the current year. The bar has to
  // fit `+ 新增`, this line and the staleness badge inside ~223 px once
  // Telegram's chrome pads are subtracted; "2026-" is the least
  // informative five characters available, and the badge now carries "how
  // old" anyway.
  const runDateShort =
    activeRun && activeRun.runDate.slice(0, 4) === String(new Date().getFullYear())
      ? activeRun.runDate.slice(5)
      : (activeRun?.runDate ?? '');

  const runSubtitle = activeRun
    ? `${runDateShort} · ${
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
         now only renders when there's an active run to label.

         2026-07-30: dropped the `--app-chrome-pad-*` inline padding this
         bar copied from StickyPageBar. Telegram's Close / ⋯ overlay the
         reserved strip Shell renders above the scroll container; this bar
         is below that strip and was never underneath them. See the
         StickyPageBar docblock. */}
      {activeRun ? (
        <div className="sticky top-0 z-[1] flex min-h-9 items-center gap-2 border-b border-[var(--c-divider)] bg-[var(--c-bg)] px-4 py-2">
          {/* M3.36 shipped the "×1000" price-mode toggle here as a pill
              whose entire meaning lived in a `title` attribute. On a
              touch device there is no hover, so nothing ever revealed
              what "×千" did — while it defaulted to ON and silently
              multiplied every price the purchaser typed by 1000. It also
              cost width in a bar that, inside Telegram, has only ~223 px
              to work with once the chrome pads are subtracted.

              2026-07-30: the control moved ONTO the price field's unit
              suffix in PurchaseRow (`K·UZS` / `UZS`). That is where the
              user is looking when the setting matters, the suffix states
              the current unit rather than naming an operation, and the
              sticky bar gets its width back for the run identity. */}
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
              className="hit-44 shrink-0 rounded-[var(--r-pill)] bg-[var(--c-action)] px-2.5 py-0.5 text-old-label font-semibold text-[var(--c-action-fg)] active:opacity-70"
            >
              {i18n.t('run.action.addItem.button')}
            </button>
          ) : null}
          {/* 2026-07-30 (flow review): this line is the definite article
              for everything below it — every submission, item and price on
              the page belongs to THIS run — and it was rendered as the
              smallest, faintest, right-most element in the bar. Removing
              the ×千 pill freed the width to give it normal weight.

              The staleness badge is the other half. The run I walked was
              3 days old and still `purchasing`, with nothing anywhere
              saying so; a purchaser opening the app can't tell an active
              trip from one somebody forgot to close. */}
          <span className="min-w-0 flex-1 truncate text-old-body font-semibold tabular-nums text-[var(--c-fg)]">
            #{activeRun.runIndex + 1} · {runSubtitle}
          </span>
          {runAgeDays > 0 ? (
            <span className="shrink-0 whitespace-nowrap rounded-[var(--r-pill)] bg-[var(--c-warn-bg)] px-1.5 py-0.5 text-old-label text-[var(--c-warning-fg)]">
              {i18n.t('run.label.staleRun', { days: runAgeDays })}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* BUY-8 (2026-10-30): purchases saved offline used to look unsaved. */}
      <PendingSyncNotice count={offline.pendingCount} />

      {/* 2026-10-21 CA-04: run switcher. Shown once there is more than one
          open run (one being bought + earlier ones still delivering), or
          when only delivering runs are open while approved orders wait —
          then "new purchase" opens the preview to start the next trip. */}
      {liveRuns.length > 1 || canStartNewAlongside ? (
        <ChipBar variant="radio" ariaLabel={i18n.t('run.switcher.label')}>
          {liveRuns.map((r) => (
            <Chip
              key={r.id}
              selected={activeRun?.id === r.id}
              onClick={() => setSelectedRunKey(r.id)}
            >
              #{r.runIndex + 1} · {r.runDate.slice(5)} ·{' '}
              {r.status === 'planned'
                ? i18n.t('run.step.plan')
                : r.status === 'purchasing'
                  ? i18n.t('run.step.purchase')
                  : r.status === 'delivering'
                    ? i18n.t('run.step.deliver')
                    : i18n.t('run.step.amend')}
            </Chip>
          ))}
          {canStartNewAlongside ? (
            <Chip selected={!activeRun} onClick={() => setSelectedRunKey(NEW_RUN)}>
              {i18n.t('run.switcher.newRun')}
            </Chip>
          ) : null}
        </ChipBar>
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
          domain layer guards against duplicates.

          2026-10-21 CA-03: the button no longer merges EVERY waiting
          session — it opens a picker (today's ticked, older ones flagged
          and unticked) and attaches only what the purchaser keeps. */}
      {activeRun &&
      (activeRun.status === 'planned' || activeRun.status === 'purchasing') &&
      previewSessionCount > 0 ? (
        <div className="px-4 pt-2">
          <Banner
            tone="info"
            title={i18n.t('run.attach.banner.title', { n: previewSessionCount })}
            action={
              <Button
                variant="pearl"
                size="sm"
                loading={attachSessions.isPending}
                onClick={() => setAttachSheetOpen(true)}
              >
                {i18n.t('run.action.attachSessions')}
              </Button>
            }
          />
        </div>
      ) : null}
      <Sheet
        open={attachSheetOpen && !!activeRun}
        onOpenChange={(open) => {
          if (!open && attachSessions.isPending) return;
          setAttachSheetOpen(open);
        }}
        title={i18n.t('run.attach.sheet.title')}
        disableAutoFocus
        footer={
          <Button
            variant="primary"
            size="lg"
            className="w-full"
            disabled={chosenSessionIds.length === 0 || attachSessions.isPending}
            loading={attachSessions.isPending}
            onClick={() => {
              if (!activeRun || chosenSessionIds.length === 0) return;
              attachSessions.mutate({ runId: activeRun.id, sessionIds: chosenSessionIds });
            }}
          >
            {i18n.t('run.action.attachSelected', { n: chosenSessionIds.length })}
          </Button>
        }
      >
        <SessionPicker
          bare
          sessions={previewQuery.data?.sessions ?? []}
          today={previewToday}
          overrides={sessionOverrides}
          onChange={setSessionOverrides}
          i18n={i18n}
        />
      </Sheet>

      <div className="flex flex-col gap-2 px-4 pt-2">
        {runsQuery.isError && !runsQuery.data ? (
          // F11 (2026-10-30): a failed run list read as "no approved
          // orders to plan" — the buyer was told there was nothing to buy.
          <QueryErrorBanner query={runsQuery} />
        ) : runsQuery.data === undefined && runsQuery.fetchStatus === 'paused' ? (
          // R2-ENG-1 (2026-10-31): offline with no saved run list, not
          // "nothing to plan"; it loads by itself once back online.
          <EmptyState title={i18n.t('common.offlineNoData')} />
        ) : !activeRun ? (
          <DataState query={previewQuery}>
            {(p) =>
              p.sessions.length === 0 ? (
                <EmptyState
                  title={i18n.t('run.empty.noPlannable')}
                  description={i18n.t('run.empty.noPlannableBody')}
                />
              ) : (
                <>
                  {/* 2026-10-21 CA-03: choose orders (grouped by date,
                      today's ticked) and the booking date; the summary
                      below shows only what will be planned. */}
                  <SessionPicker
                    sessions={p.sessions}
                    today={p.today ?? null}
                    overrides={sessionOverrides}
                    onChange={setSessionOverrides}
                    i18n={i18n}
                    runDate={runDateChoice ?? p.today ?? ''}
                    onRunDateChange={(d) => setRunDateChoice(d || null)}
                  />
                  {selectedPreview && selectedPreview.plannedItems.length > 0 ? (
                    <PreviewSummaryCard
                      preview={selectedPreview}
                      skuById={skuById}
                      productName={productName}
                      i18n={i18n}
                      toast={toast}
                    />
                  ) : null}
                </>
              )
            }
          </DataState>
        ) : null}

        {/* 2026-10-21 FE-01 (F3-02): every phase section below is gated on
            run.get's data, so a slow or failed load left a blank page with
            no retry. Only while there is NO data: a failed 6 s background
            poll keeps showing the last good run instead of hiding it. */}
        {activeRun && !runDetailQuery.data ? (
          <DataState query={runDetailQuery}>{() => null}</DataState>
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
                storeName: storeById.get(d.storeId)?.name ?? d.storeId.slice(0, 8),
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
            onTogglePriceUnit={togglePriceInThousands}
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
              withPriceCheck(skuId, [unitPrice], (confirmed) => {
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
                ...(confirmed ? { priceConfirmed: true } : {}),
              });
              });
            }}
            onMarkNa={(skuId) => setUnavailableFor({ runId: activeRun.id, skuId })}
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
              if (rows.some((sp) => sp.paymentMethod) || !item.unitPrice || !item.purchasedQty) {
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
              paymentFlipInFlight.current = true;
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
                {
                  onSettled: () => {
                    setPaymentBusySkuId(null);
                    paymentFlipInFlight.current = false;
                  },
                },
              );
            }}
            onUnmark={(skuId, skuName) =>
              setConfirmAction({ kind: 'unmarkUnavailable', skuId, skuName })
            }
            onTopUpBuy={(item) => {
              const sku = skuById.get(item.skuId);
              const skuName = sku ? productName(sku) : item.skuId.slice(0, 8);
              // An unavailable item comes back as pending (with the whole
              // demand) through the existing restore flow.
              if (item.status === 'unavailable') {
                setConfirmAction({ kind: 'unmarkUnavailable', skuId: item.skuId, skuName });
                return;
              }
              openPurchaseEdit(item);
              // Prefill the extra where the demand is not yet covered, so it
              // goes to the stores that asked for it, not spread over all.
              const demand = (runDetailQuery.data?.perStoreDemand ?? []).filter(
                (d) => d.skuId === item.skuId,
              );
              setPurchaseDraft((d) => {
                if (!d) return d;
                const splits = new Map(d.splits);
                let remaining = Number(item.topUpQty ?? 0);
                for (const dm of demand) {
                  if (remaining <= 0) break;
                  const gap = Number(dm.qty) - Number(splits.get(dm.storeId) ?? 0);
                  if (gap <= 0) continue;
                  const add = Math.min(gap, remaining);
                  splits.set(dm.storeId, String(Number(splits.get(dm.storeId) ?? 0) + add));
                  remaining -= add;
                }
                const total = [...splits.values()].reduce((sum, q) => sum + Number(q), 0) + remaining;
                return {
                  ...d,
                  splits,
                  actualQty: String(Number(total.toFixed(3))),
                  reason: i18n.t('run.topUp.reason'),
                };
              });
            }}
            onTopUpDismiss={(item) =>
              confirmThen(i18n.t('run.topUp.dismissConfirm', { qty: formatQty(item.topUpQty ?? '0') }), () =>
                dismissTopUp.mutate({ runId: activeRun!.id, skuId: item.skuId }),
              )
            }
            onEditPrice={(item) => {
              openPurchaseEdit(item);
              setPurchaseDraft((d) =>
                d ? { ...d, qtyLocked: true, reason: i18n.t('run.prices.reason') } : d,
              );
            }}
            onOpenAdvancedPurchase={(item) => {
              // User changed qty from planned (or no per-store demand
              // info available) — open the full PurchaseSheet so they
              // can manually allocate across stores. Pre-fill with
              // demand if known.
              const splits = new Map<string, string>();
              const demand =
                runDetailQuery.data?.perStoreDemand?.filter((d) => d.skuId === item.skuId) ?? [];
              for (const d of demand) splits.set(d.storeId, d.qty);
              // Legacy runs planned before perStoreDemand existed: prefill
              // only when the run serves exactly one store. 2026-10-21
              // audit CA-29: this used to fall back to the purchaser's
              // first store, which need not be part of the run at all.
              if (splits.size === 0 && runStoreIds.length === 1) {
                splits.set(runStoreIds[0]!, item.plannedQty);
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
            onMarkExtraStatus={(sessionId, extraIndex, status, expectedSeq) =>
              markExtraStatus.mutate({ sessionId, extraIndex, status, expectedSeq })
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
            onRemoveExpense={(expenseId, label) =>
              setConfirmAction({ kind: 'removeExpense', expenseId, label })
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

        {/* History section removed 2026-07-30 — it is the 历史 tab now.
          It had been the ONLY route to purchase history, which meant
          history inherited this page's `run.purchase` gate and no
          store manager could reach their own store's spend. Moving it
          to a top-level tab fixes both that and the "scroll past the
          run you're in the middle of" problem. See HistoryPage.tsx. */}
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
        storeById={purchaseStoreById}
        suppliers={(suppliersQuery.data ?? []).filter(
          (sup) => !sup.isArchived || sup.id === purchaseDraft?.supplierId,
        )}
        productName={productName}
        photoUploader={photoUploader}
        i18n={i18n}
        priceInThousands={priceInThousands}
        onTogglePriceUnit={togglePriceInThousands}
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
                  added: !!runDetailQuery.data?.items.find((it) => it.skuId === d.skuId)
                    ?.addedByPurchaser,
                });
              }
            : undefined
        }
        onChange={setPurchaseDraft}
        onSubmit={submitPurchaseDraft}
        submitting={purchaseItem.isPending || revisePurchaseBusyForSheet}
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
        runStoreIds={addableStoreIds}
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
        skus={(skusQuery.data ?? []).filter((s) => !s.isArchived)}
        expenseTemplates={expenseTemplatesQuery.data ?? []}
        storeById={storeById}
        productName={productName}
        photoUploader={photoUploader}
        i18n={i18n}
        priceInThousands={priceInThousands}
        onTogglePriceUnit={togglePriceInThousands}
        onCancel={() => setAddItemDraft(null)}
        onChange={setAddItemDraft}
        onSubmit={function save(
          d: AddItemDraft,
          priceChecked?: boolean,
          priceConfirmed?: boolean,
        ) {
          // Expenses have no last price to compare with; products do.
          if (!priceChecked && d.mode === 'sku' && d.skuId) {
            withPriceCheck(d.skuId, [d.unitPrice], (confirmed) => save(d, true, confirmed));
            return;
          }
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
            const existingItem = runDetailQuery.data?.items.find((it) => it.skuId === d.skuId);
            const existingSplits = (runDetailQuery.data?.splits ?? []).filter(
              (sp) => sp.skuId === d.skuId,
            );
            const existingStoreIds = new Set(existingSplits.map((sp) => sp.storeId));
            const overlapsExistingStore = storeSplits.some((sp) =>
              existingStoreIds.has(sp.storeId),
            );
            if (existingItem && (d.skuCostMode === 'separateExpense' || overlapsExistingStore)) {
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
              // 2026-10-21 audit CA-29 (C-05): a pending row has no splits
              // yet, so its base is the other stores' demand — merging
              // onto the (empty) splits dropped their order.
              const { splits: combinedSplits, totalQty: combinedQty } =
                mergeSplitsIntoExistingItem({
                  status: existingItem.status,
                  existingSplits,
                  demand: (runDetailQuery.data?.perStoreDemand ?? []).filter(
                    (dm) => dm.skuId === d.skuId,
                  ),
                  newSplits: storeSplits,
                });
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
                  ...(priceConfirmed ? { priceConfirmed: true } : {}),
                });
                setAddItemDraft(null);
                return;
              }
              if (existingItem.status === 'purchased') {
                // 2026-10-21 FE-04 (F3-07): keep the row's supplier,
                // receipt and per-store price/payment overrides; only the
                // new store's split is appended (see mergeIntoPurchasedItem).
                const merged = mergeIntoPurchasedItem({
                  item: existingItem,
                  existingSplits,
                  newSplits: storeSplits,
                  draft: {
                    unitPrice: d.unitPrice,
                    paymentMethod: d.paymentMethod,
                    supplierId: d.supplierId,
                    receiptPhotoUrl: d.receiptPhotoUrl,
                  },
                });
                revisePurchase.mutate({
                  runId: d.runId,
                  skuId: d.skuId,
                  ...merged,
                  ...(priceConfirmed ? { priceConfirmed: true } : {}),
                  reason: d.reason.trim() || i18n.t('run.action.addItem.defaultCrossStoreReason'),
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
              ...(priceConfirmed ? { priceConfirmed: true } : {}),
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
      <PriceCheckSheet
        open={!!priceCheck}
        title={i18n.t('run.price.check.title')}
        body={
          priceCheck
            ? i18n.t('run.price.check.body', {
                name: priceCheck.name,
                last: formatMoney(priceCheck.last),
                next: formatMoney(priceCheck.next),
                currency,
              })
            : ''
        }
        confirmLabel={i18n.t('run.price.check.confirm')}
        cancelLabel={i18n.t('run.price.check.fix')}
        showCancelInSheet
        onConfirm={() => {
          const go = priceCheck?.run;
          setPriceCheck(null);
          go?.(true);
        }}
        onCancel={() => setPriceCheck(null)}
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
    </div>
  );
}
