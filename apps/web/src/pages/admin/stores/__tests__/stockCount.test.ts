/**
 * D1 (2026-11-13): count mode — which rows were counted, what a save
 * sends, and the summary shown before it.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { format, loadCatalog, type Locale } from '@compass/i18n';
import {
  countableProducts,
  countSaveLabel,
  countSummary,
  countsToSave,
  inParts,
  rowProblem,
  countShortcutStore,
  typedRows,
  withoutSaved,
} from '../stockCount';

const onHand: Record<string, string> = { a: '5.000', b: '2.500', c: '-1.000' };
const read = (skuId: string) => onHand[skuId];

describe('which rows were counted', () => {
  test('a row left empty, or holding only spaces, is not counted', () => {
    expect(typedRows({ a: '4', b: '', c: '  ', d: '0' })).toEqual(['a', 'd']);
  });

  test('0 is a count', () => {
    expect(countsToSave({ a: '0' })).toEqual([{ skuId: 'a', target: '0' }]);
  });

  test('a row that does not read is reported and not sent', () => {
    const draft = { a: '4', b: 'abc', c: '-2', d: '1.2345' };
    expect(rowProblem(draft, 'b')).toBe('notNumber');
    expect(rowProblem(draft, 'c')).toBe('negative');
    expect(rowProblem(draft, 'd')).toBe('decimals');
    expect(rowProblem(draft, 'e')).toBeNull();
    expect(countsToSave(draft)).toEqual([{ skuId: 'a', target: '4' }]);
  });
});

describe('the summary before saving', () => {
  test('counts typed rows, and those that differ from stock in thousandths', () => {
    // a matches (5 = 5.000), b differs by a thousandth, c was negative, d has no stock row.
    const draft = { a: '5', b: '2.501', c: '0', d: '0', e: '' };
    expect(countSummary(draft, read)).toEqual({ counted: 4, differ: 2, invalid: 0 });
  });

  test('a row that does not read is counted as invalid, not as a difference', () => {
    expect(countSummary({ a: 'x', b: '2.5' }, read)).toEqual({ counted: 2, differ: 0, invalid: 1 });
  });

  test('nothing typed', () => {
    expect(countSummary({}, read)).toEqual({ counted: 0, differ: 0, invalid: 0 });
  });
});

describe('the products listed', () => {
  test('active ones with their stock or 0, archived ones only while they hold stock', () => {
    const skus = [
      { id: 'a', isArchived: false },
      { id: 'n', isArchived: false },
      { id: 'old', isArchived: true },
      { id: 'gone', isArchived: true },
    ];
    const levels = [
      { skuId: 'a', onHand: '5.000' },
      { skuId: 'old', onHand: '1.000' },
      { skuId: 'gone', onHand: '0.000' },
    ];
    expect(countableProducts(skus, levels).map((p) => [p.id, p.onHand])).toEqual([
      ['a', '5.000'],
      ['n', '0'],
      ['old', '1.000'],
    ]);
  });
});

describe('long counts', () => {
  test('are sent in parts, and a saved part leaves the draft', () => {
    expect(inParts([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(inParts([], 2)).toEqual([]);
    expect(withoutSaved({ a: '1', b: '2', c: '3' }, ['a', 'c'])).toEqual({ b: '2' });
  });
});

describe('the Admin home shortcut', () => {
  const stores = [
    { id: 's1', name: 'North' },
    { id: 's2', name: 'South' },
    { id: 's3', name: 'East' },
  ];
  const both = { s1: ['inventory.adjust'], s2: ['inventory.adjust'], s3: [] };

  test('the one store where stock may be counted, whatever the top bar says', () => {
    const session = {
      permissions: ['inventory.adjust'],
      storePermissions: { s1: ['inventory.adjust'], s2: [], s3: [] },
      stores,
    };
    expect(countShortcutStore(session, null)?.id).toBe('s1');
    expect(countShortcutStore(session, 's2')?.id).toBe('s1');
  });

  test('UX-12: with several, the top-bar store when stock may be counted there', () => {
    const session = { permissions: [], storePermissions: both, stores };
    expect(countShortcutStore(session, 's2')?.id).toBe('s2');
    expect(countShortcutStore(session, 's1')?.id).toBe('s1');
    // Not countable in the top-bar store, or "All stores": hidden.
    expect(countShortcutStore(session, 's3')).toBeNull();
    expect(countShortcutStore(session, null)).toBeNull();
  });

  test('not offered where stock may not be counted anywhere', () => {
    const session = { permissions: [], storePermissions: {}, stores };
    expect(countShortcutStore(session, 's1')).toBeNull();
  });
});

describe('UX-06: the Save button carries the summary', () => {
  const label = (counted: number, differ: number, locale: Locale = 'en') => {
    const l = countSaveLabel({ counted, differ, invalid: 0 });
    return format(l.key, locale, l.vars);
  };
  beforeAll(async () => {
    await Promise.all((['en', 'ru', 'zh', 'uz'] as const).map((l) => loadCatalog(l)));
  });

  test('nothing typed: plain Save', () => {
    expect(countSaveLabel({ counted: 0, differ: 0, invalid: 0 })).toEqual({ key: 'common.save' });
  });

  test('says how many differ, and nothing about differences when none do', () => {
    expect(label(2, 1)).toBe('Save 2 counts · 1 differs');
    expect(label(1, 1)).toBe('Save 1 count · 1 differs');
    expect(label(5, 3)).toBe('Save 5 counts · 3 differ');
    expect(label(2, 0)).toBe('Save 2 counts');
  });

  test('plural forms in the other languages', () => {
    expect(label(5, 2, 'ru')).toBe('Сохранить 5 позиций · 2 расходятся');
    expect(label(21, 1, 'ru')).toBe('Сохранить 21 позицию · 1 расходится');
    expect(label(2, 1, 'zh')).toBe('保存 2 项盘点 · 1 项不符');
    expect(label(2, 1, 'uz')).toBe('2 ta sanoqni saqlash · 1 tasi farq qiladi');
  });
});
