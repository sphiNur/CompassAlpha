/**
 * The name a run row shows (UI-4: the second language on its own line),
 * review RUNWEB1-09.
 */
import type { ProductNameParts } from '../../../lib/productName';

type Named = { names: Record<string, string> | null | undefined };

const SHORT_ID_NAMES = new Map<string, ProductNameParts>();

/**
 * The product's name from `parts` (useProductNameParts), or the first
 * eight characters of its id while the catalog has not loaded it. Both
 * are the same object on every call, as PurchaseRow is memo()'d.
 */
export function rowName(
  parts: (item: Named) => ProductNameParts,
  sku: Named | null | undefined,
  skuId: string,
): ProductNameParts {
  if (sku) return parts(sku);
  let name = SHORT_ID_NAMES.get(skuId);
  if (!name) {
    name = { primary: skuId.slice(0, 8), secondary: null };
    SHORT_ID_NAMES.set(skuId, name);
  }
  return name;
}
