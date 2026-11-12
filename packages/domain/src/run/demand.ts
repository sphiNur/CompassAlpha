/**
 * What a run is asked to buy: the order lines of the sessions it plans,
 * attaches or lets go, summed per product (review RUNAPI-13). The run
 * router added them up three times and the planning preview a fourth.
 *
 * In whole thousandths (review RUNAPI-05), never floats: these sums go
 * into RunPlanned and the other run events, which are kept for ever. A
 * line of no quantity (a note on its own, or a line taken back to zero)
 * asks for nothing.
 */
import { milliQty, qtyMilli } from '@compass/contracts/quantity';

/** A product and a quantity of it: an order line, or what a run needs of the product. */
export interface DemandLine {
  skuId: string;
  qty: string;
}

/** `lines` summed per product, each product where it first appears. */
export function sumDemand(lines: Iterable<DemandLine>): DemandLine[] {
  const totals = new Map<string, bigint>();
  for (const line of lines) {
    const qty = qtyMilli(line.qty);
    if (qty > 0n) add(totals, line.skuId, qty);
  }
  return listed(totals);
}

/**
 * `sumDemand` for each group of `lines`, such as each session or each
 * store. A line `keyOf` gives no key is left out, and so is a group that
 * asks for nothing. Groups, and the products in each, come in the order
 * they first appear.
 */
export function sumDemandBy<Line extends DemandLine>(
  lines: Iterable<Line>,
  keyOf: (line: Line) => string | undefined,
): Map<string, DemandLine[]> {
  const groups = new Map<string, Map<string, bigint>>();
  for (const line of lines) {
    const qty = qtyMilli(line.qty);
    if (qty <= 0n) continue;
    const key = keyOf(line);
    if (key === undefined) continue;
    let totals = groups.get(key);
    if (!totals) {
      totals = new Map();
      groups.set(key, totals);
    }
    add(totals, line.skuId, qty);
  }
  return new Map([...groups].map(([key, totals]) => [key, listed(totals)]));
}

function add(totals: Map<string, bigint>, skuId: string, qty: bigint): void {
  totals.set(skuId, (totals.get(skuId) ?? 0n) + qty);
}

function listed(totals: Map<string, bigint>): DemandLine[] {
  return [...totals].map(([skuId, qty]) => ({ skuId, qty: milliQty(qty) }));
}
