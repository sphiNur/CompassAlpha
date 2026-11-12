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
import { formatMoney, formatQty } from '../../../lib/format';
import type { ActiveRun } from '../types';
import { receiptShortfall, type FinishSummary } from './finishSummary';
import { STALE_PRICE_DAYS } from './priceState';
import { pendingExtrasOf } from './runProgress';
import { buildStorePickList } from './storePickList';

/** Lines signed short or wrong listed in the finish sheet; the rest are counted (RUNWEB1-32). */
const RECEIPT_ISSUES_LISTED = 5;

/** A pending reason-prompt confirm. The keys here are the ONLY transitions
 *  that need a confirmation; trivial actions (Buy, mark N/A) keep their
 *  existing inline sheets. */
export type ConfirmKind =
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
  | { kind: 'removeExpense'; expenseId: string; label: string }
  // BUY-5: not buying what a newly joined order added. Review RUNWEB1-29:
  // was the browser's / Telegram's own confirm, unlike every other step.
  | { kind: 'dismissTopUp'; skuId: string; qty: string };

/** What the run's confirm sheet asks (ConfirmSheet in @compass/ui). */
export interface ConfirmCopy {
  title: string;
  body: string;
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
  const { i18n, run, summary: finishSummary, currency } = ctx;
  if (typeof kind === 'string') {
    switch (kind) {
      case 'startPurchase':
        return {
          title: i18n.t('run.confirm.startPurchase.title'),
          body: i18n.t('run.confirm.startPurchase.body'),
          confirmLabel: i18n.t('run.action.startPurchase'),
          danger: false,
          requireReason: false,
        };
      case 'startDelivery': {
        // DX-BUY-5 (2026-11-01): 「其他物品」 the stores asked for and the
        // purchaser has not handled do not count in "N left", and went
        // out of sight once delivery started. Say so here — a warning
        // only; whether to block is an owner decision (#8).
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
         * already says everything). The manager sees each store's
         * total, and its cash and transfer parts when the store paid
         * both ways, before tapping Finish.
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
                  const mixed = ps.cash > 0 && ps.transfer > 0;
                  // RUNWEB1-22: the catalog's "cash · transfer" line, not
                  // labels and amounts glued in English order.
                  const tail = mixed
                    ? ' · ' +
                      i18n.t('run.money.cashTransfer', {
                        cash: formatMoney(ps.cash),
                        transfer: formatMoney(ps.transfer),
                      })
                    : '';
                  return i18n.t('common.labelValue', {
                    label: ctx.storeName(ps.storeId),
                    value: `${formatMoney(ps.total)}${tail}`,
                  });
                })
                .join('\n')
            : '';
        // DLV-11 (2026-10-30): the bills below still charge each store
        // for what was split to it, even where the store signed for less.
        // Say so before the run locks: every line signed short / wrong /
        // spoiled, and roughly how much was not received.
        const { issues: receiptIssues, missingValue } = receiptShortfall(run);
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
                .slice(0, RECEIPT_ISSUES_LISTED)
                .map((sp) =>
                  i18n.t('run.confirm.finish.receiptIssueLine', {
                    sku: ctx.skuName(sp.skuId),
                    store: ctx.storeName(sp.storeId),
                    received: formatQty(sp.confirmReceivedQty ?? '0'),
                    qty: formatQty(sp.qty),
                  }),
                )
                .join('\n') +
              (receiptIssues.length > RECEIPT_ISSUES_LISTED
                ? '\n' +
                  i18n.t('run.confirm.finish.receiptIssuesMore', {
                    n: receiptIssues.length - RECEIPT_ISSUES_LISTED,
                  })
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
          // DX-IX-6: locks the purchase; Cancel shown and focused.
          irreversible: true,
          requireReason: false,
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
      case 'undoStartPurchase':
        return {
          title: i18n.t('run.confirm.undoStartPurchase.title'),
          body: i18n.t('run.confirm.undoStartPurchase.body'),
          confirmLabel: i18n.t('run.action.undoStartPurchase'),
          danger: false,
          requireReason: true,
        };
      case 'undoStartDelivery':
        return {
          title: i18n.t('run.confirm.undoStartDelivery.title'),
          body: i18n.t('run.confirm.undoStartDelivery.body'),
          confirmLabel: i18n.t('run.action.undoStartDelivery'),
          danger: false,
          requireReason: true,
        };
    }
  } else {
    switch (kind.kind) {
      case 'deliverStore': {
        // 2026-10-21 FE-03 (F3-01): say what is being handed over — the
        // store's line count (and goods total when every line is
        // priced), plus how many ordered SKUs were unavailable.
        const pick = run
          ? buildStorePickList({
              storeId: kind.storeId,
              items: run.items,
              splits: run.splits,
              demand: run.perStoreDemand,
            })
          : null;
        const pickSummary = pick
          ? [
              i18n.t('run.label.itemsCount', { n: pick.lines.length }),
              ...(pick.total !== null && pick.total > 0
                ? // DLV-18 (2026-10-30): goods only; the store's share of
                  // expenses is added on the final bill.
                  [
                    i18n.t('common.labelValue', {
                      label: i18n.t('run.label.itemsTotal'),
                      value: formatMoney(pick.total, currency),
                    }),
                  ]
                : []),
              ...(pick.unavailable.length > 0
                ? [i18n.t('run.filter.unavailable', { n: pick.unavailable.length })]
                : []),
            ].join(' · ') + '\n'
          : '';
        return {
          title: i18n.t('run.confirm.deliver.title', { store: kind.storeName }),
          body: pickSummary + i18n.t('run.confirm.deliver.body'),
          confirmLabel: i18n.t('run.action.confirmDeliver'),
          danger: false,
          requireReason: false,
        };
      }
      case 'recallDelivery':
        return {
          title: i18n.t('run.confirm.recall.title', { store: kind.storeName }),
          body: i18n.t('run.confirm.recall.body'),
          confirmLabel: i18n.t('run.action.recallDelivery'),
          danger: true,
          requireReason: true,
        };
      case 'unmarkUnavailable':
        return {
          title: i18n.t('run.confirm.unmarkUnavailable.title'),
          body: i18n.t('run.confirm.unmarkUnavailable.body'),
          confirmLabel: i18n.t('run.action.unmarkUnavailable'),
          danger: false,
          requireReason: true,
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

/** A confirmation's command, named as the page's mutations are (useRunMutations). */
export type ConfirmCommand =
  | {
      procedure: 'startPurchase' | 'startDelivery' | 'finish' | 'refinalize';
      input: { runId: string };
    }
  | {
      procedure: 'cancelRun' | 'undoStartPurchase' | 'undoStartDelivery';
      input: { runId: string; reason: string };
    }
  | { procedure: 'deliverToStore'; input: { runId: string; storeId: string } }
  | { procedure: 'undeliverStore'; input: { runId: string; storeId: string; reason: string } }
  | {
      procedure: 'unmarkUnavailable' | 'undoPurchase';
      input: { runId: string; skuId: string; reason: string };
    }
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
      case 'startPurchase':
      case 'startDelivery':
      case 'finish':
      case 'refinalize':
        return { procedure: kind, input: { runId } };
      case 'cancel':
        return { procedure: 'cancelRun', input: { runId, reason } };
      case 'undoStartPurchase':
      case 'undoStartDelivery':
        return { procedure: kind, input: { runId, reason } };
    }
  } else {
    switch (kind.kind) {
      case 'deliverStore':
        return { procedure: 'deliverToStore', input: { runId, storeId: kind.storeId } };
      case 'recallDelivery':
        return { procedure: 'undeliverStore', input: { runId, storeId: kind.storeId, reason } };
      case 'unmarkUnavailable':
        return { procedure: 'unmarkUnavailable', input: { runId, skuId: kind.skuId, reason } };
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
