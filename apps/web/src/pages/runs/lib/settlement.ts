/**
 * Run settlement money math — how a purchased item's cost resolves
 * against per-store split overrides and allocates into cash vs transfer.
 *
 * Extracted verbatim from RunPage.tsx (Phase 4 step 1 —
 * FRONTEND_AUDIT_2026-07.md run-domain split). All functions are pure
 * and structurally typed (duck-typed against the tRPC row shapes) so
 * they stay decoupled from the API client. Unit tests in
 * __tests__/settlement.test.ts.
 *
 * 2026-07-26: the per-store aggregation this header used to defer
 * (`settlePerStore`, below) now lives here too. The two inline copies —
 * finishSummary's `byStore` in RunPage and the history detail's
 * `perStore` in RunHistory — turned out to be byte-identical in their
 * money math; they differed only in the metadata each kept alongside it
 * (skuIds / expense counters). So this is the union of the two, and the
 * callers pick the fields they render. Nothing about the numbers changed.
 */

export function splitUnitPrice(
  split: { unitPrice?: string | null },
  item: { unitPrice?: string | null },
): string | null {
  return split.unitPrice ?? item.unitPrice ?? null;
}

export function splitPaymentMethod(
  split: { paymentMethod?: string | null },
  item: { paymentMethod?: string | null },
): string {
  return split.paymentMethod ?? item.paymentMethod ?? 'cash';
}

export function splitSubtotal(
  split: { qty: string; unitPrice?: string | null },
  item: { unitPrice?: string | null },
): number {
  const unitPrice = splitUnitPrice(split, item);
  if (!unitPrice) return 0;
  return Number(split.qty) * Number(unitPrice);
}

/**
 * The per-item settlement line: what one purchased item cost in total,
 * plus how that splits into cash vs transfer. Honors per-store overrides
 * (each split's own price/method) and otherwise falls back to the
 * item-level price/method.
 *
 * This is the one bug-prone bit of run money math (the override/flat
 * branch + cash/transfer allocation) that was typed IDENTICALLY inside
 * both `finishSummary` and the history-detail `breakdown`. One copy now;
 * callers add the returned deltas into their own running totals.
 */
export function settleItemLine(
  item: { unitPrice?: string | null; purchasedQty?: string | null; paymentMethod?: string | null },
  itemSplits: Array<{ qty: string; unitPrice?: string | null; paymentMethod?: string | null }>,
): { line: number; cash: number; transfer: number } {
  const hasSplitOverrides = itemSplits.some((sp) => sp.unitPrice || sp.paymentMethod);
  let line = 0;
  let cash = 0;
  let transfer = 0;
  if (hasSplitOverrides) {
    for (const sp of itemSplits) {
      const subtotal = splitSubtotal(sp, item);
      line += subtotal;
      if (splitPaymentMethod(sp, item) === 'transfer') transfer += subtotal;
      else cash += subtotal;
    }
  } else {
    line = Number(item.unitPrice) * Number(item.purchasedQty);
    if (item.paymentMethod === 'transfer') transfer += line;
    else cash += line;
  }
  return { line, cash, transfer };
}

/** What one store owes for a run: goods + its share of run expenses. */
export type StoreSettlement = {
  storeId: string;
  total: number;
  cash: number;
  transfer: number;
  /** Distinct SKUs contributing to this store's line. */
  skuIds: Set<string>;
  /** The expense portion of `total`, already included in it. */
  expensesTotal: number;
  expensesCount: number;
};

/**
 * Per-store settlement for a whole run — the "who owes what" number.
 *
 * Deliberately driven by SPLITS, not items: a split is the authoritative
 * record of how much of a purchase went to which store, and iterating
 * items would have to re-derive that. An item with no split contributes
 * to nobody, which is correct — nothing was allocated.
 *
 * Only `purchased` items with a price count. Pending and unavailable
 * rows are not costs, and an item without a price cannot be charged to
 * anyone (that case is unreachable today — the contract requires a
 * positive unitPrice on every purchase — but the guard is what makes
 * that statement safe to rely on).
 *
 * Run expenses (transport, porters, market fees) allocate by their own
 * per-store splits and land in the same cash/transfer buckets, because
 * from the store's side of the ledger they are indistinguishable from
 * goods: money the purchaser laid out on their behalf.
 */
export function settlePerStore(
  items: ReadonlyArray<{
    skuId: string;
    status: string;
    unitPrice?: string | null;
    paymentMethod?: string | null;
  }>,
  splits: ReadonlyArray<{
    skuId: string;
    storeId: string;
    qty: string;
    unitPrice?: string | null;
    paymentMethod?: string | null;
  }>,
  expenses: ReadonlyArray<{
    qty: string;
    unitPrice: string;
    paymentMethod?: string | null;
    storeSplits: ReadonlyArray<{ storeId: string; qty: string }>;
  }>,
): Map<string, StoreSettlement> {
  // Indexed once instead of items.find() per split — the inline copies
  // were O(items x splits), which is harmless at today's sizes but is a
  // free fix while the loop is being moved.
  const itemBySku = new Map(items.map((i) => [i.skuId, i]));

  const byStore = new Map<string, StoreSettlement>();
  const ensureStore = (storeId: string): StoreSettlement => {
    let cur = byStore.get(storeId);
    if (!cur) {
      cur = {
        storeId,
        total: 0,
        cash: 0,
        transfer: 0,
        skuIds: new Set<string>(),
        expensesTotal: 0,
        expensesCount: 0,
      };
      byStore.set(storeId, cur);
    }
    return cur;
  };

  for (const sp of splits) {
    const item = itemBySku.get(sp.skuId);
    if (!item || item.status !== 'purchased' || !item.unitPrice) continue;
    const subtotal = splitSubtotal(sp, item);
    const cur = ensureStore(sp.storeId);
    cur.total += subtotal;
    if (splitPaymentMethod(sp, item) === 'transfer') cur.transfer += subtotal;
    else cur.cash += subtotal;
    cur.skuIds.add(sp.skuId);
  }

  for (const ex of expenses) {
    for (const ss of ex.storeSplits) {
      const subtotal = Number(ss.qty) * Number(ex.unitPrice);
      const cur = ensureStore(ss.storeId);
      cur.total += subtotal;
      cur.expensesTotal += subtotal;
      cur.expensesCount += 1;
      if (ex.paymentMethod === 'transfer') cur.transfer += subtotal;
      else cur.cash += subtotal;
    }
  }

  return byStore;
}
