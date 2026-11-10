import { describe, expect, test } from 'bun:test';
import { lineAmount, sumMoney } from '@compass/contracts/money';
import { topUpPrefill, topUpRevision, type TopUpRevision } from '../topUp';

const paid = (r: TopUpRevision) =>
  sumMoney(r.storeSplits.map((sp) => lineAmount(sp.qty, sp.unitPrice ?? r.unitPrice)));

describe('topUpRevision (DX-BUY-2)', () => {
  test('a new store gets the top-up price; the earlier batch keeps its price', () => {
    // Butter: 2 × 80,000 for CK before, the new order is RH's 2 at 82,000.
    const r = topUpRevision({
      item: { unitPrice: '80000', paymentMethod: 'cash' },
      base: [{ storeId: 'CK', qty: '2', unitPrice: '80000', paymentMethod: 'cash' }],
      next: new Map([
        ['CK', '2'],
        ['RH', '2'],
      ]),
      topUpPrice: '82000',
      topUpMethod: 'transfer',
    })!;
    expect(r).toEqual({
      unitPrice: '80000',
      paymentMethod: 'cash',
      actualQty: '4',
      storeSplits: [
        { storeId: 'CK', qty: '2' },
        { storeId: 'RH', qty: '2', unitPrice: '82000', paymentMethod: 'transfer' },
      ],
    });
    // What was actually paid, not 4 × 82,000 = 328,000.
    expect(paid(r)).toBe('324000.00');
  });

  test('more for the same store is priced at the weighted price of both batches', () => {
    const r = topUpRevision({
      item: { unitPrice: '80000', paymentMethod: 'cash' },
      base: [{ storeId: 'CK', qty: '2', unitPrice: '80000', paymentMethod: 'cash' }],
      next: new Map([['CK', '4']]),
      topUpPrice: '82000',
      topUpMethod: 'cash',
    })!;
    expect(r.storeSplits).toEqual([{ storeId: 'CK', qty: '4', unitPrice: '81000' }]);
    expect(r.actualQty).toBe('4');
    expect(paid(r)).toBe('324000.00');
  });

  test('a weighted price that is not whole cents is rounded half-up', () => {
    const r = topUpRevision({
      item: { unitPrice: '10', paymentMethod: 'cash' },
      base: [{ storeId: 'CK', qty: '1', unitPrice: '10', paymentMethod: 'cash' }],
      next: new Map([['CK', '3']]),
      topUpPrice: '11',
      topUpMethod: 'cash',
    })!;
    // (10 + 22) / 3 = 10.666… → 10.67; 3 × 10.67 = 32.01 against 32 paid.
    expect(r.storeSplits[0]!.unitPrice).toBe('10.67');
  });

  test('same price: nothing changes but the quantity', () => {
    const r = topUpRevision({
      item: { unitPrice: '80000', paymentMethod: 'cash' },
      base: [{ storeId: 'CK', qty: '2', unitPrice: '80000', paymentMethod: 'cash' }],
      next: new Map([
        ['CK', '2.5'],
        ['RH', '1'],
      ]),
      topUpPrice: '80000',
      topUpMethod: 'cash',
    })!;
    expect(r.storeSplits).toEqual([
      { storeId: 'CK', qty: '2.5' },
      { storeId: 'RH', qty: '1' },
    ]);
    expect(r.actualQty).toBe('3.5');
  });

  test('not a top-up: a store went down or nothing was added', () => {
    const base = [{ storeId: 'CK', qty: '2', unitPrice: '80000', paymentMethod: 'cash' as const }];
    const item = { unitPrice: '80000', paymentMethod: 'cash' as const };
    expect(
      topUpRevision({ item, base, next: new Map([['CK', '1']]), topUpPrice: '1', topUpMethod: 'cash' }),
    ).toBeNull();
    expect(
      topUpRevision({ item, base, next: new Map([['CK', '2']]), topUpPrice: '1', topUpMethod: 'cash' }),
    ).toBeNull();
  });

  test('a store whose field was cleared has nothing now: not a top-up (RUNWEB2-08)', () => {
    // A 2 and B 2 before; the sheet clears A and sets B to 4. It shows a
    // total of 4; the old code kept A's 2 and saved 6.
    const r = topUpRevision({
      item: { unitPrice: '80000', paymentMethod: 'cash' },
      base: [
        { storeId: 'A', qty: '2', unitPrice: '80000', paymentMethod: 'cash' },
        { storeId: 'B', qty: '2', unitPrice: '80000', paymentMethod: 'cash' },
      ],
      next: new Map([['B', '4']]),
      topUpPrice: '82000',
      topUpMethod: 'cash',
    });
    // A went down, so the caller saves an ordinary revision of what the
    // sheet shows.
    expect(r).toBeNull();
  });
});

describe('topUpPrefill (RUNWEB1-03)', () => {
  test('fills uncovered demand in order, in whole thousandths', () => {
    const r = topUpPrefill({
      splits: new Map([['A', '0.1']]),
      demand: [
        { storeId: 'A', qty: '0.4' },
        { storeId: 'B', qty: '0.3' },
      ],
      extra: '0.6',
    });
    // As floats B was "0.29999999999999993".
    expect([...r.splits]).toEqual([
      ['A', '0.4'],
      ['B', '0.3'],
    ]);
    expect(r.actualQty).toBe('0.7');
  });

  test('what no demand asks for stays on the total', () => {
    const r = topUpPrefill({
      splits: new Map([['A', '0.3']]),
      demand: [{ storeId: 'A', qty: '0.9' }],
      extra: '1',
    });
    // As floats A was "0.9000000000000001".
    expect(r.splits.get('A')).toBe('0.9');
    expect(r.actualQty).toBe('1.3');
  });

  test('nothing extra leaves the sheet as it was', () => {
    const r = topUpPrefill({
      splits: new Map([['A', '2']]),
      demand: [{ storeId: 'A', qty: '3' }],
      extra: null,
    });
    expect([...r.splits]).toEqual([['A', '2']]);
    expect(r.actualQty).toBe('2');
  });
});

describe('top-up quantities a number field can hold', () => {
  test('"1e3" reads as 1000, as Number did', () => {
    const r = topUpPrefill({ splits: new Map([['A', '1e3']]), demand: [], extra: '1' });
    expect(r.actualQty).toBe('1001');
  });
});
