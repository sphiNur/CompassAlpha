/**
 * What closing a run is about to lock in: the numbers of the finish and
 * correction confirmations and of the purchase gauge, and what the
 * stores signed for less than they are billed.
 *
 * Review RUNWEB1-04 (2026-11-12): both were inline in RunPage, a
 * 100-line useMemo and a sum inside the confirmation's text, with no
 * test. Pure; tests in __tests__/finishSummary.test.ts.
 */
import { addMoney } from '@compass/contracts/money';
import { milliQty, qtyMilliOrZero } from '@compass/contracts/quantity';
import { moneyLine } from '../../../lib/money';
import type { ActiveRun } from '../types';
import { countCarriedOver } from './priceState';
import { expenseLine, settleItemLine, settlePerStore, type StoreSettlement } from './settlement';

export type FinishSummary = {
  /** Purchased rows. */
  skus: number;
  /** Stores with a split. */
  stores: number;
  /** Items and expenses as summed here; the gauge shows it. */
  total: number;
  /** The one money definition: run.get's figures, or the sums here from an older server. */
  money: { items: number; expenses: number; total: number };
  totalCash: number;
  totalTransfer: number;
  /** Rows the purchaser added beyond the orders, and what they cost. */
  addedSkus: number;
  addedTotal: number;
  expensesCount: number;
  expensesTotal: number;
  /** Prices that only repeat the last trip's, and how many of those were already old. */
  carriedOver: number;
  carriedOverStale: number;
  /** Each store's bill, largest first. */
  byStore: StoreSettlement[];
};

type SummaryRun = Pick<
  ActiveRun,
  'items' | 'splits' | 'expenses' | 'lastPriceBySku' | 'lastPriceObservedAtBySku' | 'money'
>;

export function finishSummaryOf(run: SummaryRun | undefined, now: number): FinishSummary {
  const items = run?.items ?? [];
  const splits = run?.splits ?? [];
  const expenses = run?.expenses ?? [];
  const skus = items.filter((i) => i.status === 'purchased').length;
  const stores = new Set(splits.map((sp) => sp.storeId)).size;
  let total = 0;
  let totalCash = 0;
  let totalTransfer = 0;
  // M3.41 (2026-05-21): track purchaser-added rows separately so the
  // finish confirm sheet can call out "Z items added beyond the
  // original order, total W UZS". The manager reviewing the run sees
  // this at a glance — no hunting through audit logs to spot
  // off-plan spending.
  let addedSkus = 0;
  let addedTotal = 0;
  for (const it of items) {
    if (it.status === 'purchased' && it.unitPrice && it.purchasedQty) {
      const itemSplits = splits.filter((sp) => sp.skuId === it.skuId);
      const { line, cash, transfer } = settleItemLine(it, itemSplits);
      total = addMoney(total, line);
      totalCash = addMoney(totalCash, cash);
      totalTransfer = addMoney(totalTransfer, transfer);
      if (it.addedByPurchaser) {
        addedSkus += 1;
        addedTotal = addMoney(addedTotal, line);
      }
    }
  }
  // M3.44 (2026-05-22): off-catalog expenses roll into the grand
  // total and the cash/transfer breakdown the same way SKU buys do.
  // Counted separately for the "Off-catalog / expenses" line in the
  // finish confirm body so the manager can read them as their own
  // bucket.
  let expensesCount = 0;
  let expensesTotal = 0;
  for (const ex of expenses) {
    const line = expenseLine(ex);
    expensesCount += 1;
    expensesTotal = addMoney(expensesTotal, line);
    total = addMoney(total, line);
    if (ex.paymentMethod === 'transfer') totalTransfer = addMoney(totalTransfer, line);
    else totalCash = addMoney(totalCash, line);
  }
  /**
   * M3.52 (2026-05-23): per-store settlement preview shown in the
   * finish-confirm sheet. The user asked that the post-purchase
   * settlement strictly segregate each store's bill so the manager
   * can read it without mentally untangling cross-store totals.
   * Same shape as the history-sheet breakdown (SKU lines + expense
   * splits, never mixing across stores).
   */
  // 2026-07-26: this loop was duplicated verbatim in RunHistory's
  // detail breakdown. Same money, two copies, no tests — exactly the
  // shape that lets a later edit silently move one number and not the
  // other. It now lives in runs/lib/settlement.ts with tests; the
  // extra fields (skuIds / expense counters) are the history sheet's
  // and are simply unused here.
  const byStoreList = [...settlePerStore(items, splits, expenses).values()].sort(
    (a, b) => b.total - a.total,
  );
  // Q7(b): how many of these prices are simply last trip's price
  // again, and how many of those references were already old. See
  // countCarriedOver — this is what makes hiding the price editor
  // defensible.
  const { carried: carriedOver, stale: carriedOverStale } = countCarriedOver(
    items,
    run?.lastPriceBySku ?? {},
    run?.lastPriceObservedAtBySku ?? {},
    now,
  );
  /**
   * 2026-10-21 CA-11: the one purchase-money definition — items (with
   * per-store override prices) / expenses / total — taken from run.get's
   * server-computed `money` so the sheet shows exactly what History,
   * Finance and the finish notification show. The local sums above are
   * the fallback for an older server and still drive the cash/transfer
   * and per-store breakdowns (same math, see runs/lib/settlement.ts).
   */
  const serverMoney = run?.money;
  const money = {
    items: serverMoney ? Number(serverMoney.itemsTotal) : addMoney(total, -expensesTotal),
    expenses: serverMoney ? Number(serverMoney.expensesTotal) : expensesTotal,
    total: serverMoney ? Number(serverMoney.total) : total,
  };
  return {
    skus,
    stores,
    total,
    money,
    totalCash,
    totalTransfer,
    addedSkus,
    addedTotal,
    expensesCount,
    expensesTotal,
    carriedOver,
    carriedOverStale,
    byStore: byStoreList,
  };
}

/**
 * DLV-11 (2026-10-30): the bills still charge each store for what was
 * split to it, even where the store signed for less. The lines signed
 * short, wrong or spoiled, and roughly how much was not received: each
 * line's missing quantity at its store's price, or the item's.
 */
export function receiptShortfall(run: Pick<ActiveRun, 'items' | 'splits'> | undefined): {
  issues: ActiveRun['splits'];
  missingValue: number;
} {
  const issues = (run?.splits ?? []).filter(
    (sp) => sp.confirmStatus != null && sp.confirmStatus !== 'ok',
  );
  const itemPrice = new Map((run?.items ?? []).map((it) => [it.skuId, it.unitPrice]));
  const missingValue = issues.reduce((sum, sp) => {
    const price = sp.unitPrice ?? itemPrice.get(sp.skuId) ?? 0;
    // DX-PFE-12: half-up cents per line (D1). Review QTY-05
    // (2026-11-11): the shortfall is exact, not a float difference
    // trimmed with toFixed(3).
    const missing = qtyMilliOrZero(sp.qty) - qtyMilliOrZero(sp.confirmReceivedQty);
    return missing > 0n ? addMoney(sum, moneyLine(milliQty(missing), price)) : sum;
  }, 0);
  return { issues, missingValue };
}
