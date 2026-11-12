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
 * Production = NODE_ENV=production or COMPASS_RELEASE_CHANNEL=production:
 * either signal is enough. That is stricter than the sign-in rules'
 * releaseChannel() (routers/auth/modes.ts), where a set channel wins over
 * NODE_ENV: with NODE_ENV=production and COMPASS_RELEASE_CHANNEL=staging
 * the sign-in rules see staging, and these purges still refuse. On
 * purpose (review ADM2-27, 2026-11-12; this comment used to call the two
 * readings the same): a mistyped channel must not open a wipe of
 * customer data. A staging server that runs as production sets the switch.
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
