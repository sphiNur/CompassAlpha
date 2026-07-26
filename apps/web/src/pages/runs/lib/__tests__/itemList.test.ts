import { describe, expect, it } from 'bun:test';

import { normalizeQuery } from '../../../../lib/searchMatch';
import {
  countByStatus,
  matchesFilter,
  visibleItems,
  type ItemView,
} from '../itemList';

interface Row {
  skuId: string;
  name: string;
  supplier: string | null;
  status: string;
}

const row = (
  skuId: string,
  name: string,
  supplier: string | null = null,
  status = 'pending',
): Row => ({ skuId, name, supplier, status });

const view: ItemView<Row> = {
  nameOf: (r) => r.name,
  supplierNameOf: (r) => r.supplier,
  statusOf: (r) => r.status,
  idOf: (r) => r.skuId,
};

const names = (rows: Row[]) => rows.map((r) => r.name);

describe('visibleItems ordering', () => {
  it('groups by stall, then sorts by name inside each stall', () => {
    const items = [
      row('4', 'Onion', 'Bekzod'),
      row('1', 'Tomato', 'Aziz'),
      row('3', 'Carrot', 'Bekzod'),
      row('2', 'Apple', 'Aziz'),
    ];
    expect(names(visibleItems(items, view))).toEqual([
      'Apple',
      'Tomato',
      'Carrot',
      'Onion',
    ]);
  });

  it('puts items with no stall last instead of under an empty name', () => {
    const items = [
      row('1', 'Aaa', null),
      row('2', 'Zzz', 'Aziz'),
      row('3', 'Bbb', null),
    ];
    expect(names(visibleItems(items, view))).toEqual(['Zzz', 'Aaa', 'Bbb']);
  });

  it('breaks ties on id so equal names never swap between renders', () => {
    const items = [
      row('sku-b', 'Milk', 'Aziz'),
      row('sku-a', 'Milk', 'Aziz'),
    ];
    const once = visibleItems(items, view).map((r) => r.skuId);
    const twice = visibleItems([...items].reverse(), view).map((r) => r.skuId);
    expect(once).toEqual(['sku-a', 'sku-b']);
    expect(twice).toEqual(once);
  });

  it('does NOT reorder when a row changes status', () => {
    // The regression this file exists for. If position depended on
    // status, saving the top row would drop it to the bottom and pull
    // every row below it up — under a thumb already moving toward the
    // next ✓, on a list where a tap commits money.
    const items = [
      row('1', 'Apple', 'Aziz'),
      row('2', 'Milk', 'Aziz'),
      row('3', 'Onion', 'Aziz'),
    ];
    const before = names(visibleItems(items, view));
    const after = names(
      visibleItems(
        items.map((r) => (r.skuId === '1' ? { ...r, status: 'purchased' } : r)),
        view,
      ),
    );
    expect(after).toEqual(before);
  });

  it('keeps every row in place as the whole trip completes', () => {
    const items = [
      row('1', 'Apple', 'Aziz'),
      row('2', 'Milk', 'Bekzod'),
      row('3', 'Onion', null),
    ];
    const baseline = names(visibleItems(items, view));
    for (const status of ['purchased', 'unavailable']) {
      const all = items.map((r) => ({ ...r, status }));
      expect(names(visibleItems(all, view))).toEqual(baseline);
    }
  });
});

describe('visibleItems filtering', () => {
  const items = [
    row('1', 'Tomato', 'Aziz', 'pending'),
    row('2', 'Milk', 'Aziz', 'purchased'),
    row('3', 'Onion', 'Bekzod', 'unavailable'),
    row('4', 'Apple', 'Bekzod', 'pending'),
  ];

  it('shows everything by default', () => {
    expect(visibleItems(items, view)).toHaveLength(4);
  });

  it('narrows to what is still to do', () => {
    expect(names(visibleItems(items, view, { filter: 'pending' }))).toEqual([
      'Tomato',
      'Apple',
    ]);
  });

  it('narrows to what could not be found', () => {
    expect(names(visibleItems(items, view, { filter: 'unavailable' }))).toEqual([
      'Onion',
    ]);
  });

  it('finds a row by name', () => {
    const tokens = normalizeQuery('tomato')!;
    expect(names(visibleItems(items, view, { tokens }))).toEqual(['Tomato']);
  });

  it('tolerates a typo, the way the preview search does', () => {
    const tokens = normalizeQuery('tomto')!;
    expect(names(visibleItems(items, view, { tokens }))).toEqual(['Tomato']);
  });

  it('finds every row of a stall by typing the stall name', () => {
    const tokens = normalizeQuery('bekzod')!;
    expect(names(visibleItems(items, view, { tokens }))).toEqual([
      'Apple',
      'Onion',
    ]);
  });

  it('searches the extra haystack when one is supplied', () => {
    const withSecondLanguage: ItemView<Row> = {
      ...view,
      extraHaystackOf: (r) => (r.name === 'Tomato' ? ['Помидор'] : []),
    };
    const tokens = normalizeQuery('помидор')!;
    expect(
      names(visibleItems(items, withSecondLanguage, { tokens })),
    ).toEqual(['Tomato']);
  });

  it('combines search and filter', () => {
    const tokens = normalizeQuery('aziz')!;
    expect(
      names(visibleItems(items, view, { tokens, filter: 'pending' })),
    ).toEqual(['Tomato']);
  });

  it('returns nothing when the query matches nothing', () => {
    expect(visibleItems(items, view, { tokens: normalizeQuery('zzzz')! })).toEqual(
      [],
    );
  });

  it('does not mutate the caller array', () => {
    const original = [...items];
    visibleItems(items, view);
    expect(items).toEqual(original);
  });
});

describe('matchesFilter', () => {
  it('passes everything on all', () => {
    for (const s of ['pending', 'purchased', 'unavailable']) {
      expect(matchesFilter(s, 'all')).toBe(true);
    }
  });

  it('is exact on the narrow filters', () => {
    expect(matchesFilter('pending', 'pending')).toBe(true);
    expect(matchesFilter('purchased', 'pending')).toBe(false);
    expect(matchesFilter('unavailable', 'unavailable')).toBe(true);
    expect(matchesFilter('purchased', 'unavailable')).toBe(false);
  });
});

describe('countByStatus', () => {
  it('tallies each status separately', () => {
    const items = [
      row('1', 'a', null, 'pending'),
      row('2', 'b', null, 'purchased'),
      row('3', 'c', null, 'purchased'),
      row('4', 'd', null, 'unavailable'),
    ];
    expect(countByStatus(items, (r) => r.status)).toEqual({
      all: 4,
      pending: 1,
      purchased: 2,
      unavailable: 1,
    });
  });

  it('handles an empty run', () => {
    expect(countByStatus([], (r: Row) => r.status)).toEqual({
      all: 0,
      pending: 0,
      purchased: 0,
      unavailable: 0,
    });
  });
});
