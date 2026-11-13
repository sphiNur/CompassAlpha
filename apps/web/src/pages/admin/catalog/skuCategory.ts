/**
 * UX-18 (2026-11-14): a new product starts in the category the person last
 * filed a product under in this session, instead of "—". Adding several
 * vegetables in a row cost a Select tap each.
 *
 * Kept in memory only: it lasts until the page reloads, which is the
 * session the owner adds products in. The Products list has no category
 * filter; if one is added, pass it first in `candidates`.
 */
let lastCreatedCategoryId: string | null = null;

/** Remember the category a product was just created in ("—" too). */
export function rememberSkuCategory(categoryId: string | null): void {
  lastCreatedCategoryId = categoryId;
}

/** The category remembered by rememberSkuCategory, for the editor. */
export function lastSkuCategory(): string | null {
  return lastCreatedCategoryId;
}

/**
 * The first candidate that is a live category of this catalog, else none.
 * An archived category is not offered to a new product (CA-40), and a
 * remembered id from another organisation or a deleted category is not
 * in the list at all.
 */
export function pickNewSkuCategory(
  candidates: readonly (string | null | undefined)[],
  categories: readonly { id: string; isArchived: boolean }[] | undefined,
): string | null {
  for (const id of candidates) {
    if (!id) continue;
    if (categories?.some((c) => c.id === id && !c.isArchived)) return id;
  }
  return null;
}
