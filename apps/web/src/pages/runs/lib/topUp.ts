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
import { toCents } from '@compass/contracts/money';
import { milliQty, qtyMilliOrZero } from '@compass/contracts/quantity';
import type { PaymentMethod } from '@compass/contracts';
import type { PurchaseDraft } from '../sheets/drafts';
import { editPricingFromSplits } from './purchaseOverrides';
import { paymentMethodOrCash } from '../../../lib/paymentMethod';

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

// Quantities in whole thousandths and prices in cents, never floats. A
// field can hold text a number input accepts but a decimal is not
// ("1e3"); that is read through Number, as before.
const finite = (v: string): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const cents = (v: string): bigint => {
  try {
    return toCents(v);
  } catch {
    return toCents(finite(v));
  }
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
  /**
   * Each store's quantity after the top-up, as the sheet holds it. The
   * sheet drops a store whose field was cleared, and shows it empty, so a
   * store missing here has nothing now (RUNWEB2-08: it used to keep its
   * earlier quantity, and the revision saved more than the sheet showed).
   */
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
    const baseQty = b ? qtyMilliOrZero(b.qty) : 0n;
    const nextQty = qtyMilliOrZero(next.get(storeId));
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
      qty: milliQty(nextQty),
      ...(Number(price) !== Number(item.unitPrice) ? { unitPrice: price } : {}),
      ...(method !== item.paymentMethod ? { paymentMethod: method } : {}),
    });
  }
  if (added === 0n) return null;
  return {
    unitPrice: item.unitPrice,
    paymentMethod: item.paymentMethod,
    actualQty: milliQty(total),
    storeSplits,
  };
}

/**
 * RUNWEB1-03 (2026-11-09): where the extra quantity goes when the top-up
 * sheet opens. It fills the stores whose demand is not yet covered, in
 * demand order, and the rest stays on the total. Worked in whole
 * thousandths: as floats, 1.1 + 0.2 put "1.3000000000000003" in a store's
 * field, which the server refuses (3 decimals at most).
 */
export function topUpPrefill(input: {
  /** Each store's quantity as the sheet opened with it. */
  splits: ReadonlyMap<string, string>;
  /** What each store's orders ask for. */
  demand: ReadonlyArray<{ storeId: string; qty: string }>;
  /** The quantity still to buy (the row's topUpQty). */
  extra: string | null | undefined;
}): { splits: Map<string, string>; actualQty: string } {
  const splits = new Map(input.splits);
  let remaining = qtyMilliOrZero(input.extra);
  for (const dm of input.demand) {
    if (remaining <= 0n) break;
    const have = qtyMilliOrZero(splits.get(dm.storeId));
    const gap = qtyMilliOrZero(dm.qty) - have;
    if (gap <= 0n) continue;
    const add = gap < remaining ? gap : remaining;
    splits.set(dm.storeId, milliQty(have + add));
    remaining -= add;
  }
  let total = remaining > 0n ? remaining : 0n;
  for (const qty of splits.values()) total += qtyMilliOrZero(qty);
  return { splits, actualQty: milliQty(total) };
}

export type TopUpBase = {
  item: { unitPrice: string; paymentMethod: PaymentMethod };
  base: BaseSplit[];
};

/**
 * The row as bought before the top-up, for topUpRevision: its price and
 * method, and each store's earlier quantity with its effective price and
 * method, so the sheet's price is this batch's only. Undefined when a
 * price is missing; the sheet then saves an ordinary revision.
 */
export function topUpBaseOf(
  item: { skuId: string; unitPrice: string | null; paymentMethod?: string | null },
  splits: ReadonlyArray<{
    skuId: string;
    storeId: string;
    qty: string;
    unitPrice?: string | null;
    paymentMethod?: string | null;
  }>,
): TopUpBase | undefined {
  const baseRows = splits.filter((sp) => sp.skuId === item.skuId && Number(sp.qty) > 0);
  const basePricing = editPricingFromSplits(item, baseRows);
  const baseItemPrice = item.unitPrice ?? basePricing.unitPrice;
  return baseItemPrice && baseRows.every((sp) => sp.unitPrice ?? baseItemPrice)
    ? {
        item: { unitPrice: baseItemPrice, paymentMethod: basePricing.paymentMethod },
        base: baseRows.map((sp) => ({
          storeId: sp.storeId,
          qty: sp.qty,
          unitPrice: sp.unitPrice ?? baseItemPrice,
          paymentMethod: paymentMethodOrCash(sp.paymentMethod ?? item.paymentMethod),
        })),
      }
    : undefined;
}

/**
 * The purchase sheet, opened on a bought row, made a top-up: the extra
 * goes where the demand is not yet covered (topUpPrefill), so it reaches
 * the stores that asked for it, not all of them; and with the earlier
 * batch known, the sheet's one price and method are this batch's only
 * (the stores' earlier prices are kept by the revision itself).
 */
export function topUpDraft(
  d: PurchaseDraft,
  input: {
    demand: ReadonlyArray<{ storeId: string; qty: string }>;
    extra: string | null | undefined;
    base: TopUpBase | undefined;
    /** i18n.t('run.topUp.reason') */
    reason: string;
  },
): PurchaseDraft {
  const { splits, actualQty } = topUpPrefill({
    splits: d.splits,
    demand: input.demand,
    extra: input.extra,
  });
  return {
    ...d,
    splits,
    actualQty,
    reason: input.reason,
    ...(input.base
      ? {
          topUp: input.base,
          perStorePricing: false,
          splitPrices: new Map(),
          splitPaymentMethods: new Map(),
          unitPrice: input.base.item.unitPrice,
          paymentMethod: input.base.item.paymentMethod,
        }
      : {}),
  };
}
