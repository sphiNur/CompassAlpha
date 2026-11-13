/**
 * The "+ add" sheet's form: a new one, and what its save sends.
 *
 * A product new to the run becomes a row the purchaser added. A product
 * already on the run is not added twice: the new store joins its row (a
 * pending row is bought for its stores and the new one, a bought row is
 * revised), or, when the store already has the product or the purchaser
 * chose it, the purchase is recorded as a separate cost. The expense tab
 * records an expense.
 *
 * Review RUNWEB1-04 (2026-11-12): this choice sat in the sheet's onSubmit
 * in RunPage, between four mutations, with no test; the three new
 * forms were three copies of one literal. Tests in __tests__/addItem.test.ts.
 */
import { newClientId } from '../../../lib/clientId';
import type { MutationInput } from '../../../lib/trpcPaths';
import type { AddItemDraft } from '../sheets/drafts';
import type { ActiveRun } from '../types';
import { mergeIntoPurchasedItem, mergeSplitsIntoExistingItem } from './runStores';

/**
 * An empty form for a run; `fields` holds what this way in fills (the
 * expense tab, an other item a store asked for). M3.44: the expense id
 * is made even on the product tab, so switching tabs mid-form already
 * has the id ready (idempotency).
 */
export function newAddItemDraft(runId: string, fields: Partial<AddItemDraft> = {}): AddItemDraft {
  return {
    mode: 'sku',
    runId,
    skuId: null,
    supplierId: null,
    skuCostMode: 'merge',
    expenseId: fields.expenseId ?? newClientId(),
    label: '',
    unitHint: '',
    expenseScope: 'shared',
    actualQty: '',
    unitPrice: '',
    splits: new Map(),
    splitPrices: new Map(),
    splitPaymentMethods: new Map(),
    perStorePricing: false,
    paymentMethod: 'cash',
    receiptPhotoUrl: null,
    reason: '',
    ...fields,
  };
}

export type AddItemCommand =
  | { procedure: 'addExpense'; input: MutationInput<'run.addExpense'> }
  | { procedure: 'purchaseItem'; input: MutationInput<'run.purchaseItem'> }
  | { procedure: 'revisePurchase'; input: MutationInput<'run.revisePurchase'> }
  | { procedure: 'addPurchaserItem'; input: MutationInput<'run.addPurchaserItem'> }
  /** Review RUNWEB1-38: the product is not in the catalog list, so nothing is saved. */
  | { procedure: 'missingProduct' };

export interface AddItemContext {
  /** run.get, with the writes still waiting offline laid over it. */
  run: Pick<ActiveRun, 'items' | 'splits' | 'perStoreDemand'> | undefined;
  /** A catalog product's name in the UI language and its unit; null when it is not in the list. */
  product: (skuId: string) => { name: string; unit: string } | null;
  /** The purchaser was asked about the price and kept it. */
  priceConfirmed?: boolean;
  /** i18n.t('run.action.addItem.defaultCrossStoreReason') */
  crossStoreReason: string;
}

/** null: nothing to send yet (no product picked, or an expense without a name). */
export function planAddItemSubmit(d: AddItemDraft, ctx: AddItemContext): AddItemCommand | null {
  const { run, priceConfirmed } = ctx;
  const storeSplits = [...d.splits.entries()]
    .filter(([, q]) => Number(q) > 0)
    .map(([storeId, qty]) => ({ storeId, qty }));
  if (d.mode === 'sku') {
    if (!d.skuId) return null;
    // M3.54: detect cross-store augmentation case. If the SKU
    // is already in this run for OTHER stores (no overlap with
    // the new storeSplits — sheet's store-picker filter
    // already enforced that), route the submit through the
    // right existing-item mutation:
    //   - pending  → purchaseItem, merging existing demand
    //     splits with the new store split(s). The whole item
    //     gets marked purchased at the typed unitPrice (the
    //     purchaser is at the stall buying it now anyway).
    //   - purchased → revisePurchase, merging actual splits
    //     with the new store split(s). Reason gets reused
    //     from the sheet's reason field.
    //   - unavailable → blocked at the picker stage (SKU is
    //     filtered out), so this branch shouldn't fire.
    // Falls back to addPurchaserItem when the SKU is truly
    // new to the run (the only path that creates a fresh
    // purchaser-added row).
    const existingItem = run?.items.find((it) => it.skuId === d.skuId);
    const existingSplits = (run?.splits ?? []).filter((sp) => sp.skuId === d.skuId);
    const existingStoreIds = new Set(existingSplits.map((sp) => sp.storeId));
    const overlapsExistingStore = storeSplits.some((sp) => existingStoreIds.has(sp.storeId));
    if (existingItem && (d.skuCostMode === 'separateExpense' || overlapsExistingStore)) {
      const sku = ctx.product(d.skuId);
      // Review RUNWEB1-38: the label is saved with the expense, and
      // the id's first characters were saved when the product was
      // not at hand. It was picked from this list, so that does
      // not happen; if it ever does, nothing is saved.
      if (!sku) return { procedure: 'missingProduct' };
      return {
        procedure: 'addExpense',
        input: {
          runId: d.runId,
          expenseId: d.expenseId,
          label: sku.name,
          ...(sku.unit ? { unitHint: sku.unit } : {}),
          qty: d.actualQty,
          unitPrice: d.unitPrice,
          storeSplits,
          paymentMethod: d.paymentMethod,
          receiptPhotoUrl: d.receiptPhotoUrl,
          reason: d.reason.trim(),
        },
      };
    }
    if (existingItem) {
      // 2026-10-21 audit CA-29 (C-05): a pending row has no splits
      // yet, so its base is the other stores' demand — merging
      // onto the (empty) splits dropped their order.
      const { splits: combinedSplits, totalQty: combinedQty } = mergeSplitsIntoExistingItem({
        status: existingItem.status,
        existingSplits,
        demand: (run?.perStoreDemand ?? []).filter((dm) => dm.skuId === d.skuId),
        newSplits: storeSplits,
      });
      if (existingItem.status === 'pending') {
        // Closed by the answer (RUNWEB1-02): a refused merge keeps
        // the product, quantity, price, stores and reason typed.
        return {
          procedure: 'purchaseItem',
          input: {
            runId: d.runId,
            skuId: d.skuId,
            supplierId: d.supplierId,
            unitPrice: d.unitPrice,
            actualQty: combinedQty,
            receiptPhotoUrl: d.receiptPhotoUrl,
            storeSplits: combinedSplits,
            paymentMethod: d.paymentMethod,
            ...(priceConfirmed ? { priceConfirmed: true } : {}),
          },
        };
      }
      if (existingItem.status === 'purchased') {
        // 2026-10-21 FE-04 (F3-07): keep the row's supplier,
        // receipt and per-store price/payment overrides; only the
        // new store's split is appended (see mergeIntoPurchasedItem).
        const merged = mergeIntoPurchasedItem({
          item: existingItem,
          existingSplits,
          newSplits: storeSplits,
          draft: {
            unitPrice: d.unitPrice,
            paymentMethod: d.paymentMethod,
            supplierId: d.supplierId,
            receiptPhotoUrl: d.receiptPhotoUrl,
          },
        });
        return {
          procedure: 'revisePurchase',
          input: {
            runId: d.runId,
            skuId: d.skuId,
            ...merged,
            ...(priceConfirmed ? { priceConfirmed: true } : {}),
            reason: d.reason.trim() || ctx.crossStoreReason,
          },
        };
      }
      // unavailable — should be unreachable (filtered out
      // in the picker). Fall through and let the backend
      // 400 just in case the data races.
    }
    return {
      procedure: 'addPurchaserItem',
      input: {
        runId: d.runId,
        skuId: d.skuId,
        supplierId: d.supplierId,
        unitPrice: d.unitPrice,
        actualQty: d.actualQty,
        receiptPhotoUrl: d.receiptPhotoUrl,
        storeSplits,
        paymentMethod: d.paymentMethod,
        ...(priceConfirmed ? { priceConfirmed: true } : {}),
        reason: d.reason.trim(),
      },
    };
  }
  // M3.44: expense mode → run.addExpense
  if (!d.label.trim()) return null;
  return {
    procedure: 'addExpense',
    input: {
      runId: d.runId,
      expenseId: d.expenseId,
      label: d.label.trim(),
      ...(d.unitHint.trim() ? { unitHint: d.unitHint.trim() } : {}),
      qty: d.actualQty,
      unitPrice: d.unitPrice,
      storeSplits,
      paymentMethod: d.paymentMethod,
      receiptPhotoUrl: d.receiptPhotoUrl,
      reason: d.reason.trim(),
    },
  };
}
