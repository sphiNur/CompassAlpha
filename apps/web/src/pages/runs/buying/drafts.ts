/**
 * What the two editors on the run screen are filled in with. The run
 * page holds the draft; the sheet edits it and hands it back to submit.
 */

/** Recording, or correcting, the purchase of one planned line. */
export interface PurchaseDraft {
  /**
   * Correcting a purchase that is already recorded. Saving then revises
   * it, and a reason is required.
   */
  isEdit: boolean;
  skuId: string;
  runId: string;
  /** Always in whole currency units, however the price is typed. */
  unitPrice: string;
  actualQty: string;
  supplierId: string | null;
  /** storeId → quantity. */
  splits: Map<string, string>;
  splitPrices: Map<string, string>;
  splitPaymentMethods: Map<string, 'cash' | 'transfer'>;
  perStorePricing: boolean;
  receiptPhotoUrl: string | null;
  reason: string;
  paymentMethod: 'cash' | 'transfer';
}

/**
 * Adding something that was not planned. Either a catalogue product a
 * store turns out to need (`sku`), or spending that is not a product at
 * all (`expense`: a porter, bags). The shared fields survive a switch
 * between the two, so a tap on the wrong one costs nothing.
 */
export interface AddItemDraft {
  mode: 'sku' | 'expense';
  runId: string;
  skuId: string | null;
  supplierId: string | null;
  /**
   * For a product already on the run: fold the extra into its line, or
   * record it as a separate cost for one store (it may have its own price).
   */
  skuCostMode: 'merge' | 'separateExpense';
  /** Made when the sheet opens, so a retried save cannot create two. */
  expenseId: string;
  label: string;
  unitHint: string;
  /** Shared between stores evenly, or belonging to one. */
  expenseScope: 'shared' | 'store';
  actualQty: string;
  unitPrice: string;
  /** storeId → quantity. Only stores already on the run. */
  splits: Map<string, string>;
  splitPrices: Map<string, string>;
  splitPaymentMethods: Map<string, 'cash' | 'transfer'>;
  perStorePricing: boolean;
  paymentMethod: 'cash' | 'transfer';
  receiptPhotoUrl: string | null;
  reason: string;
}
