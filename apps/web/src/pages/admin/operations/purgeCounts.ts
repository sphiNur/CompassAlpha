/**
 * CMP-OPS-6 (2026-10-31): the purge previews listed internal table names
 * ("domain.events", "read_model.order_items_v", "sync.outbox"). They now
 * say what is deleted in the app's own words — orders, order lines,
 * runs, history records… — with tables that make up one thing added
 * together and anything unknown (a newer server) under "Other".
 */

export const PURGE_KINDS = [
  'orders',
  'orderLines',
  'runs',
  'runLines',
  'runStoreLines',
  'expenses',
  'dailyCloses',
  'stockMovements',
  'priceHistory',
  'notifications',
  'pendingMessages',
  'history',
  'appLogs',
  'other',
] as const;
export type PurgeKind = (typeof PURGE_KINDS)[number];

const KIND_BY_TABLE: Record<string, PurgeKind> = {
  'read_model.order_sessions_v': 'orders',
  'read_model.order_items_v': 'orderLines',
  'read_model.market_runs_v': 'runs',
  'read_model.run_items_v': 'runLines',
  'read_model.run_item_stores_v': 'runStoreLines',
  'read_model.run_expenses_v': 'expenses',
  'inventory.store_daily_settlements': 'dailyCloses',
  'inventory.store_daily_settlement_revisions': 'dailyCloses',
  'inventory.movements': 'stockMovements',
  'inventory.price_history': 'priceHistory',
  'ops.notifications': 'notifications',
  'sync.outbox': 'pendingMessages',
  'domain.events': 'history',
  'domain.snapshots': 'history',
  'ops.client_logs': 'appLogs',
};

/** Non-zero counts by kind, in PURGE_KINDS order ("Other" last). */
export function purgeCountsByKind(
  byTable: Record<string, number>,
): Array<{ kind: PurgeKind; n: number }> {
  const sums = new Map<PurgeKind, number>();
  for (const [table, n] of Object.entries(byTable)) {
    if (!(n > 0)) continue;
    const kind = KIND_BY_TABLE[table] ?? 'other';
    sums.set(kind, (sums.get(kind) ?? 0) + n);
  }
  return PURGE_KINDS.filter((kind) => sums.has(kind)).map((kind) => ({
    kind,
    n: sums.get(kind)!,
  }));
}

/**
 * CMP-OPS-5 (2026-10-31): resetting a day deleted on one tap (307 rows in
 * one test). Like the full wipe, it now waits until the date being reset
 * is typed. Accepts the date as shown (YYYY-MM-DD), spaces ignored.
 */
export function resetConfirmMatches(typed: string, date: string): boolean {
  return date !== '' && typed.replace(/\s/g, '') === date;
}
