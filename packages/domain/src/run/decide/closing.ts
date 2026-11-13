/**
 * Closing (review RUNAPI-13): finishing a run, which freezes its money
 * (computeRunTotals), or cancelling it.
 */
// RUNAPI-31: the money module only; the package root brings every zod contract.
import { centsToMoney, lineCents } from '@compass/contracts/money';
import { forbidden, preconditionFailed } from '../../shared/errors';
import type { RunEvent } from '../events';
import type { RunState } from '../state';
import { assertActive, type ActorCtx, type EventBase } from './guards';

export type ClosingCommand =
  | { type: 'FinishRun'; actor: ActorCtx }
  | { type: 'CancelRun'; reason: string; actor: ActorCtx };

export function decideClosing(
  state: RunState,
  command: ClosingCommand,
  baseFor: EventBase,
): RunEvent[] {
  switch (command.type) {
    case 'FinishRun': {
      assertActive(state);
      if (!command.actor.permissions.has('run.finish')) {
        throw forbidden('run.errors.cannotFinish');
      }
      if (state.status !== 'delivering') {
        throw preconditionFailed('run.errors.notFinishable', { status: state.status });
      }
      // Every store touched by purchased items must be confirmed.
      const involvedStores = new Set<string>();
      for (const item of state.items.values()) {
        if (item.status !== 'purchased') continue;
        for (const split of item.storeSplits) involvedStores.add(split.storeId);
      }
      for (const storeId of involvedStores) {
        if (!state.stores.get(storeId)?.confirmedAt) {
          throw preconditionFailed('run.errors.storeNotConfirmed', { storeId });
        }
      }
      // M1.14: cash / transfer breakdown alongside the canonical total.
      // Shared with RefinalizeRun so a post-finish amendment re-freezes
      // totals by the exact same math (cash + transfer = total holds).
      const { total, totalCash, totalTransfer, expensesTotal } = computeRunTotals(state);
      return [
        {
          ...baseFor(1),
          type: 'RunFinished',
          payload: {
            totalActual: total,
            totalCash,
            totalTransfer,
            itemsTotal: total,
            expensesTotal,
          },
        },
      ];
    }

    case 'CancelRun': {
      assertActive(state);
      if (state.status === 'finished') throw preconditionFailed('run.errors.alreadyFinished');
      // `amending` is a finished run under correction; `cancelled` is
      // already terminal. Neither has anything left to cancel.
      if (state.status === 'cancelled' || state.status === 'amending') {
        throw preconditionFailed('run.errors.runFrozen', { status: state.status });
      }
      if (!command.actor.permissions.has('run.create')) {
        throw forbidden('run.errors.cannotCancel');
      }
      // A confirmed store has taken the goods into stock. Cancelling
      // would hand its sessions back as `approved`, to be bought and
      // received a second time, with nothing reversing the first receipt.
      for (const store of state.stores.values()) {
        if (store.confirmedAt) throw preconditionFailed('run.errors.cannotCancelAfterConfirm');
      }
      // DLV-6 (2026-10-30, owner decision): goods already at a store would
      // never reach its stock and its orders would be bought again. Recall
      // the delivery first.
      for (const store of state.stores.values()) {
        if (store.deliveredAt) throw preconditionFailed('run.errors.cannotCancelAfterDelivery');
      }
      // M1.7 (2026-05-07): reason is OPTIONAL by user request — most
      // cancels are misclicks; hard-requiring a reason produces "asdf"
      // noise that pollutes audit. The FE shows an encouraging
      // placeholder but doesn't gate submit. Audit captures the cancel
      // either way (event + policy_decisions row); empty-reason cancels
      // are still attributable to actor + timestamp.
      const reason = command.reason.trim();
      return [
        {
          ...baseFor(1),
          type: 'RunCancelled',
          payload: { reason: reason || null },
        },
      ];
    }

    default: {
      const _x: never = command;
      void _x;
      return [];
    }
  }
}

/**
 * Run-level money, computed from the current state. Extracted from
 * FinishRun so RefinalizeRun re-freezes by identical math.
 *
 * `total` / `totalCash` / `totalTransfer` are ITEMS ONLY (every purchased
 * SKU line at COALESCE(split override, item price)) — the long-standing
 * meaning of `actual_total`; cash + transfer = total by construction.
 *
 * 2026-10-21 CA-11: `expensesTotal` is the sum of active off-catalog
 * expenses, emitted alongside so the one purchase-money definition —
 * items + expenses, always shown as items / expenses / total — is on the
 * event itself. Exported for the domain tests.
 *
 * D1 (2026-10-31): a money line is one store split, qty × price rounded
 * half-up to cents, and the totals are sums of those lines in integer
 * cents (`lineCents` in @compass/contracts — the same rule as the SQL
 * money lines every report and history view sums). It used to be float
 * math over the whole item, so the frozen total could differ from the
 * report by a cent (R2-HIS-1) or lose digits on a huge line (B13).
 * Returned as 2-decimal money strings.
 */
export function computeRunTotals(state: RunState): {
  total: string;
  totalCash: string;
  totalTransfer: string;
  expensesTotal: string;
} {
  let total = 0n;
  let totalCash = 0n;
  let totalTransfer = 0n;
  for (const item of state.items.values()) {
    if (item.status !== 'purchased' || !item.unitPrice || !item.purchasedQty) continue;
    // Purchased items always carry splits summing to purchasedQty; the
    // whole-item line is only a fallback for a stream without any.
    const lines =
      item.storeSplits.length > 0
        ? item.storeSplits.map((split) => ({
            cents: lineCents(split.qty, split.unitPrice ?? item.unitPrice!),
            method: split.paymentMethod ?? item.paymentMethod,
          }))
        : [{ cents: lineCents(item.purchasedQty, item.unitPrice), method: item.paymentMethod }];
    for (const line of lines) {
      total += line.cents;
      if (line.method === 'transfer') totalTransfer += line.cents;
      else totalCash += line.cents;
    }
  }
  let expensesTotal = 0n;
  for (const expense of state.expenses) {
    // Per store split, like the SQL lines; an expense without splits is
    // one line.
    const qtys = expense.storeSplits?.length
      ? expense.storeSplits.map((split) => split.qty)
      : [expense.qty];
    for (const qty of qtys) {
      try {
        expensesTotal += lineCents(qty, expense.unitPrice);
      } catch {
        // A malformed historical value counts as nothing (it used to be
        // dropped by the Number.isFinite guard).
      }
    }
  }
  return {
    total: centsToMoney(total),
    totalCash: centsToMoney(totalCash),
    totalTransfer: centsToMoney(totalTransfer),
    expensesTotal: centsToMoney(expensesTotal),
  };
}
