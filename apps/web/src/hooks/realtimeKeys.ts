import type { QueryKey } from '@tanstack/react-query';
import type { RealtimeChange } from '@compass/contracts/schemas/realtime';

/**
 * What each realtime push makes stale (useRealtime). Each key is a tRPC
 * path prefix: `['admin']` covers every `admin.*` query.
 *
 * What an `order.changed` / `run.changed` push makes stale:
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
  // COREWEB2-09: approving, withdrawing or un-approving an order changes
  // what the purchaser can put on a new run.
  ['run', 'previewCreatable'],
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

/**
 * Catalog changes ripple into the admin pages and into the catalog the
 * order screen reads; CAT-12 (2026-10-30): the purchaser's expense
 * templates too, and (S5, 2026-11-13) the daily close's.
 */
export const CATALOG_CHANGED_KEYS: QueryKey[] = [
  ['admin'],
  ['catalog'],
  ['run', 'expenseTemplates'],
  ['settlement', 'expenseTemplates'],
];

/**
 * Member, role binding and store assignment changes: the people pages
 * read several admin lists. (The session itself is re-read too.)
 */
export const PEOPLE_CHANGED_KEYS: QueryKey[] = [['admin']];

/**
 * A1 (2026-11-13): the Admin badge counts face enrollments to approve.
 * S4 (2026-11-13): the close's wage picker carries each daily wage.
 */
export const ATTENDANCE_CHANGED_KEYS: QueryKey[] = [
  ['attendance'],
  ['settlement', 'wageRoster'],
  ...NAV_KEYS,
];

/**
 * Review CONF-26: a daily close saved elsewhere. Not `settlement.get`: a
 * newer version would replace the form's unsaved input, so the form reads
 * the recent closes and decides itself (useSettlementForm). The nav dot
 * says whether today's close is in.
 */
export const SETTLEMENT_CHANGED_KEYS: QueryKey[] = [
  ['settlement', 'recent'],
  ['settlement', 'revisions'],
  ...NAV_KEYS,
];

export const PUSH_KEYS = {
  'order.changed': ORDER_CHANGED_KEYS,
  'run.changed': RUN_CHANGED_KEYS,
  'catalog.changed': CATALOG_CHANGED_KEYS,
  'people.changed': PEOPLE_CHANGED_KEYS,
  'attendance.changed': ATTENDANCE_CHANGED_KEYS,
  'settlement.changed': SETTLEMENT_CHANGED_KEYS,
} satisfies Record<RealtimeChange, QueryKey[]>;

/** Is `prefix` the start of `key` (or the same key)? */
function startsWith(key: QueryKey, prefix: QueryKey): boolean {
  return prefix.length <= key.length && prefix.every((part, i) => part === key[i]);
}

/** The keys, without duplicates and without keys a shorter one already covers. */
export function coveringKeys(keys: readonly QueryKey[]): QueryKey[] {
  const out: QueryKey[] = [];
  for (const key of [...keys].sort((a, b) => a.length - b.length)) {
    if (!out.some((kept) => startsWith(key, kept))) out.push(key);
  }
  return out;
}

/**
 * COREWEB2-08: a socket that opens again missed pushes of every kind
 * while it was down, so it refreshes everything any push would have. It
 * used to be a hand-kept list that had drifted: no `report` or
 * `attendance`, and a `notifications` key no query uses.
 */
export const REOPEN_KEYS: QueryKey[] = coveringKeys(Object.values(PUSH_KEYS).flat());
