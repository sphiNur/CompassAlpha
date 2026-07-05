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
 * The fuller per-store settlement aggregation (finishSummary's byStore
 * vs the history breakdown's perStore — which genuinely diverge in what
 * they track) still lives inline in RunPage; merging those lands here
 * once their outputs are reconciled.
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
