/**
 * What the purchase and "+ add" sheets edit, and what the "+ add" sheet
 * picks from (review RUNWEB2-09: these lived in the 1,300-line
 * RunSheets.tsx). RunPage holds the drafts in its state; runs/lib reads
 * them (addItem, purchaseForm, topUp).
 */
import type { PaymentMethod } from '@compass/contracts';

/**
 * M3.41 + M3.44 (2026-05-21 / 2026-05-22): draft state for the "+ add"
 * sheet. Dual-mode:
 *   - `mode: 'sku'`   → AddPurchaserItem mutation (target an existing
 *     SKU, single-store v1, requires supplierId/skuId).
 *   - `mode: 'expense'` → AddRunExpense mutation (free-text label,
 *     multi-store auto-split, target porter/taxi/off-catalog buys).
 *
 * Both modes share the quantity, price, payment and reason fields, and
 * switching modes keeps them. The switch clears the store split (each
 * mode picks stores its own way) and the identity field of the mode it
 * goes to (skuId or label). The renderer and the submit read only the
 * active mode's fields.
 *
 * expenseId is pre-generated when the sheet opens so the FE owns the
 * id from the start — enables an instant local "saved!" indicator
 * without a roundtrip, and the same id replays idempotently if the
 * mutation retries.
 */
export interface AddItemDraft {
  mode: 'sku' | 'expense';
  runId: string;
  /** SKU mode — selected SKU id; null until the user picks one. */
  skuId: string | null;
  /** SKU mode — preferred supplier on the SKU (optional override). */
  supplierId: string | null;
  /** Existing SKU mode: merge into the run row or record a store-level cost. */
  skuCostMode: 'merge' | 'separateExpense';
  /** Expense mode — pre-generated UUID. */
  expenseId: string;
  /** Expense mode — free-text identity. */
  label: string;
  /** Expense mode — optional unit hint ("trip", "pack", null). */
  unitHint: string;
  /** Shared costs are evenly allocated; store costs belong to one branch. */
  expenseScope: 'shared' | 'store';
  // Shared across both modes
  actualQty: string;
  unitPrice: string;
  /** storeId → qty. Only stores in the run's existing scope are valid. */
  splits: Map<string, string>;
  splitPrices: Map<string, string>;
  splitPaymentMethods: Map<string, PaymentMethod>;
  perStorePricing: boolean;
  paymentMethod: PaymentMethod;
  receiptPhotoUrl: string | null;
  reason: string;
}

export interface PurchaseDraft {
  /** When set, this is an EDIT of an existing purchase. The submit button
   *  switches to revisePurchase and the reason field becomes required. */
  isEdit: boolean;
  skuId: string;
  runId: string;
  unitPrice: string;
  actualQty: string;
  supplierId: string | null;
  splits: Map<string, string>; // storeId -> qty
  splitPrices: Map<string, string>;
  splitPaymentMethods: Map<string, PaymentMethod>;
  perStorePricing: boolean;
  receiptPhotoUrl: string | null;
  reason: string;
  /** 2026-10-30: the goods already went to a store, so only price,
   *  supplier, payment method and receipt may change. */
  qtyLocked?: boolean;
  /** M1.14: cash | transfer. Defaults to 'cash' for new purchases (the
   *  common case at the market). Edit pre-fills from the existing item. */
  paymentMethod: PaymentMethod;
  /** DX-BUY-2 (2026-11-01): set when the sheet buys the extra a newly
   *  attached order asks for. The row as bought before; the price and
   *  method in the sheet are this batch's only (lib/topUp.ts). */
  topUp?: {
    item: { unitPrice: string; paymentMethod: PaymentMethod };
    base: Array<{
      storeId: string;
      qty: string;
      unitPrice: string;
      paymentMethod: PaymentMethod;
    }>;
  };
}

/** A product the "+ add" sheet can pick (catalog.skus). */
export interface AddItemSku {
  id: string;
  names: Record<string, string>;
  code?: string | null;
  unit: string;
  step: string;
  isArchived: boolean;
}

/** A saved expense the "+ add" sheet offers as a one-tap start. */
export interface ExpenseTemplate {
  id: string;
  label: string;
  unitHint: string | null;
  defaultQty: string;
  /** Null for a reader without prices.view. */
  defaultUnitPrice: string | null;
  defaultPaymentMethod: string;
}

/**
 * M3.54 (2026-05-23): for each SKU already in the run, which storeIds
 * have demand AND the item's current status (see AddItemSheet).
 */
export type ExistingSkuStores = Map<string, { storeIds: Set<string>; status: string }>;
