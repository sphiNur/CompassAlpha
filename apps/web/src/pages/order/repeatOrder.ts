/**
 * UX-02 (2026-11-13): "Repeat last order" on an empty draft. The store's
 * last sent order (order.lastSubmitted) becomes quantities set through
 * the same write a + tap makes (useAdjustQueue), so the lines go through
 * the outbox and the user edits them before Submit. Nothing is sent.
 *
 * A line is copied only when the product can still be ordered as it was:
 * in the catalog and not archived, in the same unit (a changed unit makes
 * the old number mean another amount), and at a quantity its current
 * step allows (the server refuses another, qtyNotMultipleOfStep).
 */
import { milliQty, qtyMilliOrZero } from '@compass/contracts/quantity';

export interface LastOrderLine {
  skuId: string;
  qty: string;
  unit: string;
}

export interface RepeatableSku {
  id: string;
  unit: string;
  step: string;
  isArchived?: boolean;
}

/** The quantities to set, one per product, in the order of `lines`. */
export function repeatOrderFill(
  lines: readonly LastOrderLine[],
  skus: readonly RepeatableSku[],
): Array<{ skuId: string; qty: string }> {
  const skuById = new Map(skus.map((sku) => [sku.id, sku]));
  const seen = new Set<string>();
  const fill: Array<{ skuId: string; qty: string }> = [];
  for (const line of lines) {
    const sku = skuById.get(line.skuId);
    if (!sku || sku.isArchived || sku.unit !== line.unit || seen.has(sku.id)) continue;
    const qty = qtyMilliOrZero(line.qty);
    if (qty <= 0n) continue;
    const step = qtyMilliOrZero(sku.step);
    if (step > 0n && qty % step !== 0n) continue;
    seen.add(sku.id);
    fill.push({ skuId: sku.id, qty: milliQty(qty) });
  }
  return fill;
}
