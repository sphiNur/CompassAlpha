/**
 * RunPage — purchaser cockpit.
 *
 * Stages and reversibility (designed 2026-05-03):
 *   - planned     : show preview, "Start purchase" via the main button.
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
 *                   Finish via the main button when all confirmed (with summary
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
import { cacheOwner } from '../lib/queryPersist';
import { hintStorage, saveRunHint } from '../lib/runHint';
import {
  Banner,
  Button,
  Chip,
  ChipBar,
  ConfirmSheet,
  DataState,
  FieldGroup,
  QueryErrorBanner,
  EmptyState,
  Input,
  LoadingState,
  Sheet,
  useTapGuard,
} from '@compass/ui';
import { trpc } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { usePageMainButton, type PageMainButtonIcon } from '../hooks/usePageMainButton';
import { scrollBehavior } from '../lib/reducedMotion';
import { RUN_PAGE } from '../config/timings';
import { readLocalPref, writeLocalPref } from '../lib/localPref';
import { useDateFormat, useI18n, useProductName, useProductNameParts } from '../hooks/useI18n';
import { rowName } from '../lib/productName';
import { usePhotoUploader } from '../hooks/usePhotoUploader';
import { usePageMenu } from '../components/PageMenuContext';
import { useOfflineQueue } from '../hooks/useOfflineQueue';
import { pollWhenOffline, useRealtimeLive } from '../hooks/useRealtime';
import { PendingSyncNotice } from '../components/PendingSyncNotice';
import { pendingChangeCount } from '../lib/pendingChanges';
import { currencyOf, formatMoney } from '../lib/format';
import { runStepLabel } from '../lib/statusLabels/run';
import { useCanSeePrices } from '../hooks/useStorePermission';
import { itemProgressCounts } from './runs/lib/runProgress';
import { otherStoreSkusOf } from './runs/types';
import {
  allItemsHandled as allItemsHandledOf,
  pendingItemCount as pendingItemCountOf,
  allStoresConfirmed as allStoresConfirmedOf,
  deliveryWaiting,
} from './runs/lib/runProgress';
// Mutation sheets + draft types — extracted to runs/sheets (Phase 4 step 3).
import {
  PurchaseSheet,
  AddItemSheet,
  type PurchaseDraft,
  type AddItemDraft,
} from './runs/sheets/RunSheets';
import { isUnusualFirstPrice, isUnusualPrice } from './runs/lib/priceMath';
import { runStoreIdsOf } from './runs/lib/runStores';
import { closedFor } from './runs/lib/draftClose';
// Mid-level panels — extracted to runs/components (Phase 4 step 5).
import { ActiveRunPanel, PreviewSummaryCard, RunSessionsCard } from './runs/components/RunPanels';
import { SessionPicker } from './runs/components/SessionPicker';
import { daysOld, selectPreview, selectedSessionIds } from './runs/lib/sessionSelection';
import {
  editPricingFromSplits,
  paymentFlipRevision,
  splitOverridesFor,
} from './runs/lib/purchaseOverrides';
import { topUpBaseOf, topUpDraft, topUpRevision } from './runs/lib/topUp';
import { NEW_RUN, isBuying, liveRunsOf, pickActiveRun, runListGate } from './runs/lib/liveRuns';
import { overlayPendingWrites, startDeliveryBlock, withData } from './runs/lib/pendingOverlay';
import { orgToday } from '../lib/calendarDate';
import { newClientId } from '../lib/clientId';
import { useRunMutations } from './runs/hooks/useRunMutations';
import { finishSummaryOf } from './runs/lib/finishSummary';
import { rememberPaymentMethod } from './runs/lib/lastPayment';
import {
  confirmCommandFor,
  confirmCopyFor,
  directCommandFor,
  startDeliveryAsks,
  type ConfirmKind,
  type DirectStep,
} from './runs/lib/confirmCopy';
import { RunConfirmSummary } from './runs/sheets/RunConfirmSummary';
import { newAddItemDraft, planAddItemSubmit } from './runs/lib/addItem';

/** R4 (2026-11-13): the mark-unavailable sheet's common reasons. */
const UNAVAILABLE_PRESETS = [
  'run.unavailable.preset.soldOut',
  'run.unavailable.preset.tooExpensive',
  'run.unavailable.preset.poorQuality',
  'run.unavailable.preset.stallClosed',
] as const;

export function RunPage() {
  const i18n = useI18n();
  const dates = useDateFormat();
  const productName = useProductName();
  const productNameParts = useProductNameParts();
  const session = useAuthStore((s) => s.session);
  const currency = currencyOf(session);
  const photoUploader = usePhotoUploader('receipt');

  // Q7(a): `createOpen` is gone with the create sheet — starting a run
  // is the page-level button, not a modal.
  const [purchaseDraft, setPurchaseDraft] = useState<PurchaseDraft | null>(null);
  const [inlineSavingSkuId, setInlineSavingSkuId] = useState<string | null>(null);
  /** Taps of "N left" that found no row to buy on screen (RUNWEB1-14). */
  const [revealPending, setRevealPending] = useState(0);
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
  const [priceInThousands, setPriceInThousandsState] = useState<boolean>(
    () => readLocalPref('compass.run.priceInThousands') !== '0',
  );
  const togglePriceInThousands = useCallback(() => {
    setPriceInThousandsState((prev) => {
      const next = !prev;
      writeLocalPref('compass.run.priceInThousands', next ? '1' : '0');
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

  // Purchases queue offline; their replay (with the first attempt's
  // idempotency key) is app-level now (CMP-FE-3, hooks/useOutboxReplay.ts).
  const offline = useOfflineQueue();

  // ---- Mutations ------------------------------------------------------
  // runs/hooks/useRunMutations.ts (RUNWEB1-04); what each answer does to
  // this page's state is said here.
  const mutations = useRunMutations({
    runCreated: (runId) => {
      // 2026-10-21 CA-03/CA-04: land on the run just created (or the
      // buying run handed back) and forget this trip's ticks / date.
      if (runId) setSelectedRunKey(runId);
      setSessionOverrides(new Map());
      setRunDateChoice(null);
    },
    sessionsAttached: () => setAttachSheetOpen(false),
    addItemSaved: () => setAddItemDraft(null),
    // RUNWEB1-01 / -02: close only the form this purchase came from
    // (runs/lib/draftClose.ts), not another row's sheet being typed in.
    purchaseSaved: (sent) => {
      setPurchaseDraft((d) => closedFor(d, sent));
      setAddItemDraft((d) => closedFor(d, sent));
    },
    purchaseFailed: (sent) => setInlineSavingSkuId((cur) => (cur === sent.skuId ? null : cur)),
    paymentSettled: (sent) => setPaymentBusySkuId((cur) => (cur === sent.skuId ? null : cur)),
    unavailableSaved: () => {
      setUnavailableFor(null);
      setUnavailableNote('');
    },
  });
  const {
    create,
    attachSessions,
    addPurchaserItem,
    addExpense,
    ejectSession,
    purchaseItem,
    revisePurchase,
    flipPayment,
    markUnavailable,
    markExtra,
    extraForExpense,
    sendConfirm,
    sendAddItem,
  } = mutations;
  // Review RUNWEB1-31: the memos below depend on these, not on the
  // mutation results, which are new objects on every render (so the
  // memos ran every time). useMutation's `mutate` keeps its identity.
  const { mutate: createRun, isPending: creatingRun } = create;
  const startingPurchase = mutations.startPurchase.isPending;
  const startingDelivery = mutations.startDelivery.isPending;
  // R4 (2026-11-13): a reason tapped in the mark-unavailable sheet sends
  // at once. One guard for the reasons and the button: the second of two
  // quick taps is dropped before the pending lock is drawn (BUY-12).
  const guardUnavailable = useTapGuard();
  const sendUnavailable = (note: string) => {
    if (!unavailableFor || !note || markUnavailable.isPending) return;
    markUnavailable.mutate({ runId: unavailableFor.runId, skuId: unavailableFor.skuId, note });
  };
  const typedNoteSending =
    markUnavailable.isPending &&
    !UNAVAILABLE_PRESETS.some((key) => i18n.t(key) === markUnavailable.variables?.note);
  /**
   * Simplification (2026-11-13): a step another tap undoes is sent with
   * no sheet (confirmCopy.ts DirectStep). A second tap while the same
   * step is on its way is dropped; the sheet's pending lock used to hold
   * it. Through a ref, so the memos below keep one function.
   */
  const sendStepRef = useRef<(step: DirectStep) => void>(() => undefined);
  sendStepRef.current = (step) => {
    if (!activeRun) return;
    const c = directCommandFor(step, activeRun.id);
    const m = mutations[c.procedure];
    if (m.isPending && JSON.stringify(m.variables) === JSON.stringify(c.input)) return;
    sendConfirm(c, () => undefined);
  };
  const sendStep = useCallback((step: DirectStep) => sendStepRef.current(step), []);
  const purchase = purchaseItem.mutate;
  const revise = revisePurchase.mutate;

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
        names: sku.names,
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
      m.set(category.id, { id: category.id, names: category.names });
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
  const runListState = runListGate(runsQuery);
  // DX-PFE-3: remember the run on screen so the next start can ask for it
  // without waiting for run.list (app/useWarmRunQueries).
  const runHintOwner = cacheOwner(session);
  const activeRunId = activeRun?.id ?? null;
  const runListAnswered = runsQuery.isSuccess;
  useEffect(() => {
    if (runListAnswered) saveRunHint(hintStorage(), runHintOwner, activeRunId);
  }, [runListAnswered, runHintOwner, activeRunId]);
  const liveRuns = useMemo(() => liveRunsOf(runsQuery.data ?? [], canAmend), [runsQuery.data, canAmend]);
  const hasBuyingRun = liveRuns.some((r) => isBuying(r.status));
  const previewSessionCount = previewQuery.data?.sessions.length ?? 0;
  /** Offer a "new purchase" chip: nothing is being bought and orders wait. */
  const canStartNewAlongside = !hasBuyingRun && previewSessionCount > 0 && liveRuns.length > 0;
  // `amending` reuses the purchasing edit surface, so most render gates
  // treat it like purchasing; `editing` = "records are editable now".
  const amending = activeRun?.status === 'amending';
  const editing = activeRun?.status === 'purchasing' || amending;

  const realtimeLive = useRealtimeLive();
  const runDetailQueryRaw = trpc.run.get.useQuery(
    activeRun ? { runId: activeRun.id } : { runId: '' },
    // P-4 (2026-10-31): realtime `run.changed` already refreshes this; poll
    // only while the socket is down instead of every 6 s on top of it.
    {
      enabled: !!activeRun,
      refetchInterval: activeRun ? pollWhenOffline(RUN_PAGE.offlinePollMs, realtimeLive) : false,
    },
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
  // Review RUNWEB1-07: the sheets' lists, kept until their data changes.
  // The sheets' drafts live here, so each keystroke in one draws this page
  // again, and a new array or map each time made AddItemSheet filter the
  // whole catalogue again on every key.
  const pickableSkus = useMemo(
    () => (skusQuery.data ?? []).filter((s) => !s.isArchived),
    [skusQuery.data],
  );
  const purchaseSuppliers = useMemo(
    () =>
      (suppliersQuery.data ?? []).filter(
        (sup) => !sup.isArchived || sup.id === purchaseDraft?.supplierId,
      ),
    [suppliersQuery.data, purchaseDraft?.supplierId],
  );
  // M3.54 (2026-05-23): for each SKU in the run, which stores already
  // have demand. AddItemSheet uses this to (1) still SHOW in-run SKUs as
  // long as some store hasn't claimed them yet, (2) restrict the store
  // dropdown to non-conflicting stores, (3) print the "augmenting
  // existing item" hint.
  const existingStoreIdsBySku = useMemo(() => {
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
  }, [runDetailQuery.data]);

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
    }, RUN_PAGE.savingHoldMs);
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

  /**
   * Review RUNWEB1-35 (2026-11-12): delivering to a store, recalling it
   * and stepping back from delivery need delivery.dispatch (in some
   * store); without it they were offered and then refused. Stores denied
   * one by one come from the server (dispatchDeniedStoreIds).
   */
  const canDispatch = session?.permissions.includes('delivery.dispatch') ?? false;

  /** "We can still un-Start delivery" — true iff status=delivering AND
   *  no store has been delivered to. */
  const canUndoStartDelivery = useMemo(() => {
    if (activeRun?.status !== 'delivering' || !canDispatch) return false;
    return (runDetailQuery.data?.splits ?? []).every((sp) => !sp.deliveredAt);
  }, [activeRun?.status, canDispatch, runDetailQuery.data]);

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

  const canSeeMoney = useCanSeePrices();
  const finishSummary = useMemo(
    () => finishSummaryOf(runDetailQuery.data, Date.now()),
    [runDetailQuery.data],
  );

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
    /** null: no earlier price, the check is on size alone (F8). */
    last: string | null;
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
      const odd = last
        ? prices.find((p) => !!p && isUnusualPrice(p, last))
        : prices.find((p) => !!p && isUnusualFirstPrice(p));
      if (!odd) {
        run(false);
        return;
      }
      const sku = skuById.get(skuId);
      setPriceCheck({ name: sku ? productName(sku) : '', last: last ?? null, next: odd, run });
    },
    [runDetailQuery.data?.lastPriceBySku, skuById, productName],
  );

  /**
   * The purchase sheet's save: a top-up or an edit is a revision, anything
   * else a purchase; each after the price check.
   */
  const submitPurchaseDraft = useCallback(
    (d: PurchaseDraft) => {
      // DX-BUY-2: a top-up is its own batch on the row (lib/topUp.ts).
      const topUp =
        d.topUp && !d.perStorePricing
          ? topUpRevision({
              item: d.topUp.item,
              base: d.topUp.base,
              next: d.splits,
              topUpPrice: d.unitPrice,
              topUpMethod: d.paymentMethod,
            })
          : null;
      if (topUp) {
        withPriceCheck(d.skuId, [d.unitPrice], (confirmed) => {
          revise({
            runId: d.runId,
            skuId: d.skuId,
            supplierId: d.supplierId,
            receiptPhotoUrl: d.receiptPhotoUrl,
            ...topUp,
            reason: d.reason,
            ...(confirmed ? { priceConfirmed: true } : {}),
          });
        });
        return;
      }
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
            revise({ ...sent, reason: d.reason });
          } else {
            // R10: the one-tap ✓ records the method last chosen in the run.
            rememberPaymentMethod(d.runId, d.paymentMethod);
            purchase(sent);
          }
        },
      );
    },
    [purchase, revise, withPriceCheck],
  );

  // ---- MainButton -----------------------------------------------------
  // The previous implementation showed a clickable MainButton even when
  // the user couldn't actually advance — pressing it just toasted "do X
  // first". That's a noisy waste. Now: button is disabled (Telegram dims
  // it) when the precondition isn't met, and the *text* tells the user
  // what's missing.
  // CMP-BUY-1: starting delivery needs the network and an empty queue.
  // DX-BUY-6: the purchase gauge's numbers — the purchaser's own items
  // (like the item card and the "N left" bar) and the money of the run.
  const gauge = useMemo(() => {
    const run = runDetailQuery.data;
    if (!run) return null;
    const own = run.items.filter((i) => !otherStoreSkusOf(run).has(i.skuId));
    const counts = itemProgressCounts(own);
    const bought = run.items.filter((i) => i.status === 'purchased').length;
    // Amounts withheld by the server (no prices.view) read as 0: say
    // nothing rather than "spent 0".
    const moneyShown = canSeeMoney && (finishSummary.total > 0 || bought === 0);
    return {
      bought: counts.bought,
      na: counts.na,
      done: counts.bought + counts.na,
      total: own.length,
      money: moneyShown
        ? {
            total: finishSummary.total,
            cash: finishSummary.totalCash,
            transfer: finishSummary.totalTransfer,
          }
        : null,
    };
  }, [runDetailQuery.data, canSeeMoney, finishSummary]);

  const deliveryBlock = startDeliveryBlock(offline.online, offline.pendingEntries.length);
  useEffect(() => {
    // Went offline (or a write got queued) while the confirm sheet was open.
    if (deliveryBlock && confirmAction === 'startDelivery') setConfirmAction(null);
  }, [deliveryBlock, confirmAction]);

  // 2026-11-14 (owner): the main button is a circle on the nav's row, its
  // text the accessible name: `icon` draws the step, `badge` a count it
  // carries, and `hint` says in words, over the row, why it waits (the
  // text did that on the old pill).
  const mainButton = useMemo<{
    text: string;
    onClick: () => void;
    visible: boolean;
    active: boolean;
    icon: PageMainButtonIcon;
    badge?: number;
    hint?: string;
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
        const why = offline
          ? i18n.t('run.offline.needNetworkToStart')
          : sessionIds.length === 0
            ? i18n.t('run.select.noneSelected')
            : !dateOk
              ? // BUY-19: the button only greyed out; say why.
                i18n.t('run.errors.runDateInFuture')
              : undefined;
        return {
          text: why ?? i18n.t('run.action.startPurchase'),
          icon: 'cart',
          hint: why,
          onClick: () => {
            if (offline || sessionIds.length === 0 || !dateOk || creatingRun) return;
            createRun({
              sessionIds,
              startImmediately: true,
              ...(runDate ? { date: runDate } : {}),
            });
          },
          visible: true,
          active: !offline && sessionIds.length > 0 && dateOk && !creatingRun,
        };
      }
      return { text: '', onClick: () => {}, visible: false, active: false, icon: 'check' };
    }
    switch (activeRun.status) {
      case 'planned':
        return {
          text: i18n.t('run.action.startPurchase'),
          icon: 'cart',
          // 2026-11-13: no confirm, as the first start; Back to plan undoes it.
          onClick: () => sendStep('startPurchase'),
          visible: true,
          active: !startingPurchase,
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
              icon: 'truck',
              hint: i18n.t('run.action.waitingOtherStores'),
              onClick: () => {},
              visible: true,
              active: false,
            };
          }
          return {
            text: i18n.t('run.action.remainingItems', { n: pendingCount }),
            icon: 'cart',
            badge: pendingCount,
            onClick: () => {
              const next = document.querySelector('[data-run-item-pending]');
              if (next) next.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
              // RUNWEB1-14: none on screen (the by-store view, or a search
              // or filter hiding them): the panel shows the list again.
              else setRevealPending((n) => n + 1);
            },
            visible: true,
            active: true,
          };
        }
        // CMP-BUY-1 (2026-10-31): items bought offline count as handled
        // (they show on their rows), but the server has not seen them
        // yet. Starting delivery then only failed on the network — or,
        // once online with the queue still sending, started a delivery the
        // server thought was not fully bought. Say what it waits for.
        if (deliveryBlock) {
          const why =
            deliveryBlock === 'offline'
              ? i18n.t('run.offline.needNetworkToDeliver')
              : i18n.t('run.offline.waitForSync', { n: offline.pendingEntries.length });
          return {
            text: why,
            icon: 'truck',
            hint: why,
            onClick: () => {},
            visible: true,
            active: false,
          };
        }
        return {
          text: i18n.t('run.action.startDelivery'),
          icon: 'truck',
          // 2026-11-13: sent at once (Back to purchase undoes it); the
          // sheet opens only to warn about other items not handled.
          onClick: () =>
            startDeliveryAsks({ sessionExtrasByStore: runDetailQuery.data?.sessionExtrasByStore })
              ? setConfirmAction('startDelivery')
              : sendStep('startDelivery'),
          visible: true,
          active: !startingDelivery,
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
              icon: 'truck',
              badge: waiting.undelivered.length,
              onClick: () => {
                const stores = document.querySelector('[data-run-stores]');
                stores?.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
              },
              visible: true,
              active: true,
            };
          }
          const why = i18n.t('run.action.waitingStoreConfirm', {
            stores: waiting.unconfirmed
              .map((id) => storeById.get(id)?.name ?? i18n.t('common.unknownStore'))
              .join(i18n.t('common.listSeparator')),
          });
          return {
            text: why,
            icon: 'check',
            hint: why,
            onClick: () => {},
            visible: true,
            active: false,
          };
        }
        // RE-DLV-3: someone the server would refuse is told so here.
        const blocked = runDetailQuery.data?.finishBlockedReason;
        if (blocked) {
          const why = i18n.t(
            blocked === 'run.errors.runHasOtherStores'
              ? 'run.action.finishBlocked.otherStores'
              : 'run.action.finishBlocked.noPermission',
          );
          return {
            text: why,
            icon: 'check',
            hint: why,
            onClick: () => {},
            visible: true,
            active: false,
          };
        }
        return {
          text: i18n.t('run.action.finish'),
          icon: 'check',
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
            icon: 'check',
            hint: i18n.t('run.errors.cannotAmend'),
            onClick: () => {},
            visible: true,
            active: false,
          };
        }
        return {
          text: i18n.t('run.action.refinalize'),
          icon: 'check',
          onClick: () => setConfirmAction('refinalize'),
          visible: true,
          active: true,
        };
      default:
        return { text: '', onClick: () => {}, visible: false, active: false, icon: 'check' };
    }
  }, [
    activeRun,
    allItemsHandled,
    allStoresConfirmed,
    deliveryBlock,
    offline.pendingEntries.length,
    pendingCount,
    runDetailQuery.data?.otherStoreSkuIds,
    runDetailQuery.data?.splits,
    runDetailQuery.data?.finishBlockedReason,
    runDetailQuery.data?.sessionExtrasByStore,
    storeById,
    i18n,
    previewSessionCount,
    chosenSessionIds,
    runDateChoice,
    previewToday,
    createRun,
    creatingRun,
    sendStep,
    startingPurchase,
    startingDelivery,
  ]);

  // ---- Confirm-sheet wiring --------------------------------------------
  // Resets the reason input whenever the confirm switches kind (or
  // closes). Avoids stale text leaking from one decision into the next.
  useEffect(() => {
    setConfirmReason('');
  }, [confirmAction]);

  /** What the open confirmation says (runs/lib/confirmCopy.ts); null when none is open. */
  const confirmCopy = useMemo(
    () =>
      confirmAction && activeRun
        ? confirmCopyFor(confirmAction, {
            i18n,
            run: runDetailQuery.data,
            summary: finishSummary,
            currency,
            storeName: (id) => storeById.get(id)?.name ?? i18n.t('common.unknownStore'),
            // NEW-03: the main name in the confirmations, as the rows give it.
            skuName: (skuId) =>
              rowName(productNameParts, skuById.get(skuId), i18n.t('common.unknownProduct'))
                .primary,
          })
        : null,
    [
      confirmAction,
      activeRun,
      runDetailQuery.data,
      finishSummary,
      currency,
      i18n,
      productNameParts,
      skuById,
      storeById,
    ],
  );
  /** And the command its Confirm sends, with the reason typed. */
  const confirmCommand =
    confirmAction && activeRun
      ? confirmCommandFor(confirmAction, activeRun.id, confirmReason)
      : null;
  const confirmPending = confirmCommand ? mutations[confirmCommand.procedure].isPending : false;

  // The page's own action. An open sheet covers the button (M3.49: it is
  // part of the page, under the sheet's scrim) and carries its own submit,
  // so nothing here changes while one is open (review RUNWEB1-05).
  usePageMainButton(mainButton.text, mainButton.onClick, {
    visible: mainButton.visible,
    active: mainButton.active,
    icon: mainButton.icon,
    badge: mainButton.badge,
    inactiveHint: mainButton.hint,
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
          title: i18n.t('run.titleWithIndex', { n: activeRun.runIndex + 1 }),
          actions: [
            ...(canUndoStartPurchase
              ? [
                  {
                    label: i18n.t('run.action.undoStartPurchase'),
                    // 2026-11-13: no confirm or reason; Start purchase undoes it.
                    onClick: () => sendStep('undoStartPurchase'),
                  },
                ]
              : []),
            ...(canUndoStartDelivery
              ? [
                  {
                    label: i18n.t('run.action.undoStartDelivery'),
                    // 2026-11-13: no confirm or reason; Start delivery undoes it.
                    onClick: () => sendStep('undoStartDelivery'),
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
   * RUNWEB1-33 (2026-11-11): both are days of the org's calendar. Today is
   * the server's (`previewToday`), or the org's from the session until it
   * answers; it was the phone's, a day off around midnight on a phone set
   * to another zone.
   */
  const runAgeDays = activeRun
    ? daysOld(activeRun.runDate, previewToday ?? orgToday(session.member.timezone))
    : 0;

  // 2026-07-30: drop the year for runs in the current year. The bar has to
  // fit `+ 新增`, this line and the staleness badge inside ~223 px once
  // Telegram's chrome pads are subtracted; the year is the least
  // informative part, and the badge now carries "how old" anyway.
  // D16 (2026-10-31): in the UI language ("10月31日" / "31 окт."), not the
  // stored "10-31".
  const runDateShort = dates.calendarDay(activeRun?.runDate);

  // RE-COPY-1: "#1 · 10月31日 · 采购" — the number sign (ru «№») and the
  // order come from the catalog, like the switcher chips below.
  const runSubtitle = activeRun
    ? i18n.t('run.switcher.option', {
        n: activeRun.runIndex + 1,
        date: runDateShort,
        step: runStepLabel(i18n, activeRun.status),
      })
    : i18n.t('run.empty.noActive');

  return (
    /* M1.12: outer page is just `flex flex-col` + bottom safe-area.
        PageHeader removed entirely — Telegram's chrome (bot name +
        BottomNav) is the app frame, and per-page actions ("Undo
        start purchase", "Cancel run") now live in the gear ⚙️ on the
        right side of Telegram's chrome (registered via usePageMenu
        below). What remains in-body is a one-line strip, while a run
        is active, naming it ("#3 · purchasing"), so the user sees the
        run state without losing 60+ px to a redundant header bar. (It
        named the store too until M3.5; RUNWEB1-30.) */
    <div className="flex flex-col pb-24">
      {/* M3.5: store-switcher pill moved to SettingsSheet. Sticky strip
         now only renders when there's an active run to label.

         2026-07-30: dropped the `--app-chrome-pad-*` inline padding this
         bar copied from StickyPageBar. Telegram's Close / ⋯ overlay the
         reserved strip Shell renders above the scroll container; this bar
         is below that strip and was never underneath them. See the
         StickyPageBar docblock. */}
      {/* min-h-12 py-1 (R2-VIS-2, 2026-10-31): the bar is taller than the
          "+ Add" button's 44px tap area plus its 1px bottom border. At
          min-h-9 py-2 the area stuck out of the bar's top edge, under the
          sticky header (measured 39px; 43 at min-h-11). */}
      {/* DX-BUY-6: one sticky block — the run line and the gauge under it. */}
      <div className="sticky top-0 z-[1] [@media(max-height:500px)]:static">
      {activeRun ? (
        <div className="flex min-h-12 items-center gap-2 border-b border-[var(--c-divider)] bg-[var(--c-bg)] px-4 py-1">
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
          {/* M3.41 (2026-05-21): "+ add item" — only shown while the run
              is being bought (the claim gate went with the claim UI,
              UIUX-B1). The domain layer enforces the same constraints;
              gating the UI hides the affordance to avoid a confusing
              tap-then-fail. The button opens AddItemSheet which collects
              SKU + qty + price + store split + reason. */}
          {/* RUNWEB1-27: the kit's small button (was a hand-made pill). */}
          {editing ? (
            <Button
              size="sm"
              className="shrink-0"
              onClick={() =>
                setAddItemDraft(
                  // R8 (2026-11-13): a reason the server takes, ready to save.
                  newAddItemDraft(activeRun.id, {
                    reason: i18n.t('run.action.addItem.defaultReason'),
                  }),
                )
              }
              title={i18n.t('run.action.addItem.title')}
            >
              {i18n.t('run.action.addItem.button')}
            </Button>
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
            {runSubtitle}
          </span>
          {runAgeDays > 0 ? (
            <span className="shrink-0 whitespace-nowrap rounded-[var(--r-pill)] bg-[var(--c-warn-bg)] px-1.5 py-0.5 text-old-label text-[var(--c-warning-fg)]">
              {i18n.t('run.label.staleRun', { days: runAgeDays })}
            </span>
          ) : null}
        </div>
      ) : null}
      {/* DX-BUY-6 (2026-11-01): the purchase gauge, under the run line and
          sticky with it — how far along (bought x / y) and how much money
          has gone out, cash and transfer apart. The page had counts only;
          purchasers counting cash at a stall did the sum in their head. */}
      {activeRun && editing && gauge ? (
        <div
          data-testid="run-gauge"
          className="flex flex-col gap-1 border-b border-[var(--c-divider)] bg-[var(--c-bg)] px-4 pb-1.5 pt-1"
        >
          <div className="flex flex-wrap items-baseline gap-x-2 text-old-label tabular-nums">
            <span className="font-semibold text-[var(--c-fg)]">
              {i18n.t('run.gauge.bought', { done: gauge.bought, total: gauge.total })}
            </span>
            {gauge.na > 0 ? (
              <span className="text-[var(--c-fg-muted)]">
                · {i18n.t('run.gauge.notFound', { n: gauge.na })}
              </span>
            ) : null}
            {gauge.money ? (
              <>
                <span className="font-semibold text-[var(--c-fg)]">
                  · {i18n.t('run.gauge.spent', { total: formatMoney(gauge.money.total) })}
                </span>
                {/* UI-3 (RUNWEB1-27): all cash, the default, needs no
                    "transfer 0"; the finish sheet splits only then too. */}
                {gauge.money.transfer > 0 ? (
                  <span className="text-[var(--c-fg-muted)]">
                    {i18n.t('run.gauge.split', {
                      cash: formatMoney(gauge.money.cash),
                      transfer: formatMoney(gauge.money.transfer),
                    })}
                  </span>
                ) : null}
              </>
            ) : null}
          </div>
          <div
            role="progressbar"
            aria-label={i18n.t('run.gauge.progressLabel')}
            aria-valuemin={0}
            aria-valuemax={gauge.total}
            aria-valuenow={gauge.done}
            className="h-[3px] overflow-hidden rounded-full bg-[var(--c-surface-2)]"
          >
            <div
              className="h-full bg-[var(--c-action)]"
              style={{ width: `${gauge.total > 0 ? (gauge.done / gauge.total) * 100 : 0}%` }}
            />
          </div>
        </div>
      ) : null}
      </div>

      {/* BUY-8 (2026-10-30): purchases saved offline used to look unsaved. */}
      <PendingSyncNotice count={pendingChangeCount(offline.pendingEntries)} />

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
              {/* RE-COPY-1 (2026-10-31): number sign and date order come
                  from the catalog (ru «№»), the date in the UI language. */}
              {i18n.t('run.switcher.option', {
                n: r.runIndex + 1,
                date: dates.calendarDay(r.runDate),
                step: runStepLabel(i18n, r.status),
              })}
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
        />
      </Sheet>

      <div className="flex flex-col gap-2 px-4 pt-2">
        {runListState === 'error' ? (
          // F11 (2026-10-30): a failed run list read as "no approved
          // orders to plan" — the buyer was told there was nothing to buy.
          <QueryErrorBanner query={runsQuery} />
        ) : runListState === 'offline' ? (
          // R2-ENG-1 (2026-10-31): offline with no saved run list, not
          // "nothing to plan"; it loads by itself once back online.
          <EmptyState title={i18n.t('common.offlineNoData')} />
        ) : runListState === 'loading' ? (
          // P-2 (2026-10-31): not "nothing to plan" while it loads.
          // UI-15 (RUNWEB1-27): the kit's spinner, as every other load.
          <LoadingState />
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
                    runDate={runDateChoice ?? p.today ?? ''}
                    onRunDateChange={(d) => setRunDateChoice(d || null)}
                    // The main button says "tick at least one order".
                    noneSelectedHint={false}
                  />
                  {selectedPreview && selectedPreview.plannedItems.length > 0 ? (
                    <PreviewSummaryCard
                      preview={selectedPreview}
                      skuById={skuById}
                      productName={productName}
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
            ejectingSessionId={ejectSession.isPending ? ejectSession.variables.sessionId : null}
            onEject={(sessionRow) => {
              const storeName =
                storeById.get(sessionRow.storeId)?.name ?? i18n.t('common.unknownStore');
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
              sessions: runDetailQuery.data.sessionIdsJson.map((id) => ({ id, storeId: '' })),
              plannedItems: runDetailQuery.data.items.map((it) => ({
                skuId: it.skuId,
                qty: it.plannedQty,
              })),
              perStoreDemand: (runDetailQuery.data.perStoreDemand ?? []).map((d) => ({
                storeId: d.storeId,
                storeName: storeById.get(d.storeId)?.name ?? i18n.t('common.unknownStore'),
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
          />
        ) : null}

        {activeRun && runDetailQuery.data && activeRun.status !== 'planned' ? (
          <ActiveRunPanel
            run={runDetailQuery.data}
            skuById={skuById}
            categoryById={categoryById}
            storeById={storeById}
            productName={productName}
            priceInThousands={priceInThousands}
            onTogglePriceUnit={togglePriceInThousands}
            savingSkuId={inlineSavingSkuId}
            revealPending={revealPending}
            canDispatch={canDispatch}
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
              // saving for the relatively rare transfer items), or for
              // the one-tap ✓ the method last chosen in the run (R10).
              withPriceCheck(skuId, [unitPrice], (confirmed) => {
              // R10 (2026-11-13): the next one-tap ✓ records this method.
              rememberPaymentMethod(activeRun.id, paymentMethod);
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
              // runs/lib/purchaseOverrides.ts: only the method changes, through
              // revisePurchase; a row paid per store opens the sheet instead.
              const revision = paymentFlipRevision({
                runId: activeRun.id,
                item,
                splits: runDetailQuery.data?.splits ?? [],
                next,
                reason: i18n.t('run.reason.paymentMethodChanged'),
              });
              if (!revision) {
                openPurchaseEdit(item);
                return;
              }
              setPaymentBusySkuId(item.skuId);
              rememberPaymentMethod(activeRun.id, next);
              flipPayment.mutate(revision);
            }}
            onUnmark={
              activeRun.status === 'delivering'
                ? undefined
                : // 2026-11-13: at once, no reason; N/A undoes it.
                  (skuId) => sendStep({ kind: 'unmarkUnavailable', skuId })
            }
            onTopUpBuy={(item) => {
              // An unavailable item comes back as pending (with the whole
              // demand) through the existing restore flow.
              if (item.status === 'unavailable') {
                sendStep({ kind: 'unmarkUnavailable', skuId: item.skuId });
                return;
              }
              openPurchaseEdit(item);
              // DX-BUY-2 (runs/lib/topUp.ts): the extra is its own batch on the
              // row, priced on its own, and goes to the stores still short.
              const topUp = {
                demand: (runDetailQuery.data?.perStoreDemand ?? []).filter(
                  (d) => d.skuId === item.skuId,
                ),
                extra: item.topUpQty,
                base: topUpBaseOf(item, runDetailQuery.data?.splits ?? []),
                reason: i18n.t('run.topUp.reason'),
              };
              setPurchaseDraft((d) => (d ? topUpDraft(d, topUp) : d));
            }}
            onTopUpDismiss={(item) =>
              // RUNWEB1-29: the run's confirm sheet, as every other step.
              setConfirmAction({
                kind: 'dismissTopUp',
                skuId: item.skuId,
                qty: item.topUpQty ?? '0',
              })
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
            // 2026-11-13: at once; Recall undoes it until the store confirms.
            onDeliverStore={(storeId) => sendStep({ kind: 'deliverStore', storeId })}
            onRecallStore={(storeId, storeName) =>
              setConfirmAction({ kind: 'recallDelivery', storeId, storeName })
            }
            onMarkExtraStatus={(sessionId, extraIndex, status, expectedSeq) =>
              markExtra(activeRun.id, { sessionId, extraIndex, status, expectedSeq })
            }
            onRecordExtraExpense={(storeId, extra) => {
              const expenseId = newClientId();
              extraForExpense.current =
                typeof extra.sessionId === 'string' &&
                typeof extra.idx === 'number' &&
                extra.status !== 'bought'
                  ? { expenseId, sessionId: extra.sessionId, idx: extra.idx, seq: extra.sessionSeq }
                  : null;
              setAddItemDraft(
                newAddItemDraft(activeRun.id, {
                  mode: 'expense',
                  expenseId,
                  label: extra.name,
                  unitHint: extra.unit,
                  expenseScope: 'store',
                  actualQty: extra.qty || '1',
                  splits: new Map([[storeId, extra.qty || '1']]),
                  reason: i18n.t('run.extras.recordExpenseReason'),
                }),
              );
            }}
            onRemoveExpense={(expenseId, label) =>
              setConfirmAction({ kind: 'removeExpense', expenseId, label })
            }
            onOpenExpense={() =>
              setAddItemDraft(
                newAddItemDraft(activeRun.id, {
                  mode: 'expense',
                  actualQty: '1',
                  reason: i18n.t('run.action.addItem.defaultReason'),
                }),
              )
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
        suppliers={purchaseSuppliers}
        productName={productName}
        photoUploader={photoUploader}
        priceInThousands={priceInThousands}
        onTogglePriceUnit={togglePriceInThousands}
        onCancel={() => setPurchaseDraft(null)}
        // Undo moved off the purchased row (where it sat one row-pitch
        // from a money-committing ✓) into this sheet. Same ConfirmSheet
        // as before.
        onUndo={
          purchaseDraft?.isEdit && activeRun?.status !== 'delivering'
            ? () => {
                const d = purchaseDraft;
                const sku = skuById.get(d.skuId);
                setPurchaseDraft(null);
                setConfirmAction({
                  kind: 'undoPurchase',
                  skuId: d.skuId,
                  skuName: sku ? productName(sku) : i18n.t('common.unknownProduct'),
                  added: !!runDetailQuery.data?.items.find((it) => it.skuId === d.skuId)
                    ?.addedByPurchaser,
                });
              }
            : undefined
        }
        onChange={setPurchaseDraft}
        onSubmit={submitPurchaseDraft}
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
        runStoreIds={addableStoreIds}
        existingStoreIdsBySku={existingStoreIdsBySku}
        skus={pickableSkus}
        expenseTemplates={expenseTemplatesQuery.data ?? []}
        storeById={storeById}
        productName={productName}
        photoUploader={photoUploader}
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
          // R10: a product bought here sets the one-tap ✓'s method too.
          if (d.mode === 'sku') rememberPaymentMethod(d.runId, d.paymentMethod);
          // runs/lib/addItem.ts picks the command: a new row, a store joining
          // a row already on the run, a separate cost, or an expense.
          const command = planAddItemSubmit(d, {
            run: runDetailQuery.data,
            product: (skuId) => {
              const sku = skusQuery.data?.find((s) => s.id === skuId);
              return sku ? { name: productName(sku), unit: sku.unit } : null;
            },
            priceConfirmed,
            crossStoreReason: i18n.t('run.action.addItem.defaultCrossStoreReason'),
          });
          if (command) sendAddItem(command);
        }}
        submitting={
          addPurchaserItem.isPending ||
          addExpense.isPending ||
          purchaseItem.isPending ||
          revisePurchase.isPending
        }
      />
      <ConfirmSheet
        open={!!priceCheck}
        title={i18n.t('run.price.check.title')}
        body={
          !priceCheck
            ? ''
            : priceCheck.last
              ? i18n.t('run.price.check.body', {
                  name: priceCheck.name,
                  last: formatMoney(priceCheck.last),
                  next: formatMoney(priceCheck.next),
                  currency,
                })
              : i18n.t('run.price.check.bodyFirst', {
                  name: priceCheck.name,
                  next: formatMoney(priceCheck.next),
                  currency,
                })
        }
        confirmLabel={i18n.t('run.price.check.confirm')}
        cancelLabel={i18n.t('run.price.check.fix')}
        showCancelInSheet
        // DX-IX-7 (2026-11-01): Enter in the price field opens this; focus
        // starts on 改价格 so a second Enter does not save the outlier.
        focusCancel
        onConfirm={() => {
          const go = priceCheck?.run;
          setPriceCheck(null);
          go?.(true);
        }}
        onCancel={() => setPriceCheck(null)}
      />

      {/* Mark-unavailable sheet. */}
      <Sheet
        open={!!unavailableFor}
        onOpenChange={(open) => !open && setUnavailableFor(null)}
        title={i18n.t('run.action.markUnavailable')}
        description={i18n.t('run.action.markUnavailableDesc')}
        footer={
          // M3.49: the sheet carries its own submit (Shell's PageMainButton).
          <Button
            block
            variant="danger"
            disabled={!unavailableNote.trim() || (markUnavailable.isPending && !typedNoteSending)}
            // UX-05: N/A waits for a reason (not while a preset is sending).
            disabledHint={
              unavailableNote.trim() || markUnavailable.isPending
                ? ''
                : i18n.t('run.unavailable.reasonNeeded')
            }
            loading={typedNoteSending}
            onClick={guardUnavailable(() => sendUnavailable(unavailableNote.trim()), 'unavailable')}
          >
            {i18n.t('run.action.markNa')}
          </Button>
        }
      >
        <div className="flex flex-col gap-3 py-3">
          {/* R4 (2026-11-13): a common reason marks the item at once (open
              row → N/A → reason); the hint says so. Typing a reason and
              the button below still work. Kit buttons, not chips: a chip
              reads as a choice to confirm. */}
          <FieldGroup label={i18n.t('run.unavailable.presetsHint')}>
            <div className="flex flex-wrap gap-x-1.5 gap-y-3">
              {UNAVAILABLE_PRESETS.map((key) => {
                const text = i18n.t(key);
                const sending =
                  markUnavailable.isPending && markUnavailable.variables?.note === text;
                return (
                  <Button
                    key={key}
                    size="sm"
                    variant="secondary"
                    disabled={markUnavailable.isPending && !sending}
                    loading={sending}
                    onClick={guardUnavailable(() => sendUnavailable(text), 'unavailable')}
                  >
                    {text}
                  </Button>
                );
              })}
            </div>
          </FieldGroup>
          <Input
            value={unavailableNote}
            onChange={(e) => setUnavailableNote(e.target.value)}
            placeholder={i18n.t('run.action.unavailableReasonPlaceholder')}
            // RUNWEB1-28: a name that stays once something is typed.
            aria-label={i18n.t('run.action.unavailableReasonPlaceholder')}
          />
        </div>
      </Sheet>

      {/* Generic confirm sheet for ALL the major transitions. Centralized
          so every "I changed my mind" path looks identical. */}
      <ConfirmSheet
        open={!!confirmCopy}
        title={confirmCopy?.title ?? ''}
        // RUNWEB1-08: the finish and correction figures, as rows above the text.
        banner={
          confirmCopy?.summary ? <RunConfirmSummary summary={confirmCopy.summary} /> : undefined
        }
        body={confirmCopy?.body}
        confirmLabel={confirmCopy?.confirmLabel ?? ''}
        danger={confirmCopy?.danger}
        irreversible={confirmCopy?.irreversible}
        requireReason={confirmCopy?.requireReason}
        reasonOptional={confirmCopy?.reasonOptional}
        reasonLabel={i18n.t('run.label.reasonForChange')}
        reasonPlaceholder={confirmCopy?.reasonPlaceholder ?? i18n.t('run.label.reasonPlaceholder')}
        pending={confirmPending}
        reason={confirmReason}
        onReasonChange={setConfirmReason}
        onConfirm={() => {
          if (confirmCommand) sendConfirm(confirmCommand, () => setConfirmAction(null));
        }}
        onCancel={() => setConfirmAction(null)}
      />

      {/* Item & store action sheets removed (2026-05-03):
          User feedback was that for 100s of SKUs, opening a menu sheet
          for each tap is unbearable. Replaced with direct in-page editing:
          - Pending item rows: inline qty + price inputs + "N/A" link
          - Purchased item rows: tap-to-edit (opens PurchaseSheet for full
            form because edit requires reason field)
          - Unavailable item rows: "Restore" link (sent at once since 2026-11-13)
          - Pending store rows: deliver button (sent at once since 2026-11-13)
          - Delivered store rows: recall button → recall-confirm sheet
          - Confirmed store rows: read-only, not tappable. */}
    </div>
  );
}
