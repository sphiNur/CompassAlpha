import { describe, expect, test } from 'bun:test';
import {
  inventoryDraftChanged,
  knownMovementReason,
  signedDelta,
  skusWithoutLevel,
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
  test('an empty or zero quantity is missing first', () => {
    expect(wastageMissing('', 'spoiled', read)).toBe('qty');
    expect(wastageMissing('0', 'spoiled', read)).toBe('qty');
    expect(wastageMissing('abc', 'spoiled', read)).toBe('qty');
  });
  test('then the reason', () => {
    expect(wastageMissing('1,5', '  ', read)).toBe('note');
  });
  test('a quantity and a reason can be saved', () => {
    expect(wastageMissing('1.5', 'spoiled', read)).toBeNull();
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
