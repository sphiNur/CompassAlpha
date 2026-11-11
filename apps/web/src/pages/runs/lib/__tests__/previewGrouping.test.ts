import { describe, expect, it } from 'bun:test';
import { groupStoreBySupplier, tallyPreviewLine } from '../previewGrouping';
import type { PreviewLine } from '../../types';
import { previewLine, previewStore } from './previewFixtures';

const line = (over: Partial<PreviewLine> = {}) =>
  previewLine({
    id: 'line',
    skuId: 'sku-1',
    name: 'Tomato',
    unit: 'kg',
    unitPrice: '1000',
    total: 1000,
    ...over,
  });

const store = (items: PreviewLine[]) => previewStore('store-a', items, { storeName: 'Store A' });

describe('groupStoreBySupplier', () => {
  it('groups rows by stall, totals each group, and leaves unassigned rows last', () => {
    const input = store([
      line({ id: '1', supplierId: 'alpha', supplierName: 'Alpha', total: 10 }),
      line({ id: '2', supplierId: 'bravo', supplierName: 'Bravo', total: 20 }),
      line({ id: '3', supplierId: 'alpha', supplierName: 'Alpha', total: 30 }),
      line({ id: '4', supplierId: null, supplierName: null, total: null, unitPrice: null }),
      line({ id: '5', kind: 'extra', skuId: null, total: null, unitPrice: null }),
    ]);

    const groups = groupStoreBySupplier(input, 'Unassigned');

    expect(groups.map((group) => group.supplierName)).toEqual(['Alpha', 'Bravo', 'Unassigned']);
    expect(groups[0]).toMatchObject({ total: 40, unknownCount: 0 });
    expect(groups[0]!.items.map((item) => item.id)).toEqual(['1', '3']);
    expect(groups[1]).toMatchObject({ total: 20, unknownCount: 0 });
    expect(groups[2]).toMatchObject({ total: 0, unknownCount: 2 });
    expect(groups[2]!.items.map((item) => item.id)).toEqual(['4', '5']);
  });

  it("adds a stall's subtotal in whole cents, like the store total (RUNWEB1-16)", () => {
    expect(0.1 + 0.2).not.toBe(0.3); // what float += gave
    const input = store([
      line({ id: '1', supplierId: 'alpha', supplierName: 'Alpha', total: 0.1 }),
      line({ id: '2', supplierId: 'alpha', supplierName: 'Alpha', total: 0.2 }),
    ]);
    expect(groupStoreBySupplier(input, 'Unassigned')[0]!.total).toBe(0.3);
  });

  it('sorts stalls in the UI language (RUNWEB2-30)', () => {
    const input = store([
      line({ id: '1', supplierId: 't', supplierName: '土豆摊' }),
      line({ id: '2', supplierId: 'h', supplierName: '胡家摊' }),
    ]);
    const groups = groupStoreBySupplier(input, '未分配', 'zh');
    expect(groups.map((group) => group.supplierName)).toEqual(['胡家摊', '土豆摊']);
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

describe('tallyPreviewLine (RUNWEB1-16 / RUNWEB2-13)', () => {
  it('adds a priced line in cents and counts an unpriced one', () => {
    const group = { total: 0, unknownCount: 0 };
    for (const total of [0.1, 0.2, null, 1004.99]) tallyPreviewLine(group, { total });
    expect(group).toEqual({ total: 1005.29, unknownCount: 1 });
  });
});
