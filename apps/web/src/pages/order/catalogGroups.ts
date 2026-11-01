/**
 * DX-ORD-6 / DX-ORD-16 (2026-11-01): how the Order page lays out products.
 *
 * - Products come in the order the admin set: category by its sortIndex,
 *   then product by its sortIndex, then code. "All" used to be one list in
 *   whatever order the server returned, with no headings; with 190–244
 *   products the only way to find anything was search.
 * - A product archived while it is in the member's draft stays in the
 *   catalog (first, marked) so the line can be seen and taken out. It
 *   used to vanish from the catalog and showed up only in the review.
 */

export interface GroupableSku {
  id: string;
  categoryId: string | null;
  code: string | null;
  sortIndex?: number | null;
  isArchived?: boolean;
}

export interface GroupableCategory {
  id: string;
  sortIndex?: number | null;
}

export interface CatalogGroup<T> {
  /** Stable React key. */
  key: string;
  /** null for products with no (or an archived / unknown) category. */
  categoryId: string | null;
  /** The group of archived products still in the draft. */
  archived: boolean;
  skus: T[];
}

/** Active products, plus archived ones the member still has a quantity of. */
export function orderableSkus<T extends GroupableSku>(
  all: readonly T[],
  myQtyBySku: ReadonlyMap<string, number>,
): T[] {
  return all.filter((s) => !s.isArchived || (myQtyBySku.get(s.id) ?? 0) > 0);
}

function bySortThenCode(a: GroupableSku, b: GroupableSku): number {
  const d = (a.sortIndex ?? 0) - (b.sortIndex ?? 0);
  if (d !== 0) return d;
  const ac = a.code ?? '';
  const bc = b.code ?? '';
  return ac < bc ? -1 : ac > bc ? 1 : 0;
}

/**
 * Group products by category in category order. With `archivedFirst`,
 * archived products form one leading group instead of sitting in their
 * category. Products whose category is not in `categories` (none, or an
 * archived category) come last.
 */
export function groupCatalog<T extends GroupableSku>(
  skus: readonly T[],
  categories: readonly GroupableCategory[],
  { archivedFirst = false }: { archivedFirst?: boolean } = {},
): CatalogGroup<T>[] {
  const order = [...categories].sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0));
  const known = new Set(order.map((c) => c.id));
  const archived: T[] = [];
  const byCat = new Map<string | null, T[]>();
  for (const s of skus) {
    if (archivedFirst && s.isArchived) {
      archived.push(s);
      continue;
    }
    const cat = s.categoryId && known.has(s.categoryId) ? s.categoryId : null;
    const arr = byCat.get(cat) ?? [];
    arr.push(s);
    byCat.set(cat, arr);
  }
  const groups: CatalogGroup<T>[] = [];
  if (archived.length > 0) {
    groups.push({
      key: 'archived',
      categoryId: null,
      archived: true,
      skus: archived.sort(bySortThenCode),
    });
  }
  for (const c of order) {
    const arr = byCat.get(c.id);
    if (arr) groups.push({ key: c.id, categoryId: c.id, archived: false, skus: arr.sort(bySortThenCode) });
  }
  const rest = byCat.get(null);
  if (rest) groups.push({ key: 'none', categoryId: null, archived: false, skus: rest.sort(bySortThenCode) });
  return groups;
}
