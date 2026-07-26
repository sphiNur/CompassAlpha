/**
 * Pins the preview header's counts.
 *
 * The load-bearing cases are the two that a naive implementation gets
 * wrong in opposite directions: counting ROWS where items are meant
 * (a SKU three shops want is one thing to buy, not three) and counting
 * ITEMS where rows are meant (the money total is per-store quantities).
 */
import { describe, it, expect } from 'bun:test';
import { computePreviewStats } from '../previewStats';
import type { PreviewLine, PreviewStoreGroup } from '../../types';

function line(over: Partial<PreviewLine> = {}): PreviewLine {
  return {
    id: over.id ?? 'l1',
    kind: over.kind ?? 'sku',
    skuId: 'skuId' in over ? over.skuId ?? null : 'sku-tomato',
    name: over.name ?? 'raw-name',
    qty: over.qty ?? '1',
    unit: over.unit ?? 'raw-unit',
    unitPrice: over.unitPrice ?? null,
    total: over.total ?? null,
    note: over.note,
  };
}

function store(storeId: string, items: PreviewLine[]): PreviewStoreGroup {
  return { storeId, storeName: `Store-${storeId}`, items, total: 0, unknownCount: 0 };
}

const allAssigned = () => true;
const noneAssigned = () => false;

describe('computePreviewStats', () => {
  it('counts one item, not three rows, when three stores want the same SKU', () => {
    const byStore = [
      store('a', [line({ id: '1', total: 500 })]),
      store('b', [line({ id: '2', total: 300 })]),
      store('c', [line({ id: '3', total: 300 })]),
    ];
    const s = computePreviewStats(byStore, allAssigned);
    expect(s.total).toBe(1);
    expect(s.known).toBe(1);
    // ...but the MONEY sums every row.
    expect(s.knownTotal).toBe(1100);
  });

  it('counts distinct SKUs separately', () => {
    const byStore = [
      store('a', [
        line({ id: '1', skuId: 'sku-tomato', total: 100 }),
        line({ id: '2', skuId: 'sku-onion', total: 200 }),
      ]),
    ];
    const s = computePreviewStats(byStore, allAssigned);
    expect(s.total).toBe(2);
    expect(s.knownTotal).toBe(300);
  });

  it('treats a null line total as unpriced and leaves it out of the sum', () => {
    const byStore = [
      store('a', [
        line({ id: '1', skuId: 'sku-tomato', total: 100 }),
        line({ id: '2', skuId: 'sku-onion', total: null }),
      ]),
    ];
    const s = computePreviewStats(byStore, allAssigned);
    expect(s.total).toBe(2);
    expect(s.known).toBe(1);
    expect(s.knownTotal).toBe(100);
  });

  it('merges off-catalog extras across stores by name + unit', () => {
    const extra = (id: string) =>
      line({ id, kind: 'extra', skuId: null, name: '面包', unit: '个', total: 50 });
    const byStore = [store('a', [extra('1')]), store('b', [extra('2')])];
    const s = computePreviewStats(byStore, allAssigned);
    expect(s.total).toBe(1);
    expect(s.knownTotal).toBe(100);
  });

  it('keeps same-name extras with different units apart', () => {
    const byStore = [
      store('a', [line({ id: '1', kind: 'extra', skuId: null, name: '水', unit: '瓶' })]),
      store('b', [line({ id: '2', kind: 'extra', skuId: null, name: '水', unit: '箱' })]),
    ];
    expect(computePreviewStats(byStore, allAssigned).total).toBe(2);
  });

  it('counts unassigned SKUs once, however many stores want them', () => {
    const byStore = [
      store('a', [line({ id: '1', skuId: 'sku-tomato' })]),
      store('b', [line({ id: '2', skuId: 'sku-tomato' })]),
      store('c', [line({ id: '3', skuId: 'sku-onion' })]),
    ];
    expect(computePreviewStats(byStore, noneAssigned).noSupplier).toBe(2);
  });

  it('never counts an off-catalog extra as missing a stall', () => {
    // Extras have no skuId and so can never carry a preferred-supplier
    // link. If they counted, the chip could never reach zero.
    const byStore = [
      store('a', [
        line({ id: '1', kind: 'extra', skuId: null, name: '面包', unit: '个' }),
        line({ id: '2', kind: 'extra', skuId: null, name: '水', unit: '瓶' }),
      ]),
    ];
    expect(computePreviewStats(byStore, noneAssigned).noSupplier).toBe(0);
  });

  it('reports only the unassigned half of a mixed run', () => {
    const assigned = (skuId: string) => skuId === 'sku-tomato';
    const byStore = [
      store('a', [
        line({ id: '1', skuId: 'sku-tomato' }),
        line({ id: '2', skuId: 'sku-onion' }),
        line({ id: '3', skuId: 'sku-carrot' }),
      ]),
    ];
    expect(computePreviewStats(byStore, assigned).noSupplier).toBe(2);
  });

  it('returns all zeroes for an empty preview', () => {
    expect(computePreviewStats([], allAssigned)).toEqual({
      total: 0,
      known: 0,
      noSupplier: 0,
      knownTotal: 0,
    });
  });

  it('handles a store group with no items', () => {
    const s = computePreviewStats([store('a', [])], allAssigned);
    expect(s.total).toBe(0);
    expect(s.known).toBe(0);
  });
});
