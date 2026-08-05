import type { PreviewLine, PreviewStoreGroup } from '../types';

export type PreviewStoreSupplierGroup = {
  supplierId: string | null;
  supplierName: string;
  items: PreviewLine[];
  total: number;
  unknownCount: number;
};

/**
 * Build the store -> supplier -> item hierarchy used by the purchase preview.
 *
 * The store group remains the source of truth for filtering, statistics, and
 * share text. This function only reshapes its already-visible rows for
 * display, so it never mutates the original list or combines rows from two
 * stores.
 */
export function groupStoreBySupplier(
  store: PreviewStoreGroup,
  unassignedLabel: string,
): PreviewStoreSupplierGroup[] {
  const buckets = new Map<string | null, PreviewStoreSupplierGroup>();

  for (const line of store.items) {
    // Extras cannot have a supplier, so they live with the actionable
    // exception bucket rather than pretending to belong to a market stall.
    const supplierId = line.kind === 'sku' ? (line.supplierId ?? null) : null;
    let bucket = buckets.get(supplierId);
    if (!bucket) {
      bucket = {
        supplierId,
        supplierName: supplierId ? (line.supplierName ?? unassignedLabel) : unassignedLabel,
        items: [],
        total: 0,
        unknownCount: 0,
      };
      buckets.set(supplierId, bucket);
    }
    bucket.items.push(line);
    if (line.total === null) bucket.unknownCount += 1;
    else bucket.total += line.total;
  }

  return [...buckets.values()].sort((a, b) => {
    // Real stalls first, then the exception bucket at the end.
    if (a.supplierId === null) return b.supplierId === null ? 0 : 1;
    if (b.supplierId === null) return -1;
    return a.supplierName.localeCompare(b.supplierName);
  });
}
