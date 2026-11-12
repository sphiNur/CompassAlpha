/**
 * What the history detail sheet lists for one finished run, for the whole
 * run or for one of its stores. Review RUNWEB2-09 (2026-11-12): these
 * lived inside the sheet's 800 lines, where no test could reach them.
 *
 * Review RUNWEB2-03 (2026-11): every amount is the server's
 * (run.historyDetail's money), made from the lines the History list row
 * and the finance report add up. The page recomputed them with its own
 * copy of the rule, so the detail could disagree with the row it opened.
 * M3.52: each store's slice stays strictly its own.
 *
 * Pure; tests in __tests__/historyBreakdown.test.ts.
 */
import { toCents } from '@compass/contracts/money';
import type { RouterOutputs } from '../../../lib/trpc';
import { splitPaymentMethod } from './settlement';

export type HistoryDetail = RouterOutputs['run']['historyDetail'];
export type HistoryItem = HistoryDetail['items'][number];
export type HistorySplit = HistoryDetail['splits'][number];
export type HistoryExpense = HistoryDetail['expenses'][number];
export type HistoryStoreMoney = HistoryDetail['money']['byStore'][number];
export type HistoryCorrection = HistoryDetail['corrections'][number];

/** The run's lines and money, as the sheet reads them. */
export function historyBreakdownOf(data: HistoryDetail) {
  const { items, splits, money } = data;
  return {
    items,
    splits,
    perStoreDemand: data.perStoreDemand ?? [],
    expenses: data.expenses ?? [],
    total: money.total,
    itemsTotal: money.itemsTotal,
    totalCash: money.cash,
    totalTransfer: money.transfer,
    expensesTotal: money.expensesTotal,
    purchasedCount: items.filter((i) => i.status === 'purchased').length,
    unavailableCount: items.filter((i) => i.status === 'unavailable').length,
    // Largest first, as the server orders them.
    perStore: new Map(money.byStore.map((store) => [store.storeId, store])),
  };
}

export type HistoryBreakdown = ReturnType<typeof historyBreakdownOf>;

/** A line of the sheet: the run's, or its part for the store shown. */
export interface VisibleHistoryRow {
  item: HistoryItem;
  qty: string | null;
  lineTotal: string | null;
  perStoreSplits: HistorySplit[];
}

/**
 * The lines to list: every item of the run; for one store, what was
 * bought for it (its split) and what it asked for that was not available.
 */
export function visibleHistoryRows(
  breakdown: HistoryBreakdown,
  storeId: string | null,
): VisibleHistoryRow[] {
  if (!storeId) {
    return breakdown.items.map((item) => ({
      item,
      qty: item.purchasedQty,
      lineTotal: item.amount,
      perStoreSplits: breakdown.splits.filter((split) => split.skuId === item.skuId),
    }));
  }

  const demandBySku = new Map(
    breakdown.perStoreDemand
      .filter((d) => d.storeId === storeId)
      .map((d) => [d.skuId, d.qty] as const),
  );
  return breakdown.items.flatMap<VisibleHistoryRow>((item) => {
    if (item.status === 'purchased') {
      const split = breakdown.splits.find(
        (sp) => sp.storeId === storeId && sp.skuId === item.skuId,
      );
      if (!split) return [];
      return [
        {
          item,
          qty: split.qty,
          lineTotal: split.amount,
          perStoreSplits: [split],
        },
      ];
    }
    if (item.status === 'unavailable' && demandBySku.has(item.skuId)) {
      return [
        {
          item,
          qty: demandBySku.get(item.skuId) ?? null,
          lineTotal: null,
          perStoreSplits: [],
        },
      ];
    }
    return [];
  });
}

/** The figures at the top of the sheet: the run's, or the store's shown. */
export function historyHeadline(
  breakdown: HistoryBreakdown,
  storeId: string | null,
  rows: readonly VisibleHistoryRow[],
) {
  const store = storeId ? (breakdown.perStore.get(storeId) ?? null) : null;
  return {
    total: store?.total ?? breakdown.total ?? '0',
    cash: store?.cash ?? breakdown.totalCash ?? '0',
    transfer: store?.transfer ?? breakdown.totalTransfer ?? '0',
    // 2026-10-21 CA-11: items / expenses / total, for the run or the store.
    itemsTotal: store?.itemsTotal ?? breakdown.itemsTotal ?? '0',
    expensesTotal: store?.expensesTotal ?? breakdown.expensesTotal ?? '0',
    storeCount: storeId ? 1 : breakdown.perStore.size,
    purchasedCount: storeId
      ? rows.filter((row) => row.item.status === 'purchased').length
      : breakdown.purchasedCount,
    unavailableCount: storeId
      ? rows.filter((row) => row.item.status === 'unavailable').length
      : breakdown.unavailableCount,
    // DX-DLV-03 (2026-11-01): problems the stores reported on receipt,
    // counted in every view.
    receivingIssueCount: rows.reduce(
      (n, row) =>
        n + row.perStoreSplits.filter((sp) => sp.confirmStatus && sp.confirmStatus !== 'ok').length,
      0,
    ),
  };
}

/**
 * How a line was paid. In one store's view the line is that store's
 * split, paid one way; across stores, a line paid both ways is 'both'
 * (the sheet then says how much of each).
 */
export function linePaymentOf(
  item: HistoryItem,
  splits: readonly HistorySplit[],
  oneStore: boolean,
): 'cash' | 'transfer' | 'both' {
  if (oneStore) {
    const split = splits[0];
    const method = split ? splitPaymentMethod(split, item) : item.paymentMethod;
    return method === 'transfer' ? 'transfer' : 'cash';
  }
  const cash = toCents(item.cashAmount ?? '0');
  const transfer = toCents(item.transferAmount ?? '0');
  if (cash > 0n && transfer > 0n) return 'both';
  // 2026-10-25: the label follows the money. It used to say transfer
  // whenever the ITEM said so, even where the split paid in cash and
  // the line was counted as cash in every total.
  if (transfer > 0n) return 'transfer';
  if (cash > 0n) return 'cash';
  return item.paymentMethod === 'transfer' ? 'transfer' : 'cash';
}
