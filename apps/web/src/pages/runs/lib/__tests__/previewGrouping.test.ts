import { describe, expect, it } from 'bun:test';
import { groupStoreBySupplier } from '../previewGrouping';
import type { PreviewLine, PreviewStoreGroup } from '../../types';

function line(overrides: Partial<PreviewLine> = {}): PreviewLine {
  return {
    id: overrides.id ?? 'line',
    kind: overrides.kind ?? 'sku',
    skuId: 'skuId' in overrides ? (overrides.skuId ?? null) : 'sku-1',
    name: overrides.name ?? 'Tomato',
    qty: overrides.qty ?? '1',
    unit: overrides.unit ?? 'kg',
    unitPrice: 'unitPrice' in overrides ? (overrides.unitPrice ?? null) : '1000',
    total: 'total' in overrides ? (overrides.total ?? null) : 1000,
    supplierId: overrides.supplierId,
    supplierName: overrides.supplierName,
    note: overrides.note,
  };
}

function store(items: PreviewLine[]): PreviewStoreGroup {
  return {
    storeId: 'store-a',
    storeName: 'Store A',
    items,
    total: 0,
    unknownCount: 0,
  };
}

describe('groupStoreBySupplier', () => {
  it('groups rows by stall, totals each group, and leaves unassigned rows last', () => {
    const input = store([
      line({ id: '1', supplierId: 'savza', supplierName: 'Savza', total: 10 }),
      line({ id: '2', supplierId: 'zilale', supplierName: 'Zilale', total: 20 }),
      line({ id: '3', supplierId: 'savza', supplierName: 'Savza', total: 30 }),
      line({ id: '4', supplierId: null, supplierName: null, total: null, unitPrice: null }),
      line({ id: '5', kind: 'extra', skuId: null, total: null, unitPrice: null }),
    ]);

    const groups = groupStoreBySupplier(input, 'Unassigned');

    expect(groups.map((group) => group.supplierName)).toEqual(['Savza', 'Zilale', 'Unassigned']);
    expect(groups[0]).toMatchObject({ total: 40, unknownCount: 0 });
    expect(groups[0]!.items.map((item) => item.id)).toEqual(['1', '3']);
    expect(groups[1]).toMatchObject({ total: 20, unknownCount: 0 });
    expect(groups[2]).toMatchObject({ total: 0, unknownCount: 2 });
    expect(groups[2]!.items.map((item) => item.id)).toEqual(['4', '5']);
  });

  it('does not mutate the source store or its item order', () => {
    const input = store([
      line({ id: '1', supplierId: 'b', supplierName: 'B' }),
      line({ id: '2', supplierId: 'a', supplierName: 'A' }),
    ]);

    groupStoreBySupplier(input, 'Unassigned');

    expect(input.items.map((item) => item.id)).toEqual(['1', '2']);
  });
});
