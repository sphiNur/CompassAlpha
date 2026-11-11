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
import { beforeAll, describe, it, expect } from 'bun:test';
import { createI18n, loadCatalog } from '@compass/i18n';
import { buildStoreText, buildSupplierText, formatLineForText, shareDepsFor } from '../shareText';
import type { ShareTextDeps } from '../shareText';
import type { PreviewLine, PreviewStoreGroup } from '../../types';
import { unitLabeller } from '../../../../lib/unitLabel';
import { previewLine as line, previewStore, previewSupplier } from './previewFixtures';

const CATALOG: Record<string, { name: string; unit: string }> = {
  'sku-tomato': { name: '西红柿', unit: '公斤' },
  'sku-onion': { name: '洋葱', unit: '公斤' },
  'sku-carrot': { name: '胡萝卜', unit: '公斤' },
};

beforeAll(async () => {
  await Promise.all([loadCatalog('zh'), loadCatalog('en')]);
});

const zh = createI18n('zh');
const deps: ShareTextDeps = {
  resolveSku: (skuId) => CATALOG[skuId] ?? null,
  extrasLabel: '其他物品',
  notesLabel: '备注',
  line: (name, qty) => zh.t('run.share.line', { name, qty }),
  heading: (label) => zh.t('run.share.heading', { label }),
};

const store = (storeId: string, storeName: string, items: PreviewLine[], legacyNote?: string) =>
  previewStore(storeId, items, { storeName, legacyNote });

const supplier = (stores: PreviewStoreGroup[]) =>
  previewSupplier('sup-1', stores, { supplierName: 'Alpha stall' });

describe('formatLineForText', () => {
  it('uses the catalog name + localized unit when the SKU resolves', () => {
    expect(formatLineForText(line({ qty: '2' }), deps)).toBe('西红柿：2 公斤');
  });

  it('falls back to the line own name/unit for off-catalog extras', () => {
    const l = line({ kind: 'extra', skuId: null, name: '面包', unit: '个', qty: '3' });
    expect(formatLineForText(l, deps)).toBe('其他物品 · 面包：3 个');
  });

  it('follows the punctuation of the language (RUNWEB2-17)', () => {
    const en = createI18n('en');
    const enDeps: ShareTextDeps = {
      ...deps,
      extrasLabel: 'Extras',
      notesLabel: 'Notes',
      line: (name, qty) => en.t('run.share.line', { name, qty }),
      heading: (label) => en.t('run.share.heading', { label }),
    };
    const l = line({ kind: 'extra', skuId: null, name: 'Bread', unit: 'pcs', qty: '3' });
    expect(formatLineForText(l, enDeps)).toBe('Extras · Bread: 3 pcs');
    expect(buildStoreText(store('s1', 'Store-A', [l], 'fresh'), enDeps)).toContain('\nNotes:\n');
  });

  it('puts a note on its own indented line', () => {
    expect(formatLineForText(line({ qty: '1', note: '要熟的' }), deps)).toBe(
      '西红柿：1 公斤\n  要熟的',
    );
  });
});

describe('buildStoreText', () => {
  it('KEEPS the store name — this string goes to that store own manager', () => {
    const g = store('s1', 'Store-A', [line({ qty: '5' })]);
    const text = buildStoreText(g, deps);
    expect(text).toContain('Store-A');
    expect(text).toContain('西红柿：5 公斤');
  });

  it('keeps the extras marker — off-catalog is meaningful to a manager', () => {
    const text = buildStoreText(
      store('s1', 'Store-B', [line({ kind: 'extra', skuId: null, name: '面包', unit: '个' })]),
      deps,
    );
    expect(text).toContain('其他物品 · 面包');
  });

  it('appends the legacy note under the notes label', () => {
    const text = buildStoreText(store('s1', 'Store-B', [], '再买两箱水'), deps);
    expect(text).toContain('备注：');
    expect(text).toContain('再买两箱水');
  });
});

describe('buildSupplierText', () => {
  const threeStores = supplier([
    store('s1', 'Store-A', [line({ id: 'a', qty: '5' })]),
    store('s2', 'Store-B', [line({ id: 'b', qty: '3' })]),
    store('s3', 'Store-C', [line({ id: 'c', qty: '3' })]),
  ]);

  it('keeps each store as its own labelled section', () => {
    expect(buildSupplierText(threeStores, deps)).toBe(
      [
        'Alpha stall',
        '',
        'Store-A',
        '西红柿：5 公斤',
        '',
        'Store-B',
        '西红柿：3 公斤',
        '',
        'Store-C',
        '西红柿：3 公斤',
      ].join('\n'),
    );
  });

  it('does NOT merge the same SKU across stores', () => {
    // 5 / 3 / 3 stay separate. A single "11 公斤" line would make the
    // purchaser re-derive the split from another screen while standing
    // at the scale with the vendor waiting.
    const text = buildSupplierText(threeStores, deps);
    expect(text).not.toContain('11 公斤');
    expect(text).toContain('西红柿：5 公斤');
    expect(text).toContain('西红柿：3 公斤');
  });

  it('names every store that contributes', () => {
    const text = buildSupplierText(threeStores, deps);
    for (const s of threeStores.stores) expect(text).toContain(s.storeName);
  });

  it('keeps distinct SKUs under the store that asked for them', () => {
    const g = supplier([
      store('s1', 'Store-A', [line({ id: 'a', qty: '2' })]),
      store('s2', 'Store-B', [line({ id: 'b', skuId: 'sku-onion', qty: '4' })]),
    ]);
    expect(buildSupplierText(g, deps)).toBe(
      ['Alpha stall', '', 'Store-A', '西红柿：2 公斤', '', 'Store-B', '洋葱：4 公斤'].join('\n'),
    );
  });

  it('carries off-catalog extras with their own name and unit', () => {
    const g = supplier([
      store('s1', 'Store-A', [
        line({ kind: 'extra', skuId: null, name: '面包', unit: '个', qty: '2' }),
      ]),
    ]);
    expect(buildSupplierText(g, deps)).toContain('面包：2 个');
  });

  it('keeps each note attached to the store that wrote it', () => {
    // The case the merged version had to dedupe around: two shops
    // wanting the same item differently. Split by store, each
    // instruction sits under its own shop and nothing can collide.
    const g = supplier([
      store('s1', 'Store-A', [
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
      store('s2', 'Store-B', [
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
        'Alpha stall',
        '',
        'Store-A',
        '其他物品 · 水：2 瓶',
        '  要冰的',
        '',
        'Store-B',
        '其他物品 · 水：1 瓶',
        '  常温',
      ].join('\n'),
    );
  });

  it('carries a store-level note under that store', () => {
    const g = supplier([store('s1', 'Store-C', [line({ qty: '1' })], '要新鲜的')]);
    const text = buildSupplierText(g, deps);
    expect(text).toContain('Store-C');
    expect(text).toContain('备注：');
    expect(text).toContain('要新鲜的');
  });

  it('leaves no trailing blank line', () => {
    const text = buildSupplierText(threeStores, deps);
    expect(text.endsWith('\n')).toBe(false);
    expect(text).toBe(text.trim());
  });

  it('passes a quantity through verbatim rather than summing it', () => {
    const g = supplier([store('s1', 'Store-A', [line({ qty: '0.1' })])]);
    expect(buildSupplierText(g, deps)).toContain('西红柿：0.1 公斤');
  });
});

/**
 * Review COREWEB2-12 (2026-11-11): with a stall display language set, the
 * per-stall copy went out in the purchaser's own language, although the
 * setting promises the stall's. The page now writes a stall's list with
 * the stall's strings and our stores' lists with the interface's.
 */
describe('shareDepsFor (COREWEB2-12)', () => {
  beforeAll(async () => {
    await loadCatalog('ru');
  });
  const skuById = new Map([
    ['sku-tomato', { names: { zh: '西红柿', ru: 'Помидоры' }, unit: 'kg' }],
  ]);
  const depsIn = (locale: 'zh' | 'ru'): ShareTextDeps => {
    const i18n = createI18n(locale);
    return shareDepsFor(i18n, unitLabeller(i18n.t), skuById);
  };
  const tomato = line({ qty: '2' });
  const bread = line({ id: 'l2', kind: 'extra', skuId: null, name: '面包', unit: '个', qty: '3' });

  it("writes a stall's list in the stall's language: names, units and labels", () => {
    const g = supplier([store('s1', 'Store-A', [tomato, bread], 'cold')]);
    expect(buildSupplierText(g, depsIn('ru'))).toBe(
      [
        'Alpha stall',
        '',
        'Store-A',
        'Помидоры: 2 кг',
        'Прочие позиции · 面包: 3 个',
        'Комментарий:',
        'cold',
      ].join('\n'),
    );
  });

  it("keeps the interface's language for our own store", () => {
    expect(buildStoreText(store('s1', 'Store-A', [tomato]), depsIn('zh'))).toBe(
      'Store-A\n\n西红柿：2 公斤',
    );
  });

  it('takes a product missing from the catalog from the line itself', () => {
    const gone = line({ skuId: 'sku-gone', name: 'raw', unit: 'u', qty: '1' });
    expect(formatLineForText(gone, depsIn('ru'))).toBe('raw: 1 u');
  });
});
