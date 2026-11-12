/**
 * Centralized FE timing constants (M1.5, 2026-05-06).
 *
 * Before this consolidation, `staleTime`, `gcTime`, page-size `limit`,
 * and assorted timeouts were scattered as inline literals across 8+
 * files (AdminPage.tsx had `limit: 50` and `limit: 100` x4 in
 * different sections; OrderPage / ApprovalPage each duplicated
 * `staleTime: 60_000`). Drift between caller intent and actual value
 * was a real risk.
 *
 * Add new timings here when you spot one, not as inline magic numbers.
 */

/**
 * React Query `staleTime` defaults — how long a cached value is
 * considered fresh enough to skip a background refetch.
 */
export const STALE = {
  /** Fast-changing lists (orders, runs). Refetch on most navigations. */
  short: 30_000, // 30s
  /** Moderately stable lists (members, SKUs, suppliers). */
  medium: 60_000, // 1m
  /** Slow-moving config (org info, app config). */
  long: 5 * 60_000, // 5m
} as const;

/**
 * Default page sizes for paginated admin queries. Three buckets cover
 * the spectrum we use today; if a screen needs something exotic, add
 * a new bucket here rather than inlining.
 */
export const PAGE_SIZE = {
  /** Recent activity / audit feeds. */
  feed: 50,
  /** General lists (sessions, runs, audit history). */
  list: 100,
  /** Debug-style firehose. */
  firehose: 200,
} as const;

/**
 * The purchase page's waits (review RUNWEB1-32: they were bare numbers in
 * RunPage, its hook and its rows).
 */
export const RUN_PAGE = {
  /**
   * After a write the run is read again this much later, so the list does
   * not redraw under the purchaser's next tap (2026-06-08). What the
   * server accepted shows on its row at once (RUNWEB1-37).
   */
  refetchDelayMs: 650,
  /** How often the run is read while the realtime socket is down (P-4). */
  offlinePollMs: 6_000,
  /**
   * How long a row saved inline keeps its "saving" mark once the request
   * is over and the run still shows it unbought.
   */
  savingHoldMs: 5_000,
  /** How long focus waits for the next row to buy after one is saved (DX-IX-4). */
  nextRowFocusWaitMs: 3_000,
} as const;
