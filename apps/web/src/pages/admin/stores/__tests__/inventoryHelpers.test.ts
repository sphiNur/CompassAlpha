import { describe, expect, test } from 'bun:test';
import { readDecimalText } from '@compass/ui';
import {
  inventoryDraftChanged,
  knownMovementReason,
  signedDelta,
  skusWithoutLevel,
  sortLevelRows,
  stockAfterWastage,
  stocktakeDiff,
  stocktakePrefill,
  wastageMissing,
} from '../inventoryHelpers';

describe('skusWithoutLevel', () => {
  test('keeps active SKUs that have no level row at this store', () => {
    const skus = [
      { id: 'a', isArchived: false },
      { id: 'b', isArchived: false },
      { id: 'c', isArchived: true },
      { id: 'd' },
    ];
    expect(skusWithoutLevel(skus, [{ skuId: 'a' }]).map((s) => s.id)).toEqual(['b', 'd']);
  });
  test('empty store → every active SKU is a candidate', () => {
    expect(skusWithoutLevel([{ id: 'x' }], [])).toEqual([{ id: 'x' }]);
  });
});

describe('knownMovementReason', () => {
  test('known reasons pass, unknown → null', () => {
    expect(knownMovementReason('consumption_reversed')).toBe('consumption_reversed');
    expect(knownMovementReason('mystery')).toBeNull();
  });
});

describe('signedDelta', () => {
  test('sign and magnitude', () => {
    expect(signedDelta('1.500')).toEqual({ sign: '+', abs: '1.5' });
    expect(signedDelta('-0.250')).toEqual({ sign: '-', abs: '0.25' });
    expect(signedDelta('0.000')).toEqual({ sign: '', abs: '0' });
  });
});

describe('wastageMissing (CMP-INV-3)', () => {
  const read = (raw: string) =>
    /^\d*([.,]\d*)?$/.test(raw.trim())
      ? ({ ok: true, value: raw.trim().replace(',', '.') } as const)
      : ({ ok: false } as const);
  test('an empty quantity is missing first', () => {
    expect(wastageMissing('', 'spoiled', read)).toBe('qty');
  });
  test('a quantity the server refuses says why (CONF-10)', () => {
    expect(wastageMissing('0', 'spoiled', read)).toBe('format');
    expect(wastageMissing('abc', 'spoiled', read)).toBe('format');
    expect(wastageMissing('0.0001', 'spoiled', read)).toBe('format');
    expect(wastageMissing('100000000', 'spoiled', read)).toBe('tooLarge');
  });
  test('then the reason', () => {
    expect(wastageMissing('1,5', '  ', read)).toBe('note');
  });
  test('a quantity and a reason can be saved', () => {
    expect(wastageMissing('1.5', 'spoiled', read)).toBeNull();
  });
});

describe('stockAfterWastage / stocktakeDiff (review ADM2-37)', () => {
  test('exact to the thousandth: 0.3 − 0.1 is 0.2, not 0.19999999999999998', () => {
    expect(stockAfterWastage('0.300', '0,1', readDecimalText)).toBe('0.2');
    expect(stocktakeDiff('0,3', '0.100', readDecimalText)).toBe('0.2');
  });
  test('below zero, and back to nothing', () => {
    expect(stockAfterWastage('1.000', '1,5', readDecimalText)).toBe('-0.5');
    expect(stocktakeDiff('2', '2.000', readDecimalText)).toBe('0');
  });
  test('the amount is read like every number field: grouped thousands too', () => {
    // "1 000,5" — a space groups thousands, the comma is the decimal mark.
    expect(stockAfterWastage('2000', '1 000,5', readDecimalText)).toBe('999.5');
  });
  test('nothing until the amount reads; a missing stored figure counts as 0', () => {
    expect(stockAfterWastage('5', '', readDecimalText)).toBeNull();
    expect(stockAfterWastage('5', 'abc', readDecimalText)).toBeNull();
    expect(stocktakeDiff('1.5', '', readDecimalText)).toBe('1.5');
  });
});

describe('inventoryDraftChanged (CMP-INV-2)', () => {
  const empty = { target: '', wasteQty: '', note: '' };
  test('a stocktake still showing the system count has no changes', () => {
    expect(inventoryDraftChanged({ kind: 'stocktake', current: '4' }, { ...empty, target: '4' })).toBe(false);
  });
  test('a typed count or note is a change', () => {
    expect(inventoryDraftChanged({ kind: 'stocktake', current: '4' }, { ...empty, target: '3' })).toBe(true);
    expect(inventoryDraftChanged({ kind: 'wastage' }, { ...empty, note: 'broken' })).toBe(true);
    expect(inventoryDraftChanged({ kind: 'wastage' }, { ...empty, wasteQty: '2' })).toBe(true);
  });
  test('an untouched wastage sheet or no sheet has none', () => {
    expect(inventoryDraftChanged({ kind: 'wastage' }, empty)).toBe(false);
    expect(inventoryDraftChanged(null, empty)).toBe(false);
  });
});

describe('stocktakePrefill (DX-INV-1 / DX-INV-7)', () => {
  test('starts from the system count as an editable number', () => {
    expect(stocktakePrefill('20.000')).toBe('20');
    expect(stocktakePrefill('0.250')).toBe('0.25');
    expect(stocktakePrefill('0')).toBe('0');
  });
  test('starts empty when the system count is negative', () => {
    expect(stocktakePrefill('-0.500')).toBe('');
  });
  test('the untouched prefill is not a change', () => {
    const draft = { target: '20', wasteQty: '', note: '' };
    expect(inventoryDraftChanged({ kind: 'stocktake', current: '20.000' }, draft)).toBe(false);
    expect(
      inventoryDraftChanged({ kind: 'stocktake', current: '-0.500' }, { ...draft, target: '' }),
    ).toBe(false);
  });
});

describe('sortLevelRows (DX-INV-3)', () => {
  test('negative stock comes first, then by name', () => {
    const rows = [
      { name: 'Potato', onHandNum: 20 },
      { name: 'Apple', onHandNum: 3 },
      { name: 'Onion', onHandNum: -0.2 },
      { name: 'Banana', onHandNum: 0 },
      { name: 'Milk', onHandNum: -1 },
    ];
    expect(sortLevelRows(rows, 'en').map((r) => r.name)).toEqual([
      'Milk',
      'Onion',
      'Apple',
      'Banana',
      'Potato',
    ]);
  });
});
