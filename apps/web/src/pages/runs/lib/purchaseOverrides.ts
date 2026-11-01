/**
 * Per-store price / payment overrides in the purchase sheet (2026-10-25).
 *
 * A split may carry its own unitPrice / paymentMethod; money everywhere
 * uses the split's value first and the item's only as a fallback. The
 * sheet used to:
 *   - write an explicit override onto EVERY split as soon as "per-store
 *     pricing" was switched on, even where it equalled the item value;
 *   - re-open an edit in per-store mode whenever any override existed;
 *   - leave those copies alone when the item-level method or price was
 *     changed afterwards.
 * So a single-store line switched to transfer at the top of the sheet
 * kept its split's "cash": the event recorded item = transfer, split =
 * cash, the money (and the purchaser's row) said cash, and the history
 * line said transfer.
 *
 * Now an override is only ever what differs from the item, an edit opens
 * in per-store mode only when the stores really differ, and changing the
 * item-level value moves the stores that were following it.
 *
 * Pure; tests in __tests__/purchaseOverrides.test.ts.
 */
export type PaymentMethod = 'cash' | 'transfer';

type SplitIn = {
  storeId: string;
  qty: string;
  unitPrice?: string | null;
  paymentMethod?: string | null;
};

const samePrice = (a: string | null | undefined, b: string | null | undefined) =>
  Number(a || 0) === Number(b || 0);

const asMethod = (m: string | null | undefined): PaymentMethod =>
  m === 'transfer' ? 'transfer' : 'cash';

/**
 * Sheet state for editing a purchased line, from what money actually
 * uses (each split's effective price and method).
 */
export function editPricingFromSplits(
  item: { unitPrice: string | null; paymentMethod?: string | null },
  splits: readonly SplitIn[],
): {
  unitPrice: string;
  paymentMethod: PaymentMethod;
  splitPrices: Map<string, string>;
  splitPaymentMethods: Map<string, PaymentMethod>;
  perStorePricing: boolean;
} {
  const live = splits.filter((sp) => Number(sp.qty) > 0);
  const eff = live.map((sp) => ({
    storeId: sp.storeId,
    price: sp.unitPrice ?? item.unitPrice ?? '',
    method: asMethod(sp.paymentMethod ?? item.paymentMethod),
  }));
  const first = eff[0];
  const uniform =
    !first || eff.every((e) => samePrice(e.price, first.price) && e.method === first.method);
  if (uniform) {
    return {
      unitPrice: first?.price || item.unitPrice || '',
      paymentMethod: first?.method ?? asMethod(item.paymentMethod),
      splitPrices: new Map(),
      splitPaymentMethods: new Map(),
      perStorePricing: false,
    };
  }
  return {
    unitPrice: item.unitPrice ?? '',
    paymentMethod: asMethod(item.paymentMethod),
    splitPrices: new Map(eff.map((e) => [e.storeId, e.price])),
    splitPaymentMethods: new Map(eff.map((e) => [e.storeId, e.method])),
    perStorePricing: true,
  };
}

/** The overrides to send for one store: only what differs from the item. */
export function splitOverridesFor(
  draft: {
    perStorePricing: boolean;
    unitPrice: string;
    paymentMethod: PaymentMethod;
    splitPrices: ReadonlyMap<string, string>;
    splitPaymentMethods: ReadonlyMap<string, PaymentMethod>;
  },
  storeId: string,
): { unitPrice?: string; paymentMethod?: PaymentMethod } {
  if (!draft.perStorePricing) return {};
  const price = draft.splitPrices.get(storeId) || draft.unitPrice;
  const method = draft.splitPaymentMethods.get(storeId) ?? draft.paymentMethod;
  return {
    ...(!samePrice(price, draft.unitPrice) ? { unitPrice: price } : {}),
    ...(method !== draft.paymentMethod ? { paymentMethod: method } : {}),
  };
}

/**
 * The item-level method changed: stores that were paying the old method
 * move with it; stores set to something else keep their choice.
 */
export function followPaymentMethod(
  splitPaymentMethods: ReadonlyMap<string, PaymentMethod>,
  from: PaymentMethod,
  to: PaymentMethod,
): Map<string, PaymentMethod> {
  const next = new Map(splitPaymentMethods);
  for (const [storeId, method] of next) if (method === from) next.set(storeId, to);
  return next;
}

/** Same for the item-level price. */
export function followUnitPrice(
  splitPrices: ReadonlyMap<string, string>,
  from: string,
  to: string,
): Map<string, string> {
  const next = new Map(splitPrices);
  for (const [storeId, price] of next) if (samePrice(price, from)) next.set(storeId, to);
  return next;
}

/**
 * DX-BUY-1 (2026-11-01): is this bought row paid per store, so that a
 * one-tap 现金 / 转账 switch on the row would not say what it changes?
 * Only a live split whose method differs from the item's counts. A split
 * that merely repeats the item's method (run.get used to resolve the
 * inherited value that way for store-scoped readers) is the same as the
 * item, so the row keeps its switch.
 */
export function paidPerStore(
  item: { paymentMethod?: string | null },
  splits: readonly SplitIn[],
): boolean {
  const itemMethod = asMethod(item.paymentMethod);
  return splits.some(
    (sp) => Number(sp.qty) > 0 && sp.paymentMethod != null && asMethod(sp.paymentMethod) !== itemMethod,
  );
}
