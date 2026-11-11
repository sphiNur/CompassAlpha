/**
 * Review ADM2-10: Finance's three views come from one grouping.
 */
import { describe, expect, test } from 'bun:test';
import {
  EXPENSE_GROUP,
  NO_SUPPLIER_GROUP,
  groupFinanceLines,
  type FinanceLineLike,
} from '../finance/financeGroups';

const line = (over: Partial<FinanceLineLike>): FinanceLineLike => ({
  runDate: '2026-11-10',
  storeId: 'store-a',
  supplierId: 'stall-1',
  kind: 'item',
  paymentMethod: 'cash',
  lineTotal: '1000.00',
  ...over,
});

const LINES: FinanceLineLike[] = [
  line({ lineTotal: '0.10' }),
  line({ lineTotal: '0.20', paymentMethod: 'transfer' }),
  line({ runDate: '2026-11-11', storeId: 'store-b', supplierId: null, lineTotal: '5000.00' }),
  line({ runDate: '2026-11-09', kind: 'expense', supplierId: null, lineTotal: '300.00' }),
  line({ runDate: '2026-11-11', storeId: 'store-b', supplierId: 'stall-2', lineTotal: null }),
];

describe('groupFinanceLines', () => {
  test('by day: newest first, cash and transfer apart, in whole cents', () => {
    const days = groupFinanceLines(LINES, 'daily');
    expect(days.map((g) => g.key)).toEqual(['2026-11-11', '2026-11-10', '2026-11-09']);
    const tenth = days[1]!;
    expect([tenth.cash, tenth.transfer, tenth.lines.length]).toEqual([0.1, 0.2, 2]);
  });

  test('by stall: expenses apart from items with no stall, most money first', () => {
    const stalls = groupFinanceLines(LINES, 'bySupplier');
    expect(stalls.map((g) => g.key)).toEqual([
      NO_SUPPLIER_GROUP,
      EXPENSE_GROUP,
      'stall-1',
      'stall-2',
    ]);
  });

  test('a line without an amount is counted, and adds no money', () => {
    const stores = groupFinanceLines(LINES, 'byStore');
    const b = stores.find((g) => g.key === 'store-b')!;
    expect([b.cash, b.unpriced, b.lines.length]).toEqual([5000, 1, 2]);
  });

  test('no lines, no groups', () => {
    expect(groupFinanceLines([], 'daily')).toEqual([]);
  });
});
