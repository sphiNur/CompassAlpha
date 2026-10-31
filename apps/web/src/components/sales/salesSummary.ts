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

/**
 * 2026-10-21 FE-01 / F4-03: which state the today's-sales list shows.
 * An errored list must never read as "no sales yet" — a cashier would
 * re-enter sales that already exist and stock would be deducted twice.
 * An error wins over stale data too (a failed refetch of a cached list).
 */
export type SalesListView = 'loading' | 'error' | 'offline' | 'empty' | 'none' | 'list';
/**
 * CLS-6 (2026-10-31): offline with no saved copy the list does not fail,
 * it waits (paused) with no rows — and read "0 servings / no sales yet".
 * `waitingOffline` = no data and `fetchStatus === 'paused'`; it is locked
 * like an error and loads by itself once back online.
 */
export function salesListView(q: {
  isLoading: boolean;
  isError: boolean;
  rowCount: number;
  waitingOffline?: boolean;
  /**
   * EMP-4 (2026-10-31): the record card above already says sales cannot be
   * recorded yet (no dishes, or none with a recipe). A second, larger
   * "no sales today" under it read as the main message; show only one.
   */
  recordingBlocked?: boolean;
}): SalesListView {
  if (q.waitingOffline) return 'offline';
  if (q.isLoading) return 'loading';
  if (q.isError) return 'error';
  if (q.rowCount > 0) return 'list';
  return q.recordingBlocked ? 'none' : 'empty';
}
