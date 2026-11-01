import type { QueryKey } from '@tanstack/react-query';

/**
 * What an `order.changed` / `run.changed` push makes stale (useRealtime).
 *
 * HIS-6 (2026-10-30): finance, price reports and order history live under
 * other prefixes and kept old numbers until reopened.
 * DX-CAT-1 (2026-11-01): so did Operations → Activity — its event feed and
 * the "pending approval" tile stood still while orders were withdrawn and
 * runs bought, until the page was reopened.
 */
const ACTIVITY_KEYS: QueryKey[] = [
  ['admin', 'recentEvents'],
  ['admin', 'overview'],
];

/** DX-SHL-23 (2026-11-01): the bottom nav's badges count orders and runs. */
const NAV_KEYS: QueryKey[] = [['nav']];

export const ORDER_CHANGED_KEYS: QueryKey[] = [
  ['order'],
  ['admin', 'submissionHistory'],
  ...ACTIVITY_KEYS,
  ...NAV_KEYS,
];

export const RUN_CHANGED_KEYS: QueryKey[] = [
  ['run'],
  ['report'],
  ['catalog', 'skuPriceStats'],
  ...ACTIVITY_KEYS,
  ...NAV_KEYS,
];
