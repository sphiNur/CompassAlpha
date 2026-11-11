/**
 * The name a run row shows (UI-4: the second language on its own line),
 * review RUNWEB1-09.
 */
import type { ProductNameParts } from '../../../lib/productName';

type Named = { names: Record<string, string> | null | undefined };

const UNKNOWN_NAMES = new Map<string, ProductNameParts>();

/**
 * The product's name from `parts` (useProductNameParts), or `unknown`
 * ("unknown product") while the catalog has not loaded it. Review
 * RUNWEB1-38: that was the first eight characters of the id. Both are the
 * same object on every call, as PurchaseRow is memo()'d.
 */
export function rowName(
  parts: (item: Named) => ProductNameParts,
  sku: Named | null | undefined,
  unknown: string,
): ProductNameParts {
  if (sku) return parts(sku);
  let name = UNKNOWN_NAMES.get(unknown);
  if (!name) {
    name = { primary: unknown, secondary: null };
    UNKNOWN_NAMES.set(unknown, name);
  }
  return name;
}
