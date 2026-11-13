/**
 * The run's confirmation sheet before each step: what it says (title,
 * body, button, whether a reason is asked for) and the command it sends.
 *
 * Review RUNWEB1-04 (2026-11-12): this was a 460-line useMemo in RunPage
 * that wrote the text and fired the mutations, with no test. The page
 * shows what confirmCopyFor returns and sends what confirmCommandFor
 * returns. Pure; tests in __tests__/confirmCopy.test.ts.
 */
import type { I18n } from '@compass/i18n';
import { formatQty } from '../../../lib/format';
import type { ActiveRun } from '../types';
import {
  finishConfirmSummary,
  refinalizeConfirmSummary,
  type ConfirmSummary,
} from './confirmSummary';
import type { FinishSummary } from './finishSummary';
import { pendingExtrasOf } from './runProgress';

/**
 * A pending confirm. The keys here are the ONLY transitions that need a
 * confirmation; trivial actions (Buy, mark N/A) keep their existing
 * inline sheets.
 *
 * Simplification (2026-11-13, owner approved): a step another tap undoes
 * is sent at once (DirectStep, below). Start delivery asks only when
 * other items the stores asked for are still not handled (DX-BUY-5).
 */
export type ConfirmKind =
  | 'startDelivery'
  | 'finish'
  | 'refinalize'
  | 'cancel'
  // Kept: a recall tells the store, and clears the lines it already
  // checked; delivering again does not bring those back.
  | { kind: 'recallDelivery'; storeId: string; storeName: string }
  | { kind: 'undoPurchase'; skuId: string; skuName: string; added: boolean }
  | { kind: 'ejectSession'; sessionId: string; storeName: string; submitterName: string }
  // 2026-10-21 audit C-15: removing an expense was a one-tap ✗ with no
  // confirmation or undo.
  | { kind: 'removeExpense'; expenseId: string; label: string }
  // BUY-5: not buying what a newly joined order added. Review RUNWEB1-29:
  // was the browser's / Telegram's own confirm, unlike every other step.
  // Kept (2026-11-13): nothing brings a dismissed top-up back.
  | { kind: 'dismissTopUp'; skuId: string; qty: string };

/**
 * The steps sent with no sheet and no reason (2026-11-13). Each is undone
 * by one more tap: Start purchase by Back to plan and the other way
 * round, Start delivery by Back to purchase and the other way round,
 * Delivered by Recall, Mark available again by N/A.
 */
export type DirectStep =
  | 'startPurchase'
  | 'startDelivery'
  | 'undoStartPurchase'
  | 'undoStartDelivery'
  | { kind: 'deliverStore'; storeId: string }
  | { kind: 'unmarkUnavailable'; skuId: string };

/** Start delivery asks first only to warn about other items still not handled. */
export function startDeliveryAsks(
  run: Pick<ActiveRun, 'sessionExtrasByStore'> | undefined,
): boolean {
  return pendingExtrasOf(run?.sessionExtrasByStore).length > 0;
}

/** What the run's confirm sheet asks (ConfirmSheet in @compass/ui). */
export interface ConfirmCopy {
  title: string;
  body: string;
  /** The finish and correction sheets' figures, shown above `body` (RUNWEB1-08). */
  summary?: ConfirmSummary;
  confirmLabel: string;
  danger: boolean;
  irreversible?: boolean;
  requireReason: boolean;
  reasonOptional?: boolean;
  reasonPlaceholder?: string;
}

export interface ConfirmCopyContext {
  i18n: I18n;
  /** run.get, with the writes still waiting offline laid over it. */
  run: ActiveRun | undefined;
  summary: FinishSummary;
  currency: string;
  /** A store's name, or the catalog's "unknown store". */
  storeName: (storeId: string) => string;
  /** A product's name in the UI language, or the catalog's "unknown product". */
  skuName: (skuId: string) => string;
}

export function confirmCopyFor(kind: ConfirmKind, ctx: ConfirmCopyContext): ConfirmCopy {
  const { i18n, run } = ctx;
  if (typeof kind === 'string') {
    switch (kind) {
      case 'startDelivery': {
        // DX-BUY-5 (2026-11-01): 「其他物品」 the stores asked for and the
        // purchaser has not handled do not count in "N left", and went
        // out of sight once delivery started. Say so here — a warning
        // only; whether to block is an owner decision (#8). Since
        // 2026-11-13 this is the only reason the sheet opens
        // (startDeliveryAsks); otherwise the step is sent at once.
        const pendingExtras = pendingExtrasOf(run?.sessionExtrasByStore);
        const extrasLine =
          pendingExtras.length > 0
            ? '\n\n' +
              i18n.t('run.confirm.startDelivery.pendingExtras', {
                n: pendingExtras.length,
                names: pendingExtras.map((e) => e.name).join(i18n.t('common.listSeparator')),
              })
            : '';
        return {
          title: i18n.t('run.confirm.startDelivery.title'),
          body: i18n.t('run.confirm.startDelivery.body') + extrasLine,
          confirmLabel: i18n.t('run.action.startDelivery'),
          danger: false,
          requireReason: false,
        };
      }
      case 'finish':
        // RUNWEB1-08: the figures are rows above the text
        // (confirmSummary.ts), each once; the text says what locks.
        return {
          title: i18n.t('run.confirm.finish.title'),
          body: i18n.t('run.confirm.finish.body'),
          summary: finishConfirmSummary(ctx),
          confirmLabel: i18n.t('run.action.finish'),
          danger: false,
          // DX-IX-6: locks the purchase; Cancel shown and focused.
          irreversible: true,
          requireReason: false,
        };
      case 'refinalize':
        // finishSummary reflects the live (corrected) run.get during
        // amending. 2026-10-21 CA-11: the sheet used to show an
        // items-only figure here while the finish sheet showed items +
        // expenses. Both now show the one definition — items / expenses
        // / total — and RunRefinalized freezes itemsTotal and
        // expensesTotal explicitly (actual_total stays the items part).
        return {
          title: i18n.t('run.confirm.refinalize.title'),
          body: i18n.t('run.confirm.refinalize.body'),
          summary: refinalizeConfirmSummary(ctx),
          confirmLabel: i18n.t('run.action.refinalize'),
          danger: false,
          // DX-IX-6: locks the purchase; Cancel shown and focused.
          irreversible: true,
          requireReason: false,
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
        };
    }
  } else {
    switch (kind.kind) {
      case 'recallDelivery':
        return {
          title: i18n.t('run.confirm.recall.title', { store: kind.storeName }),
          body: i18n.t('run.confirm.recall.body'),
          confirmLabel: i18n.t('run.action.recallDelivery'),
          danger: true,
          // 2026-11-13: the reason is optional, behind its link.
          requireReason: false,
          reasonOptional: true,
          reasonPlaceholder: i18n.t('run.eject.reasonPlaceholder'),
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
            kind.added ? 'run.confirm.undoPurchase.bodyAdded' : 'run.confirm.undoPurchase.body',
          ),
          confirmLabel: i18n.t('run.action.undoPurchase'),
          danger: true,
          requireReason: false,
        };
      case 'ejectSession':
        return {
          title: i18n.t('run.confirm.ejectSession.title', {
            store: kind.storeName,
            who: kind.submitterName,
          }),
          body: i18n.t('run.confirm.ejectSession.body'),
          confirmLabel: i18n.t('run.action.ejectSession'),
          danger: true,
          requireReason: false,
          reasonOptional: true,
          reasonPlaceholder: i18n.t('run.eject.reasonPlaceholder'),
        };
      case 'removeExpense':
        return {
          title: i18n.t('run.action.removeExpense'),
          body: kind.label,
          confirmLabel: i18n.t('run.action.removeExpense'),
          danger: true,
          requireReason: false,
        };
      case 'dismissTopUp':
        return {
          title: i18n.t('run.topUp.dismiss'),
          body: i18n.t('run.topUp.dismissConfirm', { qty: formatQty(kind.qty) }),
          confirmLabel: i18n.t('run.topUp.dismiss'),
          danger: false,
          requireReason: false,
        };
    }
  }
}

/** A step's command, named as the page's mutations are (useRunMutations). */
export type ConfirmCommand =
  | {
      procedure: 'startPurchase' | 'startDelivery' | 'finish' | 'refinalize';
      input: { runId: string };
    }
  | { procedure: 'cancelRun'; input: { runId: string; reason: string } }
  | { procedure: 'undoStartPurchase' | 'undoStartDelivery'; input: { runId: string } }
  | { procedure: 'deliverToStore'; input: { runId: string; storeId: string } }
  | { procedure: 'undeliverStore'; input: { runId: string; storeId: string; reason: string } }
  | { procedure: 'unmarkUnavailable'; input: { runId: string; skuId: string } }
  | { procedure: 'undoPurchase'; input: { runId: string; skuId: string; reason: string } }
  | {
      procedure: 'ejectSession';
      input: { runId: string; sessionId: string; reason: string | undefined };
    }
  | { procedure: 'removeExpense'; input: { runId: string; expenseId: string; reason: string } }
  | { procedure: 'dismissTopUp'; input: { runId: string; skuId: string } };

/** `reason` is what the sheet's reason field holds; the kinds without one send ''. */
export function confirmCommandFor(
  kind: ConfirmKind,
  runId: string,
  reason: string,
): ConfirmCommand {
  if (typeof kind === 'string') {
    switch (kind) {
      case 'startDelivery':
      case 'finish':
      case 'refinalize':
        return { procedure: kind, input: { runId } };
      case 'cancel':
        return { procedure: 'cancelRun', input: { runId, reason } };
    }
  } else {
    switch (kind.kind) {
      case 'recallDelivery':
        return {
          procedure: 'undeliverStore',
          input: { runId, storeId: kind.storeId, reason: reason.trim() },
        };
      case 'undoPurchase':
        return { procedure: 'undoPurchase', input: { runId, skuId: kind.skuId, reason: '' } };
      case 'ejectSession':
        return {
          procedure: 'ejectSession',
          input: { runId, sessionId: kind.sessionId, reason: reason.trim() || undefined },
        };
      case 'removeExpense':
        return {
          procedure: 'removeExpense',
          input: { runId, expenseId: kind.expenseId, reason: '' },
        };
      case 'dismissTopUp':
        return { procedure: 'dismissTopUp', input: { runId, skuId: kind.skuId } };
    }
  }
}

/** A direct step's command: no reason (the server takes none, 2026-11-13). */
export function directCommandFor(step: DirectStep, runId: string): ConfirmCommand {
  if (typeof step === 'string') return { procedure: step, input: { runId } };
  switch (step.kind) {
    case 'deliverStore':
      return { procedure: 'deliverToStore', input: { runId, storeId: step.storeId } };
    case 'unmarkUnavailable':
      return { procedure: 'unmarkUnavailable', input: { runId, skuId: step.skuId } };
  }
}
