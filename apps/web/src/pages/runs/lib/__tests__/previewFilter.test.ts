/**
 * Pins the preview name filter — the escape hatch that makes
 * collapse-by-default survivable in a market.
 */
import { describe, it, expect } from 'bun:test';
import { normalizeQuery } from '../../../../lib/searchMatch';
import {
  filterStoreGroups,
  filterSupplierGroups,
  countStoreLines,
  countSupplierLines,
} from '../previewFilter';
import type { PreviewLine, PreviewStoreGroup, PreviewSupplierGroup } from '../../types';

function line(over: Partial<PreviewLine> = {}): PreviewLine {
  return {
    id: over.id ?? 'l1',
    kind: over.kind ?? 'sku',
    skuId: 'skuId' in over ? over.skuId ?? null : 'sku-1',
    name: over.name ?? 'Tomato',
    qty: over.qty ?? '1',
    unit: over.unit ?? 'kg',
    unitPrice: over.unitPrice ?? null,
    total: over.total ?? null,
    note: over.note,
    supplierId: over.supplierId,
    supplierName: over.supplierName,
  };
}

function store(
  storeId: string,
  items: PreviewLine[],
  legacyNote?: string,
): PreviewStoreGroup {
  return { storeId, storeName: `Store-${storeId}`, items, total: 0, unknownCount: 0, legacyNote };
}

function supplier(supplierId: string | null, stores: PreviewStoreGroup[]): PreviewSupplierGroup {
  return {
    supplierId,
    supplierName: supplierId ?? 'unassigned',
    contactPhone: null,
    contactTg: null,
    stores,
    total: 0,
    unknownCount: 0,
  };
}

const q = (s: string) => normalizeQuery(s) ?? [];

describe('filterStoreGroups', () => {
  const groups = [
    store('a', [
      line({ id: '1', name: 'Tomato', supplierName: 'savza abat' }),
      line({ id: '2', name: 'Onion', supplierName: 'zilale' }),
    ]),
    store('b', [line({ id: '3', name: 'Cabbage', supplierName: 'savza abat' })]),
  ];

  it('returns everything when the query is empty', () => {
    expect(countStoreLines(filterStoreGroups(groups, []))).toBe(3);
  });

  it('keeps only matching lines and drops emptied groups', () => {
    const out = filterStoreGroups(groups, q('onion'));
    expect(out).toHaveLength(1);
    expect(out[0]!.storeId).toBe('a');
    expect(out[0]!.items.map((l) => l.name)).toEqual(['Onion']);
  });

  it('matches the STALL name too, across stores', () => {
    // "what am I buying at this stall" — the by-store view's blind spot.
    const out = filterStoreGroups(groups, q('savza'));
    expect(countStoreLines(out)).toBe(2);
    expect(out.map((g) => g.storeId)).toEqual(['a', 'b']);
  });

  it('tolerates a typo, because this is typed one-handed', () => {
    expect(countStoreLines(filterStoreGroups(groups, q('tomto')))).toBe(1);
  });

  it('is case-insensitive', () => {
    expect(countStoreLines(filterStoreGroups(groups, q('TOMATO')))).toBe(1);
  });

  // Documented, not desired: the shared matcher's typo tolerance also
  // pulls in real words one edit away, so "tomato" surfaces "potato".
  // That is lib/searchMatch's behaviour and OrderPage has always had it;
  // recorded here so the preview's own tests do not accidentally pin a
  // fixture that hides it.
  it('also returns near-neighbour words (fuzzy matcher, shared with OrderPage)', () => {
    const g = [
      store('a', [
        line({ id: '1', name: 'Tomato' }),
        line({ id: '2', name: 'Potato' }),
      ]),
    ];
    expect(countStoreLines(filterStoreGroups(g, q('tomato')))).toBe(2);
  });

  it('returns nothing when nothing matches', () => {
    expect(filterStoreGroups(groups, q('zzzz'))).toEqual([]);
  });

  it('drops the store-wide legacy note from a filtered group', () => {
    // It describes the whole store; showing it beside three filtered
    // rows would imply it is about them.
    const withNote = [store('a', [line({ id: '1', name: 'Tomato' })], 'buy extra bread')];
    expect(withNote[0]!.legacyNote).toBe('buy extra bread');
    expect(filterStoreGroups(withNote, q('tomato'))[0]!.legacyNote).toBeUndefined();
  });

  it('does not mutate the input groups', () => {
    const before = groups[0]!.items.length;
    filterStoreGroups(groups, q('onion'));
    expect(groups[0]!.items).toHaveLength(before);
  });

  it('searches extra haystack fields when given', () => {
    const g = [store('a', [line({ id: '1', name: 'Tomato', skuId: 'sku-x' })])];
    // e.g. the SKU's other-language names, supplied by the caller.
    const out = filterStoreGroups(g, q('помидор'), () => ['Помидор']);
    expect(countStoreLines(out)).toBe(1);
  });
});

describe('filterSupplierGroups', () => {
  const groups = [
    supplier('sup-1', [store('a', [line({ id: '1', name: 'Tomato' })])]),
    supplier('sup-2', [
      store('a', [line({ id: '2', name: 'Onion' })]),
      store('b', [line({ id: '3', name: 'Tomato' })]),
    ]),
  ];

  it('returns everything when the query is empty', () => {
    expect(countSupplierLines(filterSupplierGroups(groups, []))).toBe(3);
  });

  it('filters through both levels and drops emptied stores and suppliers', () => {
    const out = filterSupplierGroups(groups, q('onion'));
    expect(out).toHaveLength(1);
    expect(out[0]!.supplierId).toBe('sup-2');
    expect(out[0]!.stores).toHaveLength(1);
    expect(out[0]!.stores[0]!.storeId).toBe('a');
  });

  it('keeps a match in every supplier that has one', () => {
    const out = filterSupplierGroups(groups, q('tomato'));
    expect(out.map((g) => g.supplierId)).toEqual(['sup-1', 'sup-2']);
    expect(countSupplierLines(out)).toBe(2);
  });

  it('returns nothing when nothing matches', () => {
    expect(filterSupplierGroups(groups, q('zzzz'))).toEqual([]);
  });

  it('does not mutate the input', () => {
    filterSupplierGroups(groups, q('onion'));
    expect(groups[1]!.stores).toHaveLength(2);
  });
});
