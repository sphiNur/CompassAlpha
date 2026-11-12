import { describe, expect, test } from 'bun:test';
import {
  historyBreakdownOf,
  historyHeadline,
  linePaymentOf,
  visibleHistoryRows,
  type HistoryDetail,
  type HistoryItem,
  type HistorySplit,
  type HistoryStoreMoney,
} from '../historyBreakdown';

const item = (skuId: string, over: Partial<HistoryItem> = {}) =>
  ({
    skuId,
    status: 'purchased',
    purchasedQty: '3',
    unitPrice: '100',
    paymentMethod: 'cash',
    amount: '300',
    cashAmount: '300',
    transferAmount: '0',
    ...over,
  }) as HistoryItem;

/** Apples at 100 a piece. */
const split = (skuId: string, storeId: string, qty: string, over: Partial<HistorySplit> = {}) =>
  ({ skuId, storeId, qty, amount: `${qty}00`, ...over }) as HistorySplit;

const storeMoney = (storeId: string, total: string, over: Partial<HistoryStoreMoney> = {}) =>
  ({
    storeId,
    total,
    itemsTotal: total,
    expensesTotal: '0',
    cash: total,
    transfer: '0',
    itemCount: 1,
    expenseCount: 0,
    ...over,
  }) satisfies HistoryStoreMoney;

/** Two stores: A took 2 apples, B 1 apple and asked for the pears nobody had. */
const detail = {
  items: [
    item('apple'),
    item('pear', {
      status: 'unavailable',
      purchasedQty: null,
      amount: null,
      cashAmount: null,
      transferAmount: null,
    }),
  ],
  splits: [
    split('apple', 'A', '2', { confirmStatus: 'short', confirmReceivedQty: '1' }),
    split('apple', 'B', '1'),
  ],
  perStoreDemand: [
    { storeId: 'A', skuId: 'apple', qty: '2' },
    { storeId: 'B', skuId: 'apple', qty: '1' },
    { storeId: 'B', skuId: 'pear', qty: '4' },
  ],
  expenses: [],
  money: {
    total: '350',
    itemsTotal: '300',
    expensesTotal: '50',
    cash: '250',
    transfer: '100',
    byStore: [storeMoney('A', '200'), storeMoney('B', '150', { expensesTotal: '50' })],
  },
} as unknown as HistoryDetail;

describe('history detail breakdown', () => {
  test('the whole run lists every item with all its splits, and the run money', () => {
    const breakdown = historyBreakdownOf(detail);
    const rows = visibleHistoryRows(breakdown, null);
    expect(rows.map((r) => [r.item.skuId, r.qty, r.lineTotal, r.perStoreSplits.length])).toEqual([
      ['apple', '3', '300', 2],
      ['pear', null, null, 0],
    ]);
    expect(historyHeadline(breakdown, null, rows)).toEqual({
      total: '350',
      cash: '250',
      transfer: '100',
      itemsTotal: '300',
      expensesTotal: '50',
      storeCount: 2,
      purchasedCount: 1,
      unavailableCount: 1,
      receivingIssueCount: 1,
    });
  });

  test('one store lists its own split and what it asked for that nobody had', () => {
    const breakdown = historyBreakdownOf(detail);
    const forB = visibleHistoryRows(breakdown, 'B');
    expect(forB.map((r) => [r.item.skuId, r.qty, r.lineTotal])).toEqual([
      ['apple', '1', '100'],
      ['pear', '4', null],
    ]);
    expect(historyHeadline(breakdown, 'B', forB)).toMatchObject({
      total: '150',
      expensesTotal: '50',
      storeCount: 1,
      purchasedCount: 1,
      unavailableCount: 1,
      receivingIssueCount: 0,
    });
    // A asked for no pears: only its apples, with the problem it reported.
    const forA = visibleHistoryRows(breakdown, 'A');
    expect(forA.map((r) => [r.item.skuId, r.qty])).toEqual([['apple', '2']]);
    expect(historyHeadline(breakdown, 'A', forA).receivingIssueCount).toBe(1);
  });

  test('a line says how it was paid: by its store in one store, by the money across stores', () => {
    const apple = item('apple', { paymentMethod: 'cash' });
    expect(
      linePaymentOf(apple, [split('apple', 'A', '1', { paymentMethod: 'transfer' })], true),
    ).toBe('transfer');
    expect(linePaymentOf(apple, [], true)).toBe('cash');
    expect(
      linePaymentOf(item('apple', { cashAmount: '100', transferAmount: '200' }), [], false),
    ).toBe('both');
    // 2026-10-25: the money wins over the item's own method.
    expect(
      linePaymentOf(
        item('apple', { paymentMethod: 'transfer', cashAmount: '300', transferAmount: '0' }),
        [],
        false,
      ),
    ).toBe('cash');
    // Nothing paid: the item's method.
    expect(
      linePaymentOf(
        item('apple', { paymentMethod: 'transfer', cashAmount: null, transferAmount: null }),
        [],
        false,
      ),
    ).toBe('transfer');
  });
});
