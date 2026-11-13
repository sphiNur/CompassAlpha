/**
 * Shared run-domain types (Phase 4 step 4 of the 2026-07 frontend audit).
 *
 * ActiveRun is run.get's payload as the orchestrator (RunPage) and every
 * grouped view / row leaf read it. Review RUNWEB1-19 / RUNWEB2-31
 * (2026-11-12): it, and the history list's row, are the server's own
 * types now (RouterOutputs), where they were written out by hand.
 */
import type { PaymentMethod } from '@compass/contracts';
import type { ProductNameParts } from '../../lib/productName';
import type { RouterOutputs } from '../../lib/trpc';

/**
 * Preview-shaped rows for the pre-run summary card (整体 / 按店铺 /
 * 按摊位). Moved here from RunPanels.tsx (2026-07-26) so `runs/lib`
 * can build the share-text strings as pure, testable functions instead
 * of closures trapped inside the component.
 */
export type PreviewLine = {
  id: string;
  kind: 'sku' | 'extra';
  skuId: string | null;
  /** The whole name, both languages in one string: what the search matches and the rows sort by. */
  name: string;
  /**
   * A catalog product's name in two parts, shown as two lines (UI-4,
   * RUNWEB1-09). Absent for an extra, which has only what was typed.
   */
  nameParts?: ProductNameParts;
  qty: string;
  unit: string;
  unitPrice: string | null;
  total: number | null;
  note?: string;
  /**
   * Preferred stall for this SKU, resolved ONCE when the line is built
   * (2026-07-26). Null for extras — an off-catalog item has no SKU and so
   * can never carry a supplier link — and for SKUs nobody has assigned.
   * The by-supplier grouping reads this instead of re-resolving, so the
   * two views cannot disagree about where an item comes from.
   */
  supplierId?: string | null;
  supplierName?: string | null;
};

export type PreviewStoreGroup = {
  storeId: string;
  storeName: string;
  items: PreviewLine[];
  total: number;
  unknownCount: number;
  legacyNote?: string;
};

export type PreviewSupplierGroup = {
  supplierId: string | null;
  supplierName: string;
  contactPhone: string | null;
  contactTg: string | null;
  stores: PreviewStoreGroup[];
  total: number;
  unknownCount: number;
};

type RunGet = RouterOutputs['run']['get'];
type RunGetItem = RunGet['items'][number];
type RunGetSplit = RunGet['splits'][number];
type RunGetExtra = RunGet['sessionExtrasByStore'][string][number];

/** R2-INT-1 / CMP-BUY-2: a write queued offline, not on the server yet. */
interface PendingSync {
  pendingSync?: boolean;
}

/**
 * A product on the run, by run.get's types. The parts a row can do
 * without are optional, as they always were here:
 *   - paymentMethod (M1.14): 'cash' | 'transfer'; a row without one is
 *     cash.
 *   - addedByPurchaser (M3.41): added mid-run by the purchaser (the "+"
 *     badge, and its line in the finish summary).
 *   - topUpQty (BUY-5): demand that joined after the item was decided.
 */
export type RunItem = Pick<
  RunGetItem,
  'skuId' | 'plannedQty' | 'purchasedQty' | 'status' | 'unavailableNote' | 'unitPrice'
> &
  Partial<
    Pick<
      RunGetItem,
      'supplierId' | 'receiptPhotoUrl' | 'paymentMethod' | 'addedByPurchaser' | 'topUpQty'
    >
  > &
  PendingSync;

/**
 * One store's share of a product. confirmStatus is the receiver's
 * verdict on the line (ok | short | wrong | quality); on a problem line,
 * confirmReceivedQty is what arrived (CA-06) and confirmNote /
 * confirmPhotoUrl the receiver's note and photo (DLV-7).
 */
export type RunSplit = Pick<
  RunGetSplit,
  'runId' | 'skuId' | 'storeId' | 'qty' | 'deliveredAt' | 'confirmedAt'
> &
  Partial<
    Pick<
      RunGetSplit,
      | 'unitPrice'
      | 'paymentMethod'
      | 'confirmStatus'
      | 'confirmReceivedQty'
      | 'confirmNote'
      | 'confirmPhotoUrl'
    >
  > &
  PendingSync;

/**
 * An off-catalog expense (M3.44), active (not removed). A store's share
 * is {storeId, qty} only: unlike an item's split it has no price or
 * method of its own (RunExpenseAdded keeps none).
 */
export type RunExpense = RunGet['expenses'][number] & PendingSync;

/**
 * run.get's payload. A field a screen can do without stays optional, so
 * a run saved for an offline start before the field existed, and the
 * tests' small runs, still fit; a field the server renames or retypes
 * fails to compile here instead of reading as absent. Of note:
 *   - status is the server's text column: a string, not a union.
 *   - dispatchDeniedStoreIds (DLV-14): stores this actor may not dispatch
 *     to (store-scoped deny).
 *   - purchaseScopeStoreIds (BUY-6): stores this actor purchases for;
 *     null/absent = all. otherStoreSkuIds: items that also serve stores
 *     outside it (read-only); otherStoreExpenseIds (D9): expenses split
 *     to such stores (not removable).
 *   - finishBlockedReason (RE-DLV-3): why finish (or closing a
 *     correction) would be refused for this actor, as an error key.
 *   - lastPriceObservedAtBySku: when each reference price was observed
 *     (ISO). Parallel to lastPriceBySku rather than folded into it: that
 *     map feeds the inline price prefill in three places, and reshaping
 *     the money path to carry a timestamp is a bad trade for a display
 *     concern.
 *   - sessionNotesByStore (M1.8): each store's session notes ("其他物品",
 *     legacy); sessionExtrasByStore (M3.16-C) the structured ones.
 *   - money (2026-10-21 CA-11): the server's items / expenses / total.
 *   - supplierBySku (M3.27): each SKU's preferred supplier, for the "by
 *     vendor" view; null = none ("unassigned").
 */
export type ActiveRun = Pick<RunGet, 'id' | 'status'> &
  Partial<
    Pick<
      RunGet,
      | 'dispatchDeniedStoreIds'
      | 'purchaseScopeStoreIds'
      | 'otherStoreSkuIds'
      | 'otherStoreExpenseIds'
      | 'finishBlockedReason'
      | 'perStoreDemand'
      | 'sessions'
      | 'lastPriceBySku'
      | 'lastPriceObservedAtBySku'
      | 'sessionNotesByStore'
      | 'money'
      | 'supplierBySku'
    >
  > & {
    items: RunItem[];
    splits: RunSplit[];
    sessionExtrasByStore?: Record<string, RunExtra[]>;
    expenses?: RunExpense[];
  };

/**
 * Review RUNWEB1-19 (2026-11-12): the shapes the run screens pass around,
 * once each here (they were typed out at every component's props).
 */
/** A product as the run screens use it (catalog.skus by id). */
export type SkuLite = {
  id: string;
  names: Record<string, string>;
  unit: string;
  step: string;
  categoryId?: string | null;
};

/** A store as the run screens use it (catalog.stores by id). */
export type StoreLite = { id: string; name: string; code: string | null };

/** What a purchase row's ✓ records (run.purchaseItem). */
export type InlinePurchase = {
  skuId: string;
  actualQty: string;
  unitPrice: string;
  /**
   * Where the purchase actually happened. Only the by-stall view can
   * know this (the purchaser is working one stall at a time), so the
   * other views omit it and the handler falls back to null rather
   * than guessing from the SKU's preferred supplier.
   */
  supplierId?: string | null;
  storeSplits: Array<{
    storeId: string;
    qty: string;
    unitPrice?: string;
    paymentMethod?: PaymentMethod;
  }>;
  paymentMethod: PaymentMethod;
};

/**
 * What a purchase row can do (review RUNWEB1-19): one object, handed from
 * the panel through the grouped views to each row, instead of seven
 * handlers threaded through every view. The panel builds it from stable
 * stand-ins (useStableCallbacks), so the memo()'d rows hold.
 */
export interface RunRowActions {
  /**
   * Flip the price field between UZS and thousands-of-UZS (2026-07-30).
   *
   * The control used to be a `×千` pill in the sticky bar whose meaning
   * lived ONLY in a `title` attribute — invisible on touch, where there is
   * no hover. It defaulted to ON and silently multiplied every price the
   * purchaser typed by 1000. Moving it onto the unit suffix beside the
   * price input puts it where the user is already looking when the setting
   * matters, and lets the suffix state the current unit instead of naming
   * an operation.
   */
  togglePriceUnit: () => void;
  /** Record the purchase (✓). Only the by-stall view sends supplierId. */
  save: (payload: InlinePurchase) => void;
  markNa: (skuId: string) => void;
  /** Open a bought row's purchase for correction. */
  edit: (item: RunItem) => void;
  /** Mark a not-available row available again. Absent while the goods
   *  are going out (review RUNAPI-02). */
  unmark?: (skuId: string, skuName: string) => void;
  /** The full purchase sheet, for a split the row cannot work out. */
  openAdvanced: (item: RunItem) => void;
  /**
   * Correct the payment method of an ALREADY purchased row, from the row
   * itself.
   *
   * The one-tap ✓ path has no method control, and `paymentMethod`
   * defaults to 'cash' — so since the collapsed row became the default
   * for every priced item, the fast path has been booking everything as
   * cash and `totalCash` / `totalTransfer` drift by construction.
   *
   * This deliberately does NOT go through `save`. That reaches
   * `PurchaseItem`, which has no already-purchased guard and emits a
   * fresh `ItemPurchased`; the projection then appends an undeduped
   * `price_history` row per tap and upserts `run_item_stores_v` with
   * `unitPrice: split.unitPrice ?? null`, silently erasing per-store
   * price overrides. The caller routes this through `revisePurchase`.
   */
  setPaymentMethod: (item: RunItem, next: PaymentMethod) => void;
  /**
   * The method the one-tap ✓ records: the one the purchaser last chose
   * in this run, or cash (R10, 2026-11-13; runs/lib/lastPayment.ts). Read
   * at the tap.
   */
  quickPaymentMethod: () => PaymentMethod;
}

/** An "other item"'s outcome (M3.37); a row without one is pending. */
export type ExtraStatus = NonNullable<RunGetExtra['status']>;

/**
 * An "other item" a store asked for, as run.get lists it (M3.16-C), with
 * its place in its session for order.markExtraStatus (M3.37) and the
 * session's lastSeq, sent back as expectedSeq (APR-18). Those three are
 * optional here: a run saved before they existed has none.
 */
export type RunExtra = Omit<RunGetExtra, 'sessionId' | 'idx' | 'sessionSeq'> &
  Partial<Pick<RunGetExtra, 'sessionId' | 'idx' | 'sessionSeq'>>;

/**
 * Marks one "other item" (M3.37). Settles, never rejects, once the server
 * has answered, so the row can wait for it (RUNWEB1-17).
 */
export type MarkExtraStatus = (
  sessionId: string,
  extraIndex: number,
  status: ExtraStatus,
  /** APR-18: the session's lastSeq the row was read at. */
  expectedSeq?: number,
) => Promise<void>;

const otherCache = new WeakMap<string[], ReadonlySet<string>>();
/** BUY-6: the read-only item set, stable per run.get payload. */
export function otherStoreSkusOf(run: Pick<ActiveRun, 'otherStoreSkuIds'>): ReadonlySet<string> {
  const ids = run.otherStoreSkuIds ?? [];
  let set = otherCache.get(ids);
  if (!set) {
    set = new Set(ids);
    otherCache.set(ids, set);
  }
  return set;
}

type HistoryRow = RouterOutputs['run']['history']['rows'][number];
type HistoryStoreTotal = HistoryRow['storeTotals'][number];

/**
 * A row of run.history: one finished or cancelled run and its totals, by
 * the server's types (review RUNWEB2-31). actualTotal is items + expenses
 * (2026-10-21 CA-11: itemsTotal and expensesTotal are its parts), and
 * actualCashTotal / actualTransferTotal its cash and transfer parts
 * (M1.14). Those two may be null where a run predates the split: the
 * list then shows the total alone (the server sends 0 for such a run now).
 */
export type RunListRow = Pick<
  HistoryRow,
  | 'id'
  | 'runDate'
  | 'runIndex'
  | 'status'
  | 'actualTotal'
  | 'itemsTotal'
  | 'expensesTotal'
  | 'finishedAt'
> & {
  actualCashTotal: HistoryRow['actualCashTotal'] | null;
  actualTransferTotal: HistoryRow['actualTransferTotal'] | null;
  storeTotals: RunListStoreTotal[];
};

/** A store's part of a history row; its items / expenses parts may be absent. */
export type RunListStoreTotal = Pick<
  HistoryStoreTotal,
  'storeId' | 'total' | 'cash' | 'transfer' | 'itemCount'
> &
  Partial<Pick<HistoryStoreTotal, 'itemsTotal' | 'expensesTotal'>>;
