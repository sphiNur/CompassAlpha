/**
 * Pins what the preview card's "send" buttons actually put in a chat.
 *
 * There is no DOM test environment in apps/web, so this pure-function
 * suite is the only thing standing between a formatting change and what
 * lands in someone's Telegram. That is not hypothetical: the M3.45/M3.48
 * vendor-language feature was silently reverted by a layout refactor
 * with no test failing, which is why these builders were pulled out of
 * component closures in the first place.
 *
 * `buildSupplierText` has been through one full reversal, and the
 * history is worth keeping. On 2026-07-26 it was changed to merge
 * quantities across stores and drop the store names, reasoning that a
 * market stall owner should not receive our shop roster. The operator
 * reported that as a regression the next day. The reasoning was wrong
 * about what the message is FOR: it is not only a quote for the vendor,
 * it is the instruction for how the goods get divided when they arrive,
 * and merging destroyed exactly the part the purchaser needs while
 * standing at the scale. It also disagreed with the on-screen accordion,
 * which has always shown per-store sections with their own subtotals.
 *
 * The per-store split is the required behaviour. These tests hold it
 * there.
 */
import { describe, it, expect } from 'bun:test';
import { buildStoreText, buildSupplierText, formatLineForText } from '../shareText';
import type { ShareTextDeps } from '../shareText';
import type { PreviewLine, PreviewStoreGroup, PreviewSupplierGroup } from '../../types';

const CATALOG: Record<string, { name: string; unit: string }> = {
  'sku-tomato': { name: '西红柿', unit: '公斤' },
  'sku-onion': { name: '洋葱', unit: '公斤' },
  'sku-carrot': { name: '胡萝卜', unit: '公斤' },
};

const deps: ShareTextDeps = {
  resolveSku: (skuId) => CATALOG[skuId] ?? null,
  extrasLabel: '其他物品',
  notesLabel: '备注',
};

function line(over: Partial<PreviewLine> = {}): PreviewLine {
  return {
    id: over.id ?? 'l1',
    kind: over.kind ?? 'sku',
    // `??` would fold an explicitly-passed null back into the default,
    // and a null skuId is exactly what marks an off-catalog extra.
    skuId: 'skuId' in over ? over.skuId ?? null : 'sku-tomato',
    name: over.name ?? 'raw-name',
    qty: over.qty ?? '1',
    unit: over.unit ?? 'raw-unit',
    unitPrice: over.unitPrice ?? null,
    total: over.total ?? null,
    note: over.note,
  };
}

function store(
  storeId: string,
  storeName: string,
  items: PreviewLine[],
  legacyNote?: string,
): PreviewStoreGroup {
  return { storeId, storeName, items, total: 0, unknownCount: 0, legacyNote };
}

function supplier(stores: PreviewStoreGroup[]): PreviewSupplierGroup {
  return {
    supplierId: 'sup-1',
    supplierName: 'savza abat',
    contactPhone: null,
    contactTg: null,
    stores,
    total: 0,
    unknownCount: 0,
  };
}

describe('formatLineForText', () => {
  it('uses the catalog name + localized unit when the SKU resolves', () => {
    expect(formatLineForText(line({ qty: '2' }), deps)).toBe('西红柿: 2 公斤');
  });

  it('falls back to the line own name/unit for off-catalog extras', () => {
    const l = line({ kind: 'extra', skuId: null, name: '面包', unit: '个', qty: '3' });
    expect(formatLineForText(l, deps)).toBe('其他物品 · 面包: 3 个');
  });

  it('puts a note on its own indented line', () => {
    expect(formatLineForText(line({ qty: '1', note: '要熟的' }), deps)).toBe(
      '西红柿: 1 公斤\n  要熟的',
    );
  });
});

describe('buildStoreText', () => {
  it('KEEPS the store name — this string goes to that store own manager', () => {
    const g = store('s1', 'Eden-Magic-City', [line({ qty: '5' })]);
    const text = buildStoreText(g, deps);
    expect(text).toContain('Eden-Magic-City');
    expect(text).toContain('西红柿: 5 公斤');
  });

  it('keeps the extras marker — off-catalog is meaningful to a manager', () => {
    const text = buildStoreText(
      store('s1', 'Hotel-Uzbek', [
        line({ kind: 'extra', skuId: null, name: '面包', unit: '个' }),
      ]),
      deps,
    );
    expect(text).toContain('其他物品 · 面包');
  });

  it('appends the legacy note under the notes label', () => {
    const text = buildStoreText(store('s1', 'Hotel-Uzbek', [], '再买两箱水'), deps);
    expect(text).toContain('备注:');
    expect(text).toContain('再买两箱水');
  });
});

describe('buildSupplierText', () => {
  const threeStores = supplier([
    store('s1', 'Eden-Magic-City', [line({ id: 'a', qty: '5' })]),
    store('s2', 'Hotel-Uzbek', [line({ id: 'b', qty: '3' })]),
    store('s3', 'Eden-Seoul', [line({ id: 'c', qty: '3' })]),
  ]);

  it('keeps each store as its own labelled section', () => {
    expect(buildSupplierText(threeStores, deps)).toBe(
      [
        'savza abat',
        '',
        'Eden-Magic-City',
        '西红柿: 5 公斤',
        '',
        'Hotel-Uzbek',
        '西红柿: 3 公斤',
        '',
        'Eden-Seoul',
        '西红柿: 3 公斤',
      ].join('\n'),
    );
  });

  it('does NOT merge the same SKU across stores', () => {
    // 5 / 3 / 3 stay separate. A single "11 公斤" line would make the
    // purchaser re-derive the split from another screen while standing
    // at the scale with the vendor waiting.
    const text = buildSupplierText(threeStores, deps);
    expect(text).not.toContain('11 公斤');
    expect(text).toContain('西红柿: 5 公斤');
    expect(text).toContain('西红柿: 3 公斤');
  });

  it('names every store that contributes', () => {
    const text = buildSupplierText(threeStores, deps);
    for (const s of threeStores.stores) expect(text).toContain(s.storeName);
  });

  it('keeps distinct SKUs under the store that asked for them', () => {
    const g = supplier([
      store('s1', 'Eden-Magic-City', [line({ id: 'a', qty: '2' })]),
      store('s2', 'Hotel-Uzbek', [line({ id: 'b', skuId: 'sku-onion', qty: '4' })]),
    ]);
    expect(buildSupplierText(g, deps)).toBe(
      [
        'savza abat',
        '',
        'Eden-Magic-City',
        '西红柿: 2 公斤',
        '',
        'Hotel-Uzbek',
        '洋葱: 4 公斤',
      ].join('\n'),
    );
  });

  it('carries off-catalog extras with their own name and unit', () => {
    const g = supplier([
      store('s1', 'Eden-Magic-City', [
        line({ kind: 'extra', skuId: null, name: '面包', unit: '个', qty: '2' }),
      ]),
    ]);
    expect(buildSupplierText(g, deps)).toContain('面包: 2 个');
  });

  it('keeps each note attached to the store that wrote it', () => {
    // The case the merged version had to dedupe around: two shops
    // wanting the same item differently. Split by store, each
    // instruction sits under its own shop and nothing can collide.
    const g = supplier([
      store('s1', 'Eden-Magic-City', [
        line({
          id: 'a',
          kind: 'extra',
          skuId: null,
          name: '水',
          unit: '瓶',
          qty: '2',
          note: '要冰的',
        }),
      ]),
      store('s2', 'Hotel-Uzbek', [
        line({
          id: 'b',
          kind: 'extra',
          skuId: null,
          name: '水',
          unit: '瓶',
          qty: '1',
          note: '常温',
        }),
      ]),
    ]);
    expect(buildSupplierText(g, deps)).toBe(
      [
        'savza abat',
        '',
        'Eden-Magic-City',
        '其他物品 · 水: 2 瓶',
        '  要冰的',
        '',
        'Hotel-Uzbek',
        '其他物品 · 水: 1 瓶',
        '  常温',
      ].join('\n'),
    );
  });

  it('carries a store-level note under that store', () => {
    const g = supplier([store('s1', 'Eden-Seoul', [line({ qty: '1' })], '要新鲜的')]);
    const text = buildSupplierText(g, deps);
    expect(text).toContain('Eden-Seoul');
    expect(text).toContain('备注:');
    expect(text).toContain('要新鲜的');
  });

  it('leaves no trailing blank line', () => {
    const text = buildSupplierText(threeStores, deps);
    expect(text.endsWith('\n')).toBe(false);
    expect(text).toBe(text.trim());
  });

  it('passes a quantity through verbatim rather than summing it', () => {
    const g = supplier([store('s1', 'Eden-Magic-City', [line({ qty: '0.1' })])]);
    expect(buildSupplierText(g, deps)).toContain('西红柿: 0.1 公斤');
  });
});
