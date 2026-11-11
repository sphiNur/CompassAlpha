/**
 * Pure helpers for StoreSalesPanel (2026-10-21, sales.void).
 *
 * Kept out of the component so their rules have unit tests without React.
 * The day's totals are counted by the server now (sales.summary, review
 * CONF-17): adding up the list missed every sale past its 200 rows.
 */
import { SALE_VOID_REASON_MAX } from '@compass/contracts/limits';

/** Void reason as the server accepts it (trimmed, 1..SALE_VOID_REASON_MAX chars). */
export function normalizeVoidReason(raw: string): string | null {
  const reason = raw.trim();
  return reason.length >= 1 && reason.length <= SALE_VOID_REASON_MAX ? reason : null;
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
