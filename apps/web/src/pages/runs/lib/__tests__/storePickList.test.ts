/**
 * 2026-10-21 FE-03 (F3-01): delivering-phase per-store pick list.
 */
import { describe, it, expect } from 'bun:test';
import { buildStorePickList } from '../storePickList';

const items = [
  { skuId: 'apple', status: 'purchased', unitPrice: '1000' },
  { skuId: 'onion', status: 'purchased', unitPrice: '500' },
  { skuId: 'melon', status: 'unavailable', unitPrice: null },
];
const splits = [
  { skuId: 'apple', storeId: 'A', qty: '2', unitPrice: null },
  { skuId: 'apple', storeId: 'B', qty: '3', unitPrice: null },
  // Per-store price override for B.
  { skuId: 'onion', storeId: 'B', qty: '4', unitPrice: '600' },
];
const demand = [
  { skuId: 'apple', storeId: 'A', qty: '2' },
  { skuId: 'melon', storeId: 'A', qty: '1' },
  { skuId: 'onion', storeId: 'B', qty: '4' },
];

describe('buildStorePickList', () => {
  it('lists only this store’s splits, priced with overrides', () => {
    const b = buildStorePickList({ storeId: 'B', items, splits, demand });
    expect(b.lines).toEqual([
      { skuId: 'apple', qty: '3', lineTotal: 3000 },
      { skuId: 'onion', qty: '4', lineTotal: 2400 },
    ]);
    expect(b.total).toBe(5400);
    expect(b.unavailable).toEqual([]);
  });

  it('lists unavailable SKUs the store ordered separately', () => {
    const a = buildStorePickList({ storeId: 'A', items, splits, demand });
    expect(a.lines).toEqual([{ skuId: 'apple', qty: '2', lineTotal: 2000 }]);
    expect(a.unavailable).toEqual([{ skuId: 'melon', qty: '1' }]);
    expect(a.total).toBe(2000);
  });

  it('drops zero-qty splits and returns null total when a line has no price', () => {
    const out = buildStorePickList({
      storeId: 'A',
      items: [{ skuId: 'x', status: 'purchased', unitPrice: null }],
      splits: [
        { skuId: 'x', storeId: 'A', qty: '1', unitPrice: null },
        { skuId: 'y', storeId: 'A', qty: '0', unitPrice: '5' },
      ],
    });
    expect(out.lines).toEqual([{ skuId: 'x', qty: '1', lineTotal: null }]);
    expect(out.total).toBeNull();
  });
});
