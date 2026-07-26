/**
 * Pins the store-vs-vendor disclosure boundary for the preview card's
 * "send" buttons.
 *
 * Before 2026-07-26 `buildSupplierText` pushed every `storeName` as a
 * section header, so each send handed a market stall owner our full shop
 * roster and told them which shop wanted what. There is no DOM test
 * environment in apps/web, so this pure-function suite is the only thing
 * standing between that regression and a vendor's Telegram chat.
 *
 * HOW THIS SUITE IS BUILT, AND WHY
 *
 * The first cut of this file had a single `not.toContain` on a fixture
 * where all stores wanted the SAME sku — so every line merged and there
 * was nothing left to attribute. An implementation that re-attached a
 * store name only to lines with exactly ONE contributing store passed
 * all sixteen assertions. That is not a contrived shape: a vendor who
 * sells tomatoes to one shop and onions to another is the normal case.
 *
 * So: `expectNoStoreNames` runs at the end of EVERY buildSupplierText
 * case, store names are distinctive multi-character strings, and
 * `mixedVendor` deliberately combines a merging sku with two
 * single-store skus — the shape that escaped before.
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

/**
 * The boundary assertion. Call this on the output of EVERY
 * buildSupplierText case — a targeted leak only shows up on the fixture
 * shape the author didn't think of.
 */
function expectNoStoreNames(text: string, group: PreviewSupplierGroup): void {
  for (const s of group.stores) {
    expect(text).not.toContain(s.storeName);
  }
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

  /**
   * The shape that defeated the first version of this suite: one vendor,
   * two stores, one sku that MERGES across both and two skus that each
   * come from exactly one store. Any implementation that attributes
   * "unambiguous" lines to their single contributing store leaks here.
   */
  const mixedVendor = supplier([
    store('s1', 'Eden-Magic-City', [
      line({ id: 'a', skuId: 'sku-tomato', qty: '5' }),
      line({ id: 'b', skuId: 'sku-onion', qty: '2' }),
    ]),
    store('s2', 'Hotel-Uzbek', [
      line({ id: 'c', skuId: 'sku-tomato', qty: '3' }),
      line({ id: 'd', skuId: 'sku-carrot', qty: '1' }),
    ]),
  ]);

  it('does NOT leak store names when every line merges', () => {
    const text = buildSupplierText(threeStores, deps);
    expectNoStoreNames(text, threeStores);
  });

  it('does NOT leak store names when some lines come from a single store', () => {
    const text = buildSupplierText(mixedVendor, deps);
    expectNoStoreNames(text, mixedVendor);
    // Exact output — a per-line store annotation would have to show up here.
    expect(text).toBe('savza abat\n\n西红柿: 8 公斤\n洋葱: 2 公斤\n胡萝卜: 1 公斤');
  });

  it('merges the same SKU across stores into one line', () => {
    const text = buildSupplierText(threeStores, deps);
    // The vendor sells one pile: 5 + 3 + 3 = 11, not three lines.
    expect(text).toBe('savza abat\n\n西红柿: 11 公斤');
    expectNoStoreNames(text, threeStores);
  });

  it('keeps distinct SKUs on separate lines', () => {
    const g = supplier([
      store('s1', 'Eden-Magic-City', [line({ id: 'a', qty: '2' })]),
      store('s2', 'Hotel-Uzbek', [line({ id: 'b', skuId: 'sku-onion', qty: '4' })]),
    ]);
    const text = buildSupplierText(g, deps);
    expect(text).toContain('西红柿: 2 公斤');
    expect(text).toContain('洋葱: 4 公斤');
    expectNoStoreNames(text, g);
  });

  it('drops the extras marker — internal jargon the vendor has no context for', () => {
    const g = supplier([
      store('s1', 'Eden-Magic-City', [
        line({ kind: 'extra', skuId: null, name: '面包', unit: '个', qty: '2' }),
      ]),
    ]);
    const text = buildSupplierText(g, deps);
    expect(text).not.toContain('其他物品');
    expectNoStoreNames(text, g);
  });

  it('merges off-catalog extras across stores by name + unit', () => {
    const extra = (id: string, qty: string) =>
      line({ id, kind: 'extra', skuId: null, name: '面包', unit: '个', qty });
    const g = supplier([
      store('s1', 'Eden-Magic-City', [extra('a', '2')]),
      store('s2', 'Hotel-Uzbek', [extra('b', '3')]),
    ]);
    const text = buildSupplierText(g, deps);
    expect(text).toBe('savza abat\n\n面包: 5 个');
    expectNoStoreNames(text, g);
  });

  it('does not merge same-name extras that use different units', () => {
    const g = supplier([
      store('s1', 'Eden-Magic-City', [
        line({ id: 'a', kind: 'extra', skuId: null, name: '水', unit: '瓶', qty: '2' }),
      ]),
      store('s2', 'Hotel-Uzbek', [
        line({ id: 'b', kind: 'extra', skuId: null, name: '水', unit: '箱', qty: '1' }),
      ]),
    ]);
    const text = buildSupplierText(g, deps);
    expect(text).toContain('水: 2 瓶');
    expect(text).toContain('水: 1 箱');
    expectNoStoreNames(text, g);
  });

  it('absorbs float drift when summing splits', () => {
    const g = supplier([
      store('s1', 'Eden-Magic-City', [line({ id: 'a', qty: '0.1' })]),
      store('s2', 'Hotel-Uzbek', [line({ id: 'b', qty: '0.2' })]),
    ]);
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE754; formatQty clamps it.
    expect(buildSupplierText(g, deps)).toContain('西红柿: 0.3 公斤');
  });

  it('treats an unparseable qty as 0 rather than emitting NaN', () => {
    const g = supplier([
      store('s1', 'Eden-Magic-City', [line({ id: 'a', qty: '' })]),
      store('s2', 'Hotel-Uzbek', [line({ id: 'b', qty: '4' })]),
    ]);
    const text = buildSupplierText(g, deps);
    expect(text).toContain('西红柿: 4 公斤');
    expect(text).not.toContain('NaN');
  });

  it('carries notes through without store attribution', () => {
    const g = supplier([store('s1', 'Eden-Seoul', [], '要新鲜的')]);
    const text = buildSupplierText(g, deps);
    expect(text).toContain('备注:');
    expect(text).toContain('要新鲜的');
    expectNoStoreNames(text, g);
  });

  // Merging quantities must never merge REQUIREMENTS. Two shops wanting
  // the same item for different reasons is exactly when the purchaser
  // needs both instructions in the text they carry to the stall.
  it('keeps BOTH notes when two stores request the same item differently', () => {
    const g = supplier([
      store('s1', 'Eden-Magic-City', [
        line({ id: 'a', kind: 'extra', skuId: null, name: '水', unit: '瓶', qty: '2', note: '要冰的' }),
      ]),
      store('s2', 'Hotel-Uzbek', [
        line({ id: 'b', kind: 'extra', skuId: null, name: '水', unit: '瓶', qty: '1', note: '常温' }),
      ]),
    ]);
    const text = buildSupplierText(g, deps);
    expect(text).toBe('savza abat\n\n水: 3 瓶\n  要冰的\n  常温');
    expectNoStoreNames(text, g);
  });

  it('dedupes identical notes rather than repeating them', () => {
    const g = supplier([
      store('s1', 'Eden-Magic-City', [
        line({ id: 'a', kind: 'extra', skuId: null, name: '水', unit: '瓶', qty: '2', note: '要冰的' }),
      ]),
      store('s2', 'Hotel-Uzbek', [
        line({ id: 'b', kind: 'extra', skuId: null, name: '水', unit: '瓶', qty: '1', note: '要冰的' }),
      ]),
    ]);
    expect(buildSupplierText(g, deps)).toBe('savza abat\n\n水: 3 瓶\n  要冰的');
  });

  it('attaches a note that only the second contributing store supplied', () => {
    const g = supplier([
      store('s1', 'Eden-Magic-City', [line({ id: 'a', qty: '1' })]),
      store('s2', 'Hotel-Uzbek', [line({ id: 'b', qty: '1', note: '要熟的' })]),
    ]);
    expect(buildSupplierText(g, deps)).toBe('savza abat\n\n西红柿: 2 公斤\n  要熟的');
  });
});
