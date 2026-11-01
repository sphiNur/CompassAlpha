import { describe, expect, it } from 'bun:test';
import { groupCatalog, orderableSkus } from '../catalogGroups';

const sku = (
  id: string,
  categoryId: string | null,
  sortIndex: number,
  isArchived = false,
) => ({ id, code: id.toUpperCase(), categoryId, sortIndex, isArchived });

const categories = [
  { id: 'fruit', sortIndex: 20 },
  { id: 'meat', sortIndex: 10 },
];

describe('groupCatalog (DX-ORD-6)', () => {
  it('orders categories and products by sortIndex, then code', () => {
    const groups = groupCatalog(
      [sku('banana', 'fruit', 5), sku('apple', 'fruit', 5), sku('lamb', 'meat', 10), sku('beef', 'meat', 0)],
      categories,
    );
    expect(groups.map((g) => g.categoryId)).toEqual(['meat', 'fruit']);
    expect(groups[0]!.skus.map((s) => s.id)).toEqual(['beef', 'lamb']);
    expect(groups[1]!.skus.map((s) => s.id)).toEqual(['apple', 'banana']);
  });

  it('puts products of no or an unknown category last', () => {
    const groups = groupCatalog([sku('x', null, 0), sku('y', 'gone', 0), sku('beef', 'meat', 0)], categories);
    expect(groups.map((g) => g.key)).toEqual(['meat', 'none']);
    expect(groups[1]!.skus.map((s) => s.id)).toEqual(['x', 'y']);
  });

  it('with archivedFirst, archived products lead in their own group', () => {
    const groups = groupCatalog([sku('beef', 'meat', 0), sku('apple', 'fruit', 0, true)], categories, {
      archivedFirst: true,
    });
    expect(groups.map((g) => g.key)).toEqual(['archived', 'meat']);
    expect(groups[0]!.archived).toBe(true);
  });

  it('without it, archived products stay in their category (review sheet)', () => {
    const groups = groupCatalog([sku('apple', 'fruit', 0, true)], categories);
    expect(groups.map((g) => g.key)).toEqual(['fruit']);
  });
});

describe('orderableSkus (DX-ORD-4 / DX-ORD-16)', () => {
  it('keeps active products and archived ones still in my draft', () => {
    const all = [sku('a', null, 0), sku('b', null, 0, true), sku('c', null, 0, true)];
    const mine = new Map([
      ['b', 0.5],
      ['c', 0],
    ]);
    expect(orderableSkus(all, mine).map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('is empty when everything is archived and nothing is drafted', () => {
    expect(orderableSkus([sku('a', null, 0, true)], new Map())).toEqual([]);
  });
});
