/**
 * Pure helpers for StoreSalesPanel (2026-10-21, sales.void).
 *
 * Kept out of the component so the "voided sales don't count" rule has a
 * unit test without React.
 */

export interface SaleSummaryRow {
  qty: string;
  unitPrice: string | null;
  voidedAt?: string | Date | null;
}

/** Today's headline: servings + revenue over sales that still stand. */
export function summarizeSales(sales: ReadonlyArray<SaleSummaryRow>): {
  count: number;
  revenue: number;
} {
  let count = 0;
  let revenue = 0;
  for (const sale of sales) {
    // 2026-10-21: a voided sale's stock was put back — it isn't revenue.
    if (sale.voidedAt) continue;
    const qty = Number(sale.qty);
    count += qty;
    if (sale.unitPrice) revenue += qty * Number(sale.unitPrice);
  }
  return { count, revenue };
}

/** Void reason as the server accepts it (trimmed, 1..300 chars). */
export function normalizeVoidReason(raw: string): string | null {
  const reason = raw.trim();
  return reason.length >= 1 && reason.length <= 300 ? reason : null;
}
