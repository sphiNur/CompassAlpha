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
 * React Query `gcTime` — how long an unused cache entry sits in
 * memory before being garbage-collected.
 */
export const GC_TIME = 5 * 60 * 1000; // 5m — match React Query default-ish

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
