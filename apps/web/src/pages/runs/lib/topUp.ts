/**
 * DX-BUY-2 (2026-11-01): buying the extra quantity a newly attached order
 * asks for, without repricing what was bought before.
 *
 * "补买" used to open the edit sheet with the whole row (quantity 4,
 * price 80) and save it through revisePurchase, which has one price per
 * row: bought 2 × 80 earlier and 2 × 82 now, saved at 82, the row said
 * 4 × 82 = 328,000 while 324,000 was paid. The top-up is now its own
 * batch on the same row, so the goods still reach the stores (delivery,
 * receipt, inventory) and the "still need" line closes, while the money
 * keeps both prices:
 *
 *   - the row keeps the earlier batch's price and method;
 *   - a store that gets only top-up quantity is priced at the top-up
 *     price and method (a per-store override — the same mechanism as
 *     the sheet's per-store pricing);
 *   - a store that gets more on top of what it already had is priced at
 *     the weighted price of both batches, rounded half-up to cents (one
 *     price per store and row is all a split holds; the total is off by
 *     at most half a cent per unit). It keeps its earlier method.
 *
 * Returns null when this is not a top-up (a store's quantity went down,
 * or nothing was added); the caller then saves an ordinary revision.
 *
 * Pure; tests in __tests__/topUp.test.ts.
 */
export type PaymentMethod = 'cash' | 'transfer';

type BaseSplit = { storeId: string; qty: string; unitPrice: string; paymentMethod: PaymentMethod };

export type TopUpRevision = {
  unitPrice: string;
  paymentMethod: PaymentMethod;
  actualQty: string;
  storeSplits: Array<{
    storeId: string;
    qty: string;
    unitPrice?: string;
    paymentMethod?: PaymentMethod;
  }>;
};

const milli = (v: string): bigint => BigInt(Math.round(Number(v) * 1000));
const cents = (v: string): bigint => BigInt(Math.round(Number(v) * 100));
const milliText = (m: bigint): string => {
  const whole = m / 1000n;
  const frac = (m % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
};
const centsText = (c: bigint): string => {
  const whole = c / 100n;
  const frac = (c % 100n).toString().padStart(2, '0');
  return frac === '00' ? whole.toString() : `${whole}.${frac}`.replace(/0$/, '');
};

export function topUpRevision(input: {
  /** The row as bought before: its price and method. */
  item: { unitPrice: string; paymentMethod: PaymentMethod };
  /** Each store's earlier quantity with its effective price and method. */
  base: readonly BaseSplit[];
  /** Each store's quantity after the top-up, as the sheet holds it. */
  next: ReadonlyMap<string, string>;
  topUpPrice: string;
  topUpMethod: PaymentMethod;
}): TopUpRevision | null {
  const { item, base, next, topUpPrice, topUpMethod } = input;
  const baseBy = new Map(base.filter((b) => Number(b.qty) > 0).map((b) => [b.storeId, b]));
  const storeIds = [...new Set([...baseBy.keys(), ...next.keys()])];
  let added = 0n;
  let total = 0n;
  const storeSplits: TopUpRevision['storeSplits'] = [];
  for (const storeId of storeIds) {
    const b = baseBy.get(storeId);
    const baseQty = b ? milli(b.qty) : 0n;
    const nextRaw = next.get(storeId);
    const nextQty = nextRaw === undefined ? baseQty : milli(nextRaw || '0');
    if (nextQty < baseQty) return null;
    if (nextQty === 0n) continue;
    const add = nextQty - baseQty;
    added += add;
    total += nextQty;
    let price: string;
    let method: PaymentMethod;
    if (!b) {
      price = topUpPrice;
      method = topUpMethod;
    } else if (add === 0n) {
      price = b.unitPrice;
      method = b.paymentMethod;
    } else {
      // (base qty × base price + added × top-up price) / new qty, in cents.
      const sum = baseQty * cents(b.unitPrice) + add * cents(topUpPrice);
      price = centsText((sum * 2n + nextQty) / (nextQty * 2n));
      method = b.paymentMethod;
    }
    storeSplits.push({
      storeId,
      qty: milliText(nextQty),
      ...(Number(price) !== Number(item.unitPrice) ? { unitPrice: price } : {}),
      ...(method !== item.paymentMethod ? { paymentMethod: method } : {}),
    });
  }
  if (added === 0n) return null;
  return {
    unitPrice: item.unitPrice,
    paymentMethod: item.paymentMethod,
    actualQty: milliText(total),
    storeSplits,
  };
}
