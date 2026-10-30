/**
 * Whether the workspace-wide purges may run here (D1, 2026-10-30).
 *
 * `admin.purgeAllTestData` (wipe every order, run, event and close of the
 * organisation) and `admin.purgeByDate` (the same for every author on one
 * date) are test-data tools. On production they reach paying customers'
 * records, and their only fences were the super_admin role and a web
 * build flag — a stale bundle, a direct API call or a mistaken role grant
 * was enough. They are now refused on production unless the server's
 * .env sets COMPASS_ALLOW_BULK_PURGE=true for the maintenance window.
 *
 * Production = NODE_ENV=production or COMPASS_RELEASE_CHANNEL=production
 * (either one; the same reading auth.ts uses for dev login).
 *
 * The per-item deletes on the maintenance page (one order, one run) are
 * not covered: they refuse other people's records by themselves (CAT-3,
 * #144) and admins use them on production.
 */
export interface BulkPurgeEnv {
  NODE_ENV?: string;
  COMPASS_RELEASE_CHANNEL?: string;
  COMPASS_ALLOW_BULK_PURGE?: string;
}

export function bulkPurgeAllowed(e: BulkPurgeEnv): boolean {
  const production = e.NODE_ENV === 'production' || e.COMPASS_RELEASE_CHANNEL === 'production';
  return !production || e.COMPASS_ALLOW_BULK_PURGE === 'true';
}
