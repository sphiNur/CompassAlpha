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
  Sheet,
  useToast,
} from '@compass/ui';
import { trpc } from '../lib/trpc';
import { useAuthStore } from '../stores/authStore';
import { usePageMainButton, haptic, getTg } from '../hooks/useTelegram';
import { useI18n, useProductName } from '../hooks/useI18n';
import { usePhotoUploader } from '../hooks/usePhotoUploader';
import { StoreSwitcher } from '../components/StoreSwitcher';
import { useOfflineQueue } from '../hooks/useOfflineQueue';
import { isLikelyNetworkError } from '../lib/networkError';
import { useErrToast } from '../lib/errToast';
import { formatQty, formatMoney } from '../lib/format';

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
  const session = useAuthStore((s) => s.session);
  const toast = useToast();
  const photoUploader = usePhotoUploader('receipt');

  const [createOpen, setCreateOpen] = useState(false);
  const [purchaseDraft, setPurchaseDraft] = useState<PurchaseDraft | null>(null);
  const [unavailableFor, setUnavailableFor] = useState<{ runId: string; skuId: string } | null>(
    null,
  );
  const [unavailableNote, setUnavailableNote] = useState('');
  const [confirmAction, setConfirmAction] = useState<ConfirmKind | null>(null);
  const [confirmReason, setConfirmReason] = useState('');
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
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
    onSuccess: () => {
      void utils.run.list.invalidate();
      void utils.run.get.invalidate();
      haptic('success');
      toast.success(i18n.t('run.toast.runCancelled'));
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

  /** "We can still un-Start purchase" — true iff status=purchasing AND
   *  every item is still pending. Mirrors the domain guard. */
  const canUndoStartPurchase = useMemo(() => {
    if (activeRun?.status !== 'purchasing') return false;
    return (runDetailQuery.data?.items ?? []).every((i) => i.status === 'pending');
  }, [activeRun?.status, runDetailQuery.data]);

  /** "We can still un-Start delivery" — true iff status=delivering AND
   *  no store has been delivered to. */
  const canUndoStartDelivery = useMemo(() => {
    if (activeRun?.status !== 'delivering') return false;
    return (runDetailQuery.data?.splits ?? []).every((sp) => !sp.deliveredAt);
  }, [activeRun?.status, runDetailQuery.data]);

  const finishSummary = useMemo(() => {
    const items = runDetailQuery.data?.items ?? [];
    const splits = runDetailQuery.data?.splits ?? [];
    const skus = items.filter((i) => i.status === 'purchased').length;
    const stores = new Set(splits.map((sp) => sp.storeId)).size;
    let total = 0;
    for (const it of items) {
      if (it.status === 'purchased' && it.unitPrice && it.purchasedQty) {
        total += Number(it.unitPrice) * Number(it.purchasedQty);
      }
    }
    return { skus, stores, total };
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
    if (!activeRun) return { text: '', onClick: () => {}, visible: false, active: false };
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
  }, [activeRun, allItemsHandled, allStoresConfirmed, i18n]);

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
          create.mutate({ sessionIds });
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

  /** Sheets that DON'T have a single primary action (header menu,
   *  drill-down history). MainButton hides while these are open. */
  const multiOptionSheetOpen = headerMenuOpen || !!historyDetailFor;

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
        case 'finish':
          return {
            title: i18n.t('run.confirm.finish.title'),
            body:
              i18n.t('run.confirm.finish.body') +
              '\n\n' +
              i18n.t('run.confirm.finish.summary', {
                items: finishSummary.skus,
                stores: finishSummary.stores,
                total: finishSummary.total.toFixed(0),
              }),
            confirmLabel: i18n.t('run.action.finish'),
            danger: false,
            requireReason: false,
            isPending: finish.isPending,
            run: () => finish.mutate({ runId }, { onSuccess: () => setConfirmAction(null) }),
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

  if (!session) return null;

  return (
    <div className="flex flex-col gap-2 px-4 py-2 pb-24">
      <header className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-h1 font-semibold leading-[1.15] tracking-tight text-[var(--c-fg)]">
            {activeRun
              ? i18n.t('run.header.runIndex', { n: activeRun.runIndex + 1 })
              : i18n.t('run.title')}
          </h1>
          <p className="mt-0.5 text-label text-[var(--c-fg-muted)]">
            {activeRun
              ? // Phase folded into the subtitle. Replaces the 60-px
                // tappable-less Stepper with a single line: date · phase.
                `${activeRun.runDate} · ${
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
              : i18n.t('run.empty.noActive')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Store-context picker — RunPage doesn't NEED a specific
              store (purchaser aggregates across stores), but admins
              flipping context need the same control here as elsewhere
              for consistency. Self-hides for single-store staff. */}
          <StoreSwitcher />
          {!activeRun ? (
            <Button
              onClick={() => setCreateOpen(true)}
              disabled={!previewQuery.data?.plannedItems.length}
            >
              {i18n.t('run.header.newRun')}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="pearl"
              aria-label="More actions"
              onClick={() => setHeaderMenuOpen(true)}
            >
              ⋯
            </Button>
          )}
        </div>
      </header>

      {/* Stepper removed 2026-05-04: it was 60px tall and non-tappable
          — pure information that's already implied by the body content
          (items list = purchasing, store list = delivering). The phase
          name now lives inline in the page header subtitle. */}

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

      {activeRun && runDetailQuery.data ? (
        <ActiveRunPanel
          run={runDetailQuery.data}
          skuById={skuById}
          storeById={storeById}
          productName={productName}
          i18n={i18n}
          onSavePurchaseInline={({ skuId, actualQty, unitPrice, storeSplits }) => {
            // Direct in-page save — no sheet involved. Triggered when
            // the user blurs the price input on a row whose qty
            // matches planned. Splits come from per-store demand.
            purchaseItem.mutate({
              runId: activeRun.id,
              skuId,
              supplierId: null,
              unitPrice,
              actualQty,
              receiptPhotoUrl: null,
              storeSplits,
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
            });
          }}
          onDeliverStore={(storeId, storeName) =>
            setConfirmAction({ kind: 'deliverStore', storeId, storeName })
          }
          onRecallStore={(storeId, storeName) =>
            setConfirmAction({ kind: 'recallDelivery', storeId, storeName })
          }
        />
      ) : null}

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
                create.mutate({ sessionIds });
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

      {/* Header ⋯ menu — "danger zone" actions for the entire run. */}
      <Sheet
        open={headerMenuOpen}
        onOpenChange={setHeaderMenuOpen}
        title={i18n.t('run.title')}
        description={activeRun ? `#${activeRun.runIndex + 1} · ${activeRun.runDate}` : undefined}
      >
        <div className="flex flex-col gap-2 py-3">
          {canUndoStartPurchase ? (
            <Button
              block
              variant="pearl"
              onClick={() => {
                setHeaderMenuOpen(false);
                setConfirmAction('undoStartPurchase');
              }}
            >
              {i18n.t('run.action.undoStartPurchase')}
            </Button>
          ) : null}
          {canUndoStartDelivery ? (
            <Button
              block
              variant="pearl"
              onClick={() => {
                setHeaderMenuOpen(false);
                setConfirmAction('undoStartDelivery');
              }}
            >
              {i18n.t('run.action.undoStartDelivery')}
            </Button>
          ) : null}
          <Button
            block
            variant="danger"
            onClick={() => {
              setHeaderMenuOpen(false);
              setConfirmAction('cancel');
            }}
          >
            {i18n.t('run.action.cancelRun')}
          </Button>
        </div>
      </Sheet>

      <PurchaseSheet
        draft={purchaseDraft}
        skuById={skuById}
        storeById={storeById}
        suppliers={suppliersQuery.data ?? []}
        productName={productName}
        photoUploader={photoUploader}
        i18n={i18n}
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
          };
          if (d.isEdit) {
            revisePurchase.mutate({ ...payload, reason: d.reason });
          } else {
            purchaseItem.mutate(payload);
          }
        }}
        submitting={purchaseItem.isPending || revisePurchase.isPending}
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

      {/* History section — finished + cancelled runs, newest first. Tap a
          row to drill into the full breakdown (items, prices, store splits,
          totals). Lives at the bottom of the page so it doesn't compete
          with the active flow at the top. */}
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
  /** M1.8: per-store concatenated session notes ("其他物品"). */
  sessionNotesByStore?: Record<string, string>;
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
  onSavePurchaseInline,
  onMarkNa,
  onEditPurchased,
  onUnmark,
  onUndoPurchase,
  onOpenAdvancedPurchase,
  onDeliverStore,
  onRecallStore,
}: {
  run: ActiveRun;
  skuById: Map<
    string,
    { id: string; names: Record<string, string>; unit: string; step: string }
  >;
  storeById: Map<string, { id: string; name: string; code: string | null }>;
  productName: (item: { names: Record<string, string> | null | undefined }) => string;
  i18n: ReturnType<typeof useI18n>;
  onSavePurchaseInline: (payload: {
    skuId: string;
    actualQty: string;
    unitPrice: string;
    storeSplits: Array<{ storeId: string; qty: string }>;
  }) => void;
  onMarkNa: (skuId: string) => void;
  onEditPurchased: (item: ActiveRun['items'][number]) => void;
  onUnmark: (skuId: string, skuName: string) => void;
  onUndoPurchase: (skuId: string, skuName: string) => void;
  onOpenAdvancedPurchase: (item: ActiveRun['items'][number]) => void;
  onDeliverStore: (storeId: string, storeName: string) => void;
  onRecallStore: (storeId: string, storeName: string) => void;
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
  const [viewMode, setViewMode] = useState<'aggregate' | 'perStore'>(() => {
    try {
      const saved = localStorage.getItem('compass.run.viewMode');
      return saved === 'perStore' ? 'perStore' : 'aggregate';
    } catch {
      return 'aggregate';
    }
  });
  const setViewModePersist = (mode: 'aggregate' | 'perStore') => {
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
  const showViewToggle =
    (run.status === 'planned' || run.status === 'purchasing') &&
    demandStoreIds.length >= 2;

  return (
    <div className="flex flex-col gap-2">
      {/* View-mode toggle — only shown when the run actually spans
          multiple stores. Single-store runs short-circuit to aggregate. */}
      {showViewToggle ? (
        <div className="border-b border-[var(--c-divider)] bg-[var(--c-bg)] py-1">
          <ChipBar ariaLabel="Run view mode">
            <Chip
              selected={viewMode === 'aggregate'}
              onClick={() => setViewModePersist('aggregate')}
            >
              {i18n.t('run.view.aggregate')}
            </Chip>
            <Chip
              selected={viewMode === 'perStore'}
              onClick={() => setViewModePersist('perStore')}
            >
              {i18n.t('run.view.perStore')}
            </Chip>
          </ChipBar>
          {viewMode === 'perStore' ? (
            <p className="px-4 pt-1 text-meta text-[var(--c-fg-muted)]">
              {i18n.t('run.view.perStoreHint')}
            </p>
          ) : null}
        </div>
      ) : null}
      {showViewToggle && viewMode === 'perStore' ? (
        <PerStoreView
          run={run}
          storeById={storeById}
          skuById={skuById}
          productName={productName}
          skusByStore={skusByStore}
        />
      ) : null}
      {(!showViewToggle || viewMode === 'aggregate') &&
      (run.status === 'planned' || run.status === 'purchasing') && run.items.length > 0 ? (
        <Card>
          {/* Slim header — Items label + pending count on one tight line.
              Was a CardHeader/CardTitle/CardMeta stack (3 lines, ~56px);
              now a single 28px row that doesn't push items off-screen. */}
          <div className="flex items-baseline justify-between gap-2 px-4 py-1.5 text-label text-[var(--c-fg-muted)]">
            <span className="font-semibold uppercase tracking-wide">{i18n.t('run.section.items')}</span>
            <span className="tabular-nums">
              {i18n.t('run.label.pendingFraction', {
                done: run.items.filter((i) => i.status === 'pending').length,
                total: run.items.length,
              })}
            </span>
          </div>
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

      {run.status === 'delivering' && involvedStoreIds.length > 0 ? (
        <Card>
          {/* Slim header — same density treatment as Items.
              "Tap to deliver" hint is implicit in the badge tone, dropped. */}
          <div className="flex items-baseline justify-between gap-2 px-4 py-1.5 text-label text-[var(--c-fg-muted)]">
            <span className="font-semibold uppercase tracking-wide">{i18n.t('run.section.stores')}</span>
            <span className="tabular-nums">
              {i18n.t('run.label.confirmedFraction', {
                done: involvedStoreIds.filter((sid) =>
                  run.splits.filter((sp) => sp.storeId === sid).every((sp) => !!sp.confirmedAt),
                ).length,
                total: involvedStoreIds.length,
              })}
            </span>
          </div>
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

      {run.status === 'planned' ? (
        <Banner
          tone="info"
          title={i18n.t('run.banner.readyToStart')}
        >
          {i18n.t('run.banner.readyToStartBody')}
        </Banner>
      ) : null}
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
  i18n,
  toast,
}: {
  preview: {
    date: string;
    sessions: ReadonlyArray<{ id: string; storeId: string }>;
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
    /** M1.8: per-store concatenated session notes ("其他物品"). */
    sessionNotesByStore?: Record<string, string>;
  };
  skuById: Map<
    string,
    { id: string; names: Record<string, string>; unit: string; step: string }
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
      const name = sku ? productName(sku) : it.skuId.slice(0, 8);
      lines.push(`• ${name}: ${formatQty(it.qty)} ${sku?.unit ?? ''}`);
    }
    // M1.8: append the staff's "其他物品" note so the purchaser sees
    // it on the same copy-paste they ship to the chat group.
    const note = preview.sessionNotesByStore?.[storeId];
    if (note && note.trim()) {
      lines.push('');
      lines.push(`📝 ${i18n.t('order.notes.label')}:`);
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
        const name = sku ? productName(sku) : line.skuId.slice(0, 8);
        // No bullet, no spaces around the unit — the user wants
        // "牛肉 8kg" form, not "• 牛肉 (8 kg)".
        lines.push(`${name} ${formatQty(line.qty)}${sku?.unit ?? ''}`);
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
          {preview.plannedItems.length > 8 ? (
            <li className="pt-1 text-body-sm text-[var(--c-fg-muted)]">
              +{preview.plannedItems.length - 8} {i18n.t('common.more')}
            </li>
          ) : null}
        </ul>
      ) : null}

      {view === 'byStore' ? (
        <div className="flex flex-col gap-3 px-4 py-3">
          {byStore.map((g) => {
            const storeNote = preview.sessionNotesByStore?.[g.storeId]?.trim();
            return (
            <section key={g.storeId} className="rounded-[var(--r-card)] bg-[var(--c-surface-2)] p-3">
              <div className="mb-2 flex items-baseline justify-between gap-2">
                <span className="text-body font-semibold text-[var(--c-fg)]">
                  🏪 {g.storeName}
                </span>
                <button
                  type="button"
                  onClick={() => copyToClipboard(buildStoreText(g.storeId, g.storeName, g.items), 'run.previewStore.copied')}
                  className="press rounded-full bg-[var(--c-surface)] px-3 py-1 text-meta font-medium ring-hairline"
                >
                  {i18n.t('run.previewStore.copyList')}
                </button>
              </div>
              <ul className="flex flex-col gap-1">
                {g.items.map((it) => {
                  const sku = skuById.get(it.skuId);
                  return (
                    <li key={it.skuId} className="flex justify-between text-body-sm">
                      <span>{sku ? productName(sku) : it.skuId.slice(0, 8)}</span>
                      <span className="font-mono tabular-nums">
                        {formatQty(it.qty)} {sku?.unit}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {/* M1.8: surface the staff's "其他物品" note inline. The
                  purchaser scrolls the by-store view at the market and
                  needs the request right next to the SKU list, not
                  buried in a separate section. */}
              {storeNote ? (
                <div className="mt-2 rounded-[var(--r-card)] bg-[var(--c-warn-bg,#fff8e1)] px-3 py-2 ring-hairline">
                  <div className="text-meta font-semibold uppercase tracking-wide text-[var(--c-fg-muted)]">
                    📝 {i18n.t('order.notes.label')}
                  </div>
                  <div className="mt-0.5 whitespace-pre-wrap text-body-sm leading-snug text-[var(--c-fg)]">
                    {storeNote}
                  </div>
                </div>
              ) : null}
            </section>
            );
          })}
        </div>
      ) : null}

      {view === 'bySupplier' ? (
        <div className="flex flex-col gap-3 px-4 py-3">
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
                    <div className="text-meta text-[var(--c-fg-muted)]">@{b.contactTg}</div>
                  ) : b.contactPhone ? (
                    <div className="text-meta text-[var(--c-fg-muted)]">{b.contactPhone}</div>
                  ) : null}
                </div>
                {b.supplierId ? (
                  <button
                    type="button"
                    onClick={() => copyToClipboard(buildVendorText(b), 'run.previewSupplier.copied')}
                    className="press shrink-0 rounded-full bg-[var(--c-action)] px-3 py-1 text-meta font-semibold text-[var(--c-action-fg)]"
                  >
                    {i18n.t('run.previewSupplier.copyToVendor')}
                  </button>
                ) : null}
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
                            className="flex items-baseline justify-between gap-2 text-body-sm"
                          >
                            <button
                              type="button"
                              onClick={() => setVendorPickerFor(it.skuId)}
                              className="press min-w-0 flex-1 text-left text-[var(--c-fg)] underline decoration-dotted decoration-[var(--c-fg-muted)] underline-offset-2"
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
    onError: (err) => toast.error(err.message),
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
                  <div className="mt-0.5 text-meta opacity-80">@{sup.contactTg}</div>
                ) : sup.contactPhone ? (
                  <div className="mt-0.5 text-meta opacity-80">{sup.contactPhone}</div>
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
            {/* M1.8: surface "其他物品" note here too, since this is the
                view the purchaser scrolls store-by-store at the
                market. */}
            {storeNote ? (
              <div className="mx-4 mb-2 mt-1 rounded-[var(--r-card)] bg-[var(--c-warn-bg,#fff8e1)] px-3 py-2 ring-hairline">
                <div className="text-meta font-semibold uppercase tracking-wide text-[var(--c-fg-muted)]">
                  📝
                </div>
                <div className="mt-0.5 whitespace-pre-wrap text-body-sm leading-snug text-[var(--c-fg)]">
                  {storeNote}
                </div>
              </div>
            ) : null}
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
                      ? 'text-[var(--c-success,#16a34a)]'
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
                      <span className="shrink-0 font-mono text-body-sm tabular-nums text-[var(--c-fg-muted)]">
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
  onSave: (payload: {
    skuId: string;
    actualQty: string;
    unitPrice: string;
    storeSplits: Array<{ storeId: string; qty: string }>;
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
  const [price, setPrice] = useState<string>(item.unitPrice ?? lastPrice ?? '');
  const savedRef = useRef(false);

  // When server data updates (e.g. ws push, edit landed), reconcile
  // the local input values UNLESS the user is mid-edit (the row is
  // pending and they may have typed something we shouldn't clobber).
  useEffect(() => {
    if (item.status === 'pending') return;
    setQty(formatQty(item.purchasedQty ?? item.plannedQty));
    setPrice(item.unitPrice ?? lastPrice ?? '');
    savedRef.current = false;
  }, [item.status, item.purchasedQty, item.unitPrice, item.plannedQty, lastPrice]);

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
    const unitPrice = price.trim();
    if (!actualQty || Number(actualQty) <= 0) return;
    if (!unitPrice || Number(unitPrice) <= 0) return;

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
      unitPrice,
      storeSplits: splits,
    });
  };

  // Live "total = qty × price" hint shown below the inputs. Helps the
  // user sanity-check before tapping Save.
  const totalHint = useMemo(() => {
    const q = Number(qty);
    const p = Number(price);
    if (!Number.isFinite(q) || !Number.isFinite(p) || q <= 0 || p <= 0) {
      return null;
    }
    return Math.round(q * p);
  }, [qty, price]);

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
          <span className="shrink-0 truncate text-h3 font-semibold">{skuName}</span>
          <span className="min-w-0 flex-1 truncate text-label text-[var(--c-fg-muted)]">
            {formatQty(item.plannedQty)} {unit}
            {lastPrice ? (
              <>
                {' · '}
                <span className="font-mono tabular-nums">{formatMoney(lastPrice)}</span>
              </>
            ) : null}
          </span>
          <button
            type="button"
            onClick={() => onMarkNa(item.skuId)}
            className="shrink-0 rounded-[var(--r-pill)] border border-[var(--c-divider)] px-2 py-0.5 text-meta text-[var(--c-fg-muted)] active:bg-[var(--c-surface-2)]"
          >
            {i18n.t('run.action.markNa')}
          </button>
        </div>
        {/* Line 2: qty × price = total ✓ — everything on one line.
            Total hint is inline (right of price, before ✓) so the user
            sees their math without an extra row. */}
        <div className="mt-1.5 grid items-center gap-1.5"
             style={{ gridTemplateColumns: '4.5rem auto minmax(0,1fr) auto minmax(0,auto) auto' }}>
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
          <span className="text-meta text-[var(--c-fg-muted)]">UZS</span>
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
    return (
      <li className="flex items-center gap-2 border-b border-[var(--c-divider)] px-4 py-2 last:border-b-0">
        <span aria-hidden className="shrink-0 text-body text-[var(--c-success,#16a34a)]">✓</span>
        <span className="shrink-0 truncate text-body font-semibold">{skuName}</span>
        <span className="min-w-0 flex-1 truncate text-label text-[var(--c-fg-muted)]">
          {formatQty(item.purchasedQty)} {unit} × {formatMoney(item.unitPrice)}
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
          className="shrink-0 rounded-[var(--r-pill)] border border-[var(--c-divider)] px-2 py-0.5 text-meta text-[var(--c-fg-muted)] active:bg-[var(--c-surface-2)]"
        >
          {i18n.t('run.action.editPurchase')}
        </button>
        <button
          type="button"
          onClick={() => onUndoPurchase(item.skuId, skuName)}
          aria-label={i18n.t('run.action.undoPurchase')}
          className="shrink-0 rounded-[var(--r-pill)] border border-[var(--c-divider)] px-2 py-0.5 text-meta text-[var(--c-danger)] active:bg-[var(--c-surface-2)]"
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
        className="shrink-0 rounded-[var(--r-pill)] border border-[var(--c-divider)] px-2 py-0.5 text-meta text-[var(--c-fg-muted)] active:bg-[var(--c-surface-2)]"
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
  onCancel,
  onChange,
  onSubmit,
  submitting,
}: PurchaseSheetProps) {
  const toast = useToast();
  const sku = draft ? skuById.get(draft.skuId) : null;
  const candidateStores = useMemo(() => [...storeById.values()], [storeById]);

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
              {i18n.t('run.action.unitPriceUzs')}
              <Input
                className="mt-1"
                type="number"
                inputMode="decimal"
                value={draft.unitPrice}
                onChange={(e) => onChange({ ...draft, unitPrice: e.target.value })}
              />
            </label>
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
  const showReasonField = !!(config && (config.requireReason || config.reasonOptional));
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
  const showCancel = !!config?.requireReason;
  const showPrimary = !inTelegram;
  const hasFooter = showPrimary || showCancel;
  return (
    <Sheet
      open={!!config}
      onOpenChange={(open) => !open && onCancel()}
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
                autoFocus
              />
            </label>
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
  finishedAt: Date | string | null;
}

type HistoryFilter = 'finished' | 'all' | 'cancelled';
const RUN_HISTORY_FILTER_KEY = 'compass.runHistory.filter';

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
  // M1.7-A (2026-05-06): default to "finished only". The user's
  // mental model is "history = completed business outcomes;
  // cancelled = oops, didn't happen." If we lump them together,
  // a few cancellations in a row drown out real results.
  // Audit trail for cancels lives in `policy_decisions` (Operations
  // → Admin audit), not here.
  const [filter, setFilter] = useState<HistoryFilter>(() => {
    if (typeof window === 'undefined') return 'finished';
    const v = window.localStorage.getItem(RUN_HISTORY_FILTER_KEY);
    return v === 'all' || v === 'cancelled' ? v : 'finished';
  });
  useEffect(() => {
    if (typeof window !== 'undefined')
      window.localStorage.setItem(RUN_HISTORY_FILTER_KEY, filter);
  }, [filter]);

  // Only terminal states show up in history (active runs are
  // rendered above by ActiveRunPanel).
  const allHistorical = useMemo(
    () =>
      runs.filter((r) => r.status === 'finished' || r.status === 'cancelled'),
    [runs],
  );
  const history = useMemo(() => {
    const filtered =
      filter === 'finished'
        ? allHistorical.filter((r) => r.status === 'finished')
        : filter === 'cancelled'
          ? allHistorical.filter((r) => r.status === 'cancelled')
          : allHistorical;
    return filtered.slice(0, 30);
  }, [allHistorical, filter]);

  if (allHistorical.length === 0) return null;

  // Counts so the chip labels can show "(N)" — helps the operator
  // see at a glance whether switching tabs would reveal anything.
  const finishedCount = allHistorical.filter((r) => r.status === 'finished').length;
  const cancelledCount = allHistorical.filter((r) => r.status === 'cancelled').length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{i18n.t('run.history.title')}</CardTitle>
        <CardMeta>{i18n.t('run.history.subtitle')}</CardMeta>
      </CardHeader>
      {/* Filter chips — only render when there's actually a choice
          to make (i.e. some cancelled runs exist). For pure-finished
          history we keep the toolbar invisible to reduce noise. */}
      {cancelledCount > 0 ? (
        <div className="flex gap-1 px-4 pt-1 pb-2">
          {(
            [
              ['finished', i18n.t('run.history.filter.finished'), finishedCount],
              ['all', i18n.t('run.history.filter.all'), allHistorical.length],
              ['cancelled', i18n.t('run.history.filter.cancelled'), cancelledCount],
            ] as const
          ).map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={
                'press flex-1 rounded-[var(--r-pill)] px-2 py-1 text-meta font-medium ring-hairline ' +
                (filter === key
                  ? 'bg-[var(--c-action)] text-[var(--c-action-fg)]'
                  : 'bg-[var(--c-surface-2)] text-[var(--c-fg)]')
              }
            >
              {label} ({count})
            </button>
          ))}
        </div>
      ) : null}
      <ul className="flex flex-col" role="list">
        {history.map((r) => {
          const cancelled = r.status === 'cancelled';
          return (
            <li
              key={r.id}
              className="border-b border-[var(--c-divider)] last:border-b-0"
            >
              <button
                type="button"
                onClick={() => onOpen(r)}
                className={
                  'flex w-full items-center justify-between gap-2 px-4 py-3 text-left active:bg-[var(--c-surface-2)] ' +
                  (cancelled ? 'opacity-60' : '')
                }
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-h3 font-semibold tabular-nums">
                      {r.runDate}
                    </span>
                    {r.runIndex > 0 ? (
                      <span className="text-label text-[var(--c-fg-muted)]">
                        #{r.runIndex + 1}
                      </span>
                    ) : null}
                    {cancelled ? <span aria-hidden>❌</span> : null}
                  </div>
                  <div className="text-label text-[var(--c-fg-muted)]">
                    {r.status === 'finished' && r.actualTotal
                      ? i18n.t('run.history.totalLine', {
                          total: formatMoney(r.actualTotal),
                        })
                      : cancelled
                        ? // Cancel reason is in the RunCancelled event
                          // payload but not projected to market_runs_v.
                          // Tap-through opens the detail sheet which
                          // hits run.get and can render the reason
                          // there. Showing it inline would require a
                          // schema bump we didn't take this round.
                          i18n.t('run.history.cancelled')
                        : ''}
                  </div>
                </div>
                <Badge tone={cancelled ? 'muted' : 'success'}>{r.status}</Badge>
              </button>
            </li>
          );
        })}
      </ul>
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
  const detail = trpc.run.get.useQuery(
    target ? { runId: target.runId } : { runId: '' },
    { enabled: !!target },
  );

  const breakdown = useMemo(() => {
    if (!detail.data) return null;
    const items = detail.data.items;
    const splits = detail.data.splits;
    let total = 0;
    const purchasedCount = items.filter((i) => i.status === 'purchased').length;
    const unavailableCount = items.filter((i) => i.status === 'unavailable').length;
    for (const it of items) {
      if (it.status === 'purchased' && it.unitPrice && it.purchasedQty) {
        total += Number(it.unitPrice) * Number(it.purchasedQty);
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
    return { items, splits, total, purchasedCount, unavailableCount, perStore };
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
          <div className="flex items-baseline justify-between gap-3 rounded-[var(--r-card)] bg-[var(--c-surface-2)] px-4 py-3">
            <div>
              <div className="text-meta uppercase tracking-[0.08em] text-[var(--c-fg-muted)]">
                {i18n.t('run.history.totalLabel')}
              </div>
              <div className="font-mono text-h1 font-semibold tabular-nums">
                {formatMoney(breakdown.total)} UZS
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

          {/* Per-item rows */}
          <div>
            <div className="mb-2 text-label font-semibold uppercase tracking-[0.04em] text-[var(--c-fg-muted)]">
              {i18n.t('run.history.itemsHeading')}
            </div>
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
              <div className="mb-2 text-label font-semibold uppercase tracking-[0.04em] text-[var(--c-fg-muted)]">
                {i18n.t('run.history.storesHeading')}
              </div>
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
