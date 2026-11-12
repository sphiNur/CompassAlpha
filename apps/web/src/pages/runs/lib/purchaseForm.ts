/**
 * The purchase sheets' form rules in one place (review RUNWEB2-04,
 * RUNWEB2-07 and part of RUNWEB1-05, 2026-11-09).
 *
 * - Whether a purchase may be saved. PurchaseSheet's button and the page's
 *   main button each had a copy, and they had drifted: the page's still
 *   took a price with a third decimal, which the server refuses.
 * - Whether the store quantities add up to the quantity bought, by the
 *   server's own measure (`TOLERANCE` in packages/domain/src/run/commands.ts).
 *   The sheets allowed 0.001, so 1.001 split against 1 could be saved and
 *   came back refused.
 * - What counts as the person's own edit, for useDraftChanged: a tap
 *   outside a sheet throws the draft away without asking unless one of
 *   these changed. The store quantities and the stores' own prices and
 *   payment methods were missing, though they are what the full purchase
 *   form is for.
 *
 * Pure; tests in __tests__/purchaseForm.test.ts.
 */
import type { PaymentMethod } from '@compass/contracts';
import { isStorablePrice } from './priceMath';
import { splitOverridesFor } from './purchaseOverrides';

/** How far the store quantities' sum may be from the quantity bought, as the server allows. */
export const SPLIT_SUM_TOLERANCE = 1e-6;

/** The fields of the purchase sheet's draft that these rules read. */
export interface PurchaseFormDraft {
  isEdit: boolean;
  actualQty: string;
  unitPrice: string;
  supplierId: string | null;
  receiptPhotoUrl: string | null;
  reason: string;
  paymentMethod: PaymentMethod;
  /** storeId → qty */
  splits: ReadonlyMap<string, string>;
  splitPrices: ReadonlyMap<string, string>;
  splitPaymentMethods: ReadonlyMap<string, PaymentMethod>;
  perStorePricing: boolean;
}

/** The fields of the add-item sheet's draft that addItemDraftEdits reads. */
export interface AddItemFormDraft {
  mode: 'sku' | 'expense';
  skuId: string | null;
  skuCostMode: 'merge' | 'separateExpense';
  label: string;
  unitHint: string;
  expenseScope: 'shared' | 'store';
  actualQty: string;
  unitPrice: string;
  /** storeId → qty */
  splits: ReadonlyMap<string, string>;
  paymentMethod: PaymentMethod;
  receiptPhotoUrl: string | null;
  reason: string;
}

/** The store quantities' sum, and whether the server takes it as `total`. */
export function splitsAddUp(
  splits: ReadonlyMap<string, string>,
  total: string,
): { splitTotal: number; splitMatches: boolean } {
  let splitTotal = 0;
  for (const qty of splits.values()) splitTotal += Number(qty) || 0;
  return {
    splitTotal,
    splitMatches: Math.abs(splitTotal - Number(total || 0)) <= SPLIT_SUM_TOLERANCE,
  };
}

/** Whether the purchase sheet's draft may be saved, and what is missing. */
export function purchaseDraftCheck(d: PurchaseFormDraft): {
  splitTotal: number;
  splitMatches: boolean;
  reasonOk: boolean;
  canSubmit: boolean;
} {
  const { splitTotal, splitMatches } = splitsAddUp(d.splits, d.actualQty);
  const reasonOk = !d.isEdit || d.reason.trim().length > 0;
  // R2-BUY-2: prices in the server's format (above 0, ≤12 digits, ≤2
  // decimals), so a refused figure never reaches the 5× check or the API.
  const splitPricesOk =
    !d.perStorePricing ||
    [...d.splits.entries()]
      .filter(([, qty]) => Number(qty) > 0)
      .every(([storeId]) => isStorablePrice(d.splitPrices.get(storeId) || d.unitPrice));
  return {
    splitTotal,
    splitMatches,
    reasonOk,
    canSubmit:
      Number(d.actualQty) > 0 &&
      isStorablePrice(d.unitPrice) &&
      splitMatches &&
      reasonOk &&
      splitPricesOk,
  };
}

/**
 * What the person fills in on the purchase sheet, for useDraftChanged.
 *
 * With one store, its quantity is the quantity bought (the sheet copies
 * it in), so only which store counts; with several, each quantity is
 * typed. A store's own price or payment method counts where it differs
 * from the line's, which is all a save keeps (splitOverridesFor), so
 * switching per-store pricing on is not an edit by itself.
 */
export function purchaseDraftEdits(d: PurchaseFormDraft): unknown[] {
  const storeIds = [...d.splits.keys()].sort();
  return [
    d.actualQty,
    d.unitPrice,
    d.reason,
    d.supplierId,
    d.receiptPhotoUrl,
    d.paymentMethod,
    d.splits.size > 1 ? storeIds.map((id) => [id, d.splits.get(id)]) : storeIds,
    storeIds.map((id) => [id, splitOverridesFor(d, id)]),
  ];
}

/**
 * What the person fills in on the add-item sheet, for useDraftChanged.
 *
 * The store quantities follow the quantity, so only which stores counts.
 * A shared expense is spread over every store by an effect right after
 * the sheet opens, so there the stores are left out. Its store buttons
 * only appear after a label was typed or the scope was switched to
 * shared, and both of those count.
 */
export function addItemDraftEdits(d: AddItemFormDraft): unknown[] {
  return [
    d.skuId,
    d.label,
    d.unitHint,
    d.actualQty,
    d.unitPrice,
    d.reason,
    d.receiptPhotoUrl,
    d.paymentMethod,
    d.expenseScope,
    d.skuCostMode,
    d.mode === 'expense' && d.expenseScope === 'shared' ? null : [...d.splits.keys()].sort(),
  ];
}
