import { describe, expect, test } from 'bun:test';
import type { ActiveRun } from '../../types';
import { finishSummaryOf, receiptShortfall } from '../finishSummary';

type Item = ActiveRun['items'][number];
type Split = ActiveRun['splits'][number];
type Expense = NonNullable<ActiveRun['expenses']>[number];

const item = (skuId: string, over: Partial<Item> = {}): Item => ({
  skuId,
  plannedQty: '1',
  purchasedQty: '1',
  status: 'purchased',
  unavailableNote: null,
  unitPrice: '100',
  paymentMethod: 'cash',
  ...over,
});
const split = (skuId: string, storeId: string, qty: string, over: Partial<Split> = {}): Split => ({
  runId: 'run',
  skuId,
  storeId,
  qty,
  deliveredAt: null,
  confirmedAt: null,
  ...over,
});
const expense = (id: string, over: Partial<Expense> = {}): Expense => ({
  id,
  label: 'Taxi',
  unitHint: null,
  qty: '1',
  unitPrice: '50',
  storeSplits: [],
  paymentMethod: 'cash',
  receiptPhotoUrl: null,
  reason: '',
  addedByMemberId: 'm',
  addedAt: '2026-11-12T08:00:00Z',
  ...over,
});
const NOW = Date.parse('2026-11-12T12:00:00Z');

describe('finishSummaryOf', () => {
  test('an empty run sums to nothing', () => {
    const s = finishSummaryOf(undefined, NOW);
    expect(s).toMatchObject({ skus: 0, stores: 0, total: 0, totalCash: 0, totalTransfer: 0 });
    expect(s.money).toEqual({ items: 0, expenses: 0, total: 0 });
    expect(s.byStore).toEqual([]);
  });

  test('purchased rows, line by line over the splits, cash and transfer apart', () => {
    const s = finishSummaryOf(
      {
        items: [
          item('tomato', { purchasedQty: '3', unitPrice: '10.005' }),
          item('onion', { purchasedQty: '2', unitPrice: '40', paymentMethod: 'transfer' }),
          item('salt', { status: 'pending', purchasedQty: null, unitPrice: null }),
        ],
        splits: [split('tomato', 'A', '1'), split('tomato', 'B', '2'), split('onion', 'A', '2')],
      },
      NOW,
    );
    expect(s.skus).toBe(2);
    expect(s.stores).toBe(2);
    // 10.01 + 20.01 (each line half-up to cents) + 80.
    expect(s.total).toBe(110.02);
    expect(s.totalCash).toBe(30.02);
    expect(s.totalTransfer).toBe(80);
    // No server figures: items are the sum less the expenses.
    expect(s.money).toEqual({ items: 110.02, expenses: 0, total: 110.02 });
  });

  test('rows the purchaser added are counted apart', () => {
    const s = finishSummaryOf(
      {
        items: [item('tomato'), item('bread', { addedByPurchaser: true, unitPrice: '25' })],
        splits: [split('tomato', 'A', '1'), split('bread', 'A', '1')],
      },
      NOW,
    );
    expect(s.addedSkus).toBe(1);
    expect(s.addedTotal).toBe(25);
  });

  test('expenses join the total and their method', () => {
    const s = finishSummaryOf(
      {
        items: [item('tomato')],
        splits: [split('tomato', 'A', '1')],
        expenses: [
          expense('e1', { unitPrice: '30' }),
          expense('e2', { unitPrice: '20', paymentMethod: 'transfer' }),
        ],
      },
      NOW,
    );
    expect(s.expensesCount).toBe(2);
    expect(s.expensesTotal).toBe(50);
    expect(s.total).toBe(150);
    expect(s.totalCash).toBe(130);
    expect(s.totalTransfer).toBe(20);
    expect(s.money).toEqual({ items: 100, expenses: 50, total: 150 });
  });

  test('the server money is the one shown when run.get sends it', () => {
    const s = finishSummaryOf(
      {
        items: [item('tomato')],
        splits: [split('tomato', 'A', '1')],
        money: { itemsTotal: '99.5', expensesTotal: '0.5', total: '100' },
      },
      NOW,
    );
    expect(s.money).toEqual({ items: 99.5, expenses: 0.5, total: 100 });
    // The breakdowns still come from the lines.
    expect(s.total).toBe(100);
  });

  test("each store's bill, largest first", () => {
    const s = finishSummaryOf(
      {
        items: [item('tomato', { purchasedQty: '3' })],
        splits: [split('tomato', 'A', '1'), split('tomato', 'B', '2')],
      },
      NOW,
    );
    expect(s.byStore.map((b) => [b.storeId, b.total])).toEqual([
      ['B', 200],
      ['A', 100],
    ]);
  });

  test('prices that repeat the last trip, and how many of those were old', () => {
    const s = finishSummaryOf(
      {
        items: [
          item('tomato'),
          item('onion', { unitPrice: '40' }),
          item('salt', { unitPrice: '7' }),
        ],
        splits: [],
        lastPriceBySku: { tomato: '100.00', onion: '40', salt: '8' },
        lastPriceObservedAtBySku: { tomato: '2026-11-11T08:00:00Z', onion: '2026-10-01T08:00:00Z' },
      },
      NOW,
    );
    expect(s.carriedOver).toBe(2);
    expect(s.carriedOverStale).toBe(1);
  });
});

describe('receiptShortfall', () => {
  test('lines signed for less, valued at the store price or the item price', () => {
    const r = receiptShortfall({
      items: [item('tomato', { unitPrice: '10' }), item('onion', { unitPrice: '40' })],
      splits: [
        split('tomato', 'A', '3', { confirmStatus: 'short', confirmReceivedQty: '1.5' }),
        split('onion', 'A', '2', {
          confirmStatus: 'quality',
          confirmReceivedQty: '1',
          unitPrice: '35',
        }),
        split('onion', 'B', '2', { confirmStatus: 'ok', confirmReceivedQty: '2' }),
        split('tomato', 'B', '1'),
      ],
    });
    expect(r.issues.map((sp) => `${sp.skuId}/${sp.storeId}`)).toEqual(['tomato/A', 'onion/A']);
    // 1.5 × 10 + 1 × 35.
    expect(r.missingValue).toBe(50);
  });

  test('a line that arrived in full or over adds nothing', () => {
    const r = receiptShortfall({
      items: [item('tomato', { unitPrice: '10' })],
      splits: [split('tomato', 'A', '1', { confirmStatus: 'wrong', confirmReceivedQty: '2' })],
    });
    expect(r.issues).toHaveLength(1);
    expect(r.missingValue).toBe(0);
  });

  test('no run, no issues', () => {
    expect(receiptShortfall(undefined)).toEqual({ issues: [], missingValue: 0 });
  });
});
