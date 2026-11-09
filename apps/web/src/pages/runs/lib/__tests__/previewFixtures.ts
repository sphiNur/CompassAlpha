/**
 * Review TEST3-03 (2026-11): the plan-preview tests build their lines,
 * store groups and stall groups here, so a new required field is added in
 * one place. Each test overrides what it relies on.
 */
import type { PreviewLine, PreviewStoreGroup, PreviewSupplierGroup } from '../../types';

/** An unpriced catalog line; an explicit `skuId: null` makes it an extra. */
export function previewLine(over: Partial<PreviewLine> = {}): PreviewLine {
  return {
    id: 'l1',
    kind: 'sku',
    skuId: 'sku-tomato',
    name: 'raw-name',
    qty: '1',
    unit: 'raw-unit',
    unitPrice: null,
    total: null,
    ...over,
  };
}

export function previewStore(
  storeId: string,
  items: PreviewLine[],
  over: Partial<PreviewStoreGroup> = {},
): PreviewStoreGroup {
  return { storeId, storeName: `Store-${storeId}`, items, total: 0, unknownCount: 0, ...over };
}

export function previewSupplier(
  supplierId: string | null,
  stores: PreviewStoreGroup[],
  over: Partial<PreviewSupplierGroup> = {},
): PreviewSupplierGroup {
  return {
    supplierId,
    supplierName: supplierId ?? 'unassigned',
    contactPhone: null,
    contactTg: null,
    stores,
    total: 0,
    unknownCount: 0,
    ...over,
  };
}
