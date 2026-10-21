import { describe, expect, test } from 'bun:test';
import { knownMovementReason, signedDelta, skusWithoutLevel } from '../inventoryHelpers';

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
