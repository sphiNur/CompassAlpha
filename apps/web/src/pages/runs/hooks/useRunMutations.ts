/**
 * The purchase page's writes: every run mutation, with its toast, haptic
 * and refresh, and for the five that can wait offline, their queueing.
 *
 * Review RUNWEB1-04 (2026-11-12): these were the first 400 lines of
 * RunPage. The page keeps its state; what a write does to it (close a
 * form, show the new run) comes in as `on`.
 */
import { useCallback, useRef } from 'react';
import { useToast } from '@compass/ui';
import { trpc } from '../../../lib/trpc';
import { haptic } from '../../../lib/telegram';
import { useI18n } from '../../../hooks/useI18n';
import { useErrToast } from '../../../hooks/useErrToast';
import { useQueueOnNetworkError, useStableIdempotencyKey } from '../../../hooks/useOfflineWrite';
import { enqueueWrite } from '../../../lib/outbox/engine';
import type { MutationInput } from '../../../lib/trpcPaths';
import { RUN_PAGE } from '../../../config/timings';
import type { AddItemCommand } from '../lib/addItem';
import type { ConfirmCommand } from '../lib/confirmCopy';
import { extraStatusOf, withExtraStatus, withRecordedPurchase } from '../lib/pendingOverlay';

type MarkExtraInput = MutationInput<'order.markExtraStatus'>;

/** What a write does to the page's own state. */
export interface RunMutationEffects {
  /** run.create answered: show that run (or the live one handed back), forget the trip's ticks and date. */
  runCreated: (runId: string | undefined) => void;
  /** The orders were attached: close their picker. */
  sessionsAttached: () => void;
  /** The add sheet's item or expense was saved, or queued offline: close the sheet. */
  addItemSaved: () => void;
  /** A purchase or revision was saved, or a purchase queued: close the form it came from. */
  purchaseSaved: (sent: { runId: string; skuId: string }) => void;
  /** A purchase was refused or lost: its row stops showing it as saving. */
  purchaseFailed: (sent: { skuId: string }) => void;
  /** A row's payment switch answered: the row takes taps again. */
  paymentSettled: (sent: { skuId: string }) => void;
  /** An item was marked unavailable, or that was queued: close its sheet. */
  unavailableSaved: () => void;
  /** A delivery was queued offline: close its confirmation. */
  deliveryQueued: () => void;
}

export function useRunMutations(on: RunMutationEffects) {
  const i18n = useI18n();
  const toast = useToast();
  const utils = trpc.useUtils();
  const invalidateRunQuietly = useCallback(
    (includeList = false) => {
      setTimeout(() => {
        void utils.run.get.invalidate();
        if (includeList) void utils.run.list.invalidate();
      }, RUN_PAGE.refetchDelayMs);
    },
    [utils],
  );
  // ---- Mutations ------------------------------------------------------
  // M1.9 (2026-05-07): hoisted into `hooks/useErrToast.ts` so the same
  // translation logic doesn't live in 3 different pages with subtly
  // different shapes. Server-side TRPCError uses i18n keys like
  // `run.errors.runFrozen` as `message`; the helper translates them
  // and falls back to the caller-provided key on raw / unknown
  // strings.
  const errToast = useErrToast();
  const queueOnNetworkError = useQueueOnNetworkError();
  const create = trpc.run.create.useMutation({
    onSuccess: (res) => {
      void utils.run.list.invalidate();
      void utils.run.previewCreatable.invalidate();
      haptic('success');
      on.runCreated(res?.runId);
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
      on.sessionsAttached();
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
    onError: errToast('common.errors.actionFailed'),
  });
  // M3.41 (2026-05-21): mid-run addition. Mirrors purchaseItem's
  // success/offline-queue pattern so the bazaar UX (flaky LTE) survives
  // a network drop mid-add. Idempotent at the API layer via
  // X-Idempotency-Key so replays don't double-buy.
  // 2026-07-26: both of these enqueue to the offline outbox on a network
  // error, but neither minted a STABLE idempotency key — so the replay
  // sent a fresh one and the server's 24h dedupe cache never matched.
  // A committed-but-lost response (the iOS "Load failed" case) therefore
  // recorded the off-catalog purchase or the expense TWICE.
  const addItemKey = useStableIdempotencyKey();
  const addExpenseKey = useStableIdempotencyKey();

  const addPurchaserItem = trpc.run.addPurchaserItem.useMutation({
    ...addItemKey,
    onSuccess: () => {
      invalidateRunQuietly(true);
      on.addItemSaved();
      haptic('success');
      toast.success(i18n.t('run.toast.itemAdded'));
    },
    onError: (err, vars, ctx) =>
      queueOnNetworkError(err, {
        procedure: 'run.addPurchaserItem',
        input: vars,
        idempotencyKey: ctx?.idempotencyKey,
        failedKey: 'run.toast.couldNotAddItem',
        queuedKey: 'run.toast.purchaseSavedOffline',
        onQueued: on.addItemSaved,
      }),
  });
  // M3.44 (2026-05-22): off-catalog expense add + remove. Same
  // optimistic + offline-queue pattern as the SKU-item path so the
  // bazaar UX is consistent across modes.
  // Walkthrough F10 (2026-11-05): pricing a staff member's "other item"
  // records an expense, but the item itself stayed "not handled" — and
  // 开始配送 then warned about it. The item an expense was opened from
  // is marked bought once that expense is saved.
  const extraForExpense = useRef<{
    expenseId: string;
    sessionId: string;
    idx: number;
    seq?: number;
  } | null>(null);
  const addExpense = trpc.run.addExpense.useMutation({
    ...addExpenseKey,
    onSuccess: (_data, vars) => {
      const fromExtra = extraForExpense.current;
      if (fromExtra && fromExtra.expenseId === vars.expenseId) {
        extraForExpense.current = null;
        markExtraStatus.mutate({
          sessionId: fromExtra.sessionId,
          extraIndex: fromExtra.idx,
          status: 'bought',
          expectedSeq: fromExtra.seq,
        });
      }
      invalidateRunQuietly(true);
      on.addItemSaved();
      haptic('success');
      toast.success(i18n.t('run.toast.expenseAdded'));
    },
    onError: (err, vars, ctx) =>
      queueOnNetworkError(err, {
        procedure: 'run.addExpense',
        input: vars,
        idempotencyKey: ctx?.idempotencyKey,
        failedKey: 'run.toast.couldNotAddExpense',
        queuedKey: 'run.toast.purchaseSavedOffline',
        onQueued: () => {
          on.addItemSaved();
          // RUNWEB1-17 (2026-11-12): the item it was opened from is marked
          // bought when the expense is sent; offline that mark was lost and
          // starting delivery warned about an item already paid for.
          const fromExtra = extraForExpense.current;
          if (fromExtra && fromExtra.expenseId === vars.expenseId) {
            extraForExpense.current = null;
            void enqueueWrite('order.markExtraStatus', {
              sessionId: fromExtra.sessionId,
              extraIndex: fromExtra.idx,
              status: 'bought',
              expectedSeq: fromExtra.seq,
            }).catch(() => undefined);
          }
        },
      }),
  });
  const removeExpense = trpc.run.removeExpense.useMutation({
    onSuccess: () => {
      invalidateRunQuietly();
      haptic('success');
      toast.info(i18n.t('run.toast.expenseRemoved'));
    },
    onError: errToast('common.errors.actionFailed'),
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
  // attempt and any offline replay (hooks/useOfflineWrite.ts).
  const purchaseKey = useStableIdempotencyKey();
  const purchaseItem = trpc.run.purchaseItem.useMutation({
    ...purchaseKey,
    onSuccess: (_data, vars) => {
      // RUNWEB1-37: bought on its row now, not after the read below.
      utils.run.get.setData({ runId: vars.runId }, (old) =>
        old ? withRecordedPurchase(old, vars) : old,
      );
      invalidateRunQuietly(true);
      on.purchaseSaved(vars);
      haptic('success');
      toast.success(i18n.t('run.toast.purchaseRecorded'));
    },
    onError: (err, vars, ctx) => {
      on.purchaseFailed(vars);
      queueOnNetworkError(err, {
        procedure: 'run.purchaseItem',
        input: vars,
        idempotencyKey: ctx?.idempotencyKey,
        failedKey: 'run.toast.couldNotSavePurchase',
        queuedKey: 'run.toast.purchaseSavedOffline',
        onQueued: () => on.purchaseSaved(vars),
      });
    },
  });
  // The purchase sheet's and "+ Add item"'s revisions. A failed one
  // leaves the form open with what was typed (RUNWEB1-02).
  const revisePurchase = trpc.run.revisePurchase.useMutation({
    onSuccess: (_data, vars) => {
      invalidateRunQuietly();
      on.purchaseSaved(vars);
      haptic('success');
      toast.success(i18n.t('run.toast.purchaseRevised'));
    },
    onError: errToast('run.toast.couldNotSavePurchase'),
  });
  /**
   * A row's 💵 / transfer switch, which opens no form and closes none.
   *
   * RUNWEB1-01 (2026-11-09): it shared `revisePurchase` with the sheet,
   * marked by a ref. A sheet sent while a switch was out made the ref
   * wrong both ways, and react-query fires `mutate`'s own callbacks only
   * for the latest call, so the switch's clean-up never ran: the row
   * stayed busy and the sheet never closed. Its own mutation keeps
   * `isPending` and the answers apart.
   */
  const flipPayment = trpc.run.revisePurchase.useMutation({
    onSuccess: () => {
      invalidateRunQuietly();
      haptic('success');
      toast.success(i18n.t('run.toast.purchaseRevised'));
    },
    onError: errToast('run.toast.couldNotSavePurchase'),
    onSettled: (_data, _err, vars) => on.paymentSettled(vars),
  });

  // BUY-9 (2026-10-30): the replay carries the first attempt's key (as
  // purchaseItem does), so a request that landed with its response lost
  // is not replayed into "item not pending" and a false "please review".
  const markUnavailableKey = useStableIdempotencyKey();
  const markUnavailable = trpc.run.markUnavailable.useMutation({
    ...markUnavailableKey,
    onSuccess: () => {
      invalidateRunQuietly();
      on.unavailableSaved();
      toast.info(i18n.t('run.toast.markedUnavailable'));
    },
    onError: (err, vars, ctx) =>
      queueOnNetworkError(err, {
        procedure: 'run.markUnavailable',
        input: vars,
        idempotencyKey: ctx?.idempotencyKey,
        failedKey: 'common.errors.actionFailed',
        queuedKey: 'run.toast.purchaseSavedOffline',
        onQueued: on.unavailableSaved,
      }),
  });
  // BUY-5 (2026-10-30): the demand that joined after an item was decided
  // will not be bought.
  const dismissTopUp = trpc.run.dismissTopUp.useMutation({
    onSuccess: () => {
      invalidateRunQuietly(true);
      toast.info(i18n.t('run.topUp.dismissed'));
    },
    onError: errToast('common.errors.actionFailed'),
  });
  const unmarkUnavailable = trpc.run.unmarkUnavailable.useMutation({
    onSuccess: () => {
      invalidateRunQuietly();
      haptic('success');
      toast.success(i18n.t('run.toast.unmarkedUnavailable'));
    },
    onError: errToast('common.errors.actionFailed'),
  });
  const undoPurchase = trpc.run.undoPurchase.useMutation({
    onSuccess: () => {
      invalidateRunQuietly();
      haptic('success');
      toast.success(i18n.t('run.toast.purchaseUndone'));
    },
    onError: errToast('common.errors.actionFailed'),
  });
  const startDelivery = trpc.run.startDelivery.useMutation({
    onSuccess: () => {
      invalidateRunQuietly(true);
      haptic('success');
      toast.success(i18n.t('run.toast.deliveryStarted'));
    },
    onError: errToast('common.errors.actionFailed'),
  });
  const deliverKey = useStableIdempotencyKey();
  const deliverToStore = trpc.run.deliverToStore.useMutation({
    ...deliverKey,
    onSuccess: () => {
      invalidateRunQuietly(true);
      // DLV-17 (2026-10-30): the only state change with no feedback.
      haptic('success');
      toast.success(i18n.t('run.toast.delivered'));
    },
    onError: (err, vars, ctx) =>
      queueOnNetworkError(err, {
        procedure: 'run.deliverToStore',
        input: vars,
        idempotencyKey: ctx?.idempotencyKey,
        failedKey: 'common.errors.actionFailed',
        queuedKey: 'run.toast.purchaseSavedOffline',
        onQueued: on.deliveryQueued,
      }),
  });
  const undeliverStore = trpc.run.undeliverStore.useMutation({
    onSuccess: () => {
      invalidateRunQuietly(true);
      haptic('success');
      toast.success(i18n.t('run.toast.deliveryRecalled'));
    },
    onError: errToast('common.errors.actionFailed'),
  });
  const undoStartPurchase = trpc.run.undoStartPurchase.useMutation({
    onSuccess: () => {
      invalidateRunQuietly(true);
      haptic('success');
      toast.success(i18n.t('run.toast.startPurchaseUndone'));
    },
    onError: errToast('common.errors.actionFailed'),
  });
  const undoStartDelivery = trpc.run.undoStartDelivery.useMutation({
    onSuccess: () => {
      invalidateRunQuietly(true);
      haptic('success');
      toast.success(i18n.t('run.toast.startDeliveryUndone'));
    },
    onError: errToast('common.errors.actionFailed'),
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
    onError: errToast('common.errors.actionFailed'),
  });
  const finish = trpc.run.finish.useMutation({
    onSuccess: () => {
      void utils.run.list.invalidate();
      haptic('success');
      toast.success(i18n.t('run.toast.runFinished'));
    },
    onError: errToast('common.errors.actionFailed'),
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
    onError: errToast('common.errors.actionFailed'),
  });
  // M3.37 (2026-05-19, Wave2 #5): purchaser cycles an extra row's
  // outcome (pending → bought → unavailable → pending). One mutation
  // call per tap. No offline queue for a tap: an unmarked extra is
  // functionally identical to "pending", so re-queueing on flaky
  // reconnects would create more confusion than it would resolve (a
  // priced extra's mark is queued with its expense, above).
  const markExtraStatus = trpc.order.markExtraStatus.useMutation({
    onSuccess: () => {
      invalidateRunQuietly();
      haptic('success');
    },
    // APR-18: refused as stale when someone else changed the order since
    // this page read it; show the current rows.
    onError: (err) => {
      invalidateRunQuietly();
      errToast('common.errors.actionFailed')(err);
    },
  });
  /**
   * Review RUNWEB1-17 (2026-11-12): a tap took a second or more to show on
   * a weak line, and a second tap meanwhile worked out the same next status
   * from the old one. The row now shows its new status at once, goes back
   * if the mark fails, and the returned promise (settled, never rejected)
   * lets it wait for the answer before taking another tap.
   */
  const markExtra = (runId: string, input: MarkExtraInput): Promise<void> => {
    const paint = (status: MarkExtraInput['status']) =>
      utils.run.get.setData({ runId }, (old) => {
        if (!old) return old;
        const next = withExtraStatus(
          old.sessionExtrasByStore,
          input.sessionId,
          input.extraIndex,
          status,
        );
        return next === old.sessionExtrasByStore ? old : { ...old, sessionExtrasByStore: next };
      });
    const was = extraStatusOf(
      utils.run.get.getData({ runId })?.sessionExtrasByStore,
      input.sessionId,
      input.extraIndex,
    );
    // A read already on its way would draw the old status over this one.
    void utils.run.get.cancel({ runId });
    paint(input.status);
    return markExtraStatus.mutateAsync(input).then(
      () => undefined,
      () => {
        if (was) paint(was);
      },
    );
  };
  // UIUX-B1 (2026-07-06): the C.2/M3.38 exclusive-claim subsystem
  // (claim/release mutations, auto-claim/auto-release effects, the
  // claimed-by-other banner) was deleted — collaborationEnabled has
  // been hardcoded true since M3.53, which made every branch of it
  // unreachable. The server-side claim machinery + worker sweep stay;
  // re-add the FE wiring only if exclusive mode ever returns.

  /** Send a confirmation's command; `done` closes the sheet once it lands. */
  const sendConfirm = (c: ConfirmCommand, done: () => void) => {
    const after = { onSuccess: done };
    switch (c.procedure) {
      case 'startPurchase':
        startPurchase.mutate(c.input, after);
        break;
      case 'startDelivery':
        startDelivery.mutate(c.input, after);
        break;
      case 'finish':
        finish.mutate(c.input, after);
        break;
      case 'refinalize':
        refinalize.mutate(c.input, after);
        break;
      case 'cancelRun':
        cancelRun.mutate(c.input, after);
        break;
      case 'undoStartPurchase':
        undoStartPurchase.mutate(c.input, after);
        break;
      case 'undoStartDelivery':
        undoStartDelivery.mutate(c.input, after);
        break;
      case 'deliverToStore':
        deliverToStore.mutate(c.input, after);
        break;
      case 'undeliverStore':
        undeliverStore.mutate(c.input, after);
        break;
      case 'unmarkUnavailable':
        unmarkUnavailable.mutate(c.input, after);
        break;
      case 'undoPurchase':
        undoPurchase.mutate(c.input, after);
        break;
      case 'ejectSession':
        ejectSession.mutate(c.input, after);
        break;
      case 'removeExpense':
        removeExpense.mutate(c.input, after);
        break;
    }
  };

  /** Send the add sheet's save (lib/addItem.ts chose the command). */
  const sendAddItem = (c: AddItemCommand) => {
    switch (c.procedure) {
      case 'addExpense':
        addExpense.mutate(c.input);
        break;
      case 'purchaseItem':
        purchaseItem.mutate(c.input);
        break;
      case 'revisePurchase':
        revisePurchase.mutate(c.input);
        break;
      case 'addPurchaserItem':
        addPurchaserItem.mutate(c.input);
        break;
      case 'missingProduct':
        haptic('error');
        toast.error(i18n.t('common.errors.actionFailed'));
        break;
    }
  };

  return {
    create,
    attachSessions,
    startPurchase,
    addPurchaserItem,
    addExpense,
    removeExpense,
    ejectSession,
    purchaseItem,
    revisePurchase,
    flipPayment,
    markUnavailable,
    dismissTopUp,
    unmarkUnavailable,
    undoPurchase,
    startDelivery,
    deliverToStore,
    undeliverStore,
    undoStartPurchase,
    undoStartDelivery,
    cancelRun,
    finish,
    refinalize,
    markExtra,
    /** The other item an expense was opened from, marked bought once the expense saves. */
    extraForExpense,
    sendConfirm,
    sendAddItem,
  };
}
