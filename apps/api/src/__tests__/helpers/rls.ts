/**
 * What the row-level security tests share (review TEST2-01, 2026-11-12:
 * rls-attendance.test.ts needed both, and they lived inside
 * rls-isolation.test.ts).
 */
import { expect } from 'bun:test';
import { sql } from 'drizzle-orm';
import { getDb, withOrgContext } from '@compass/db';
import { SHOULD_RUN } from './pg';

/** The `n` of a `SELECT COUNT(*)::int AS n` (postgres-js returns the rows bare or on `.rows`). */
function countOf(result: unknown): number {
  const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? []);
  return Number((rows[0] as { n: number }).n);
}

/** The connecting role is a superuser or has BYPASSRLS: it sees through every policy. */
async function roleBypassesRls(): Promise<boolean> {
  const db = getDb(undefined, { system: 'maintenance' });
  const r = await db.execute(sql`
    SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user
  `);
  const rows = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? []);
  return Boolean((rows[0] as { bypass?: boolean } | undefined)?.bypass);
}

/**
 * Whether an RLS suite runs: a database is configured and the role is
 * subject to row-level security. Review TEST2-05 (2026-11-09): a
 * superuser or BYPASSRLS role sees through every policy, so with one the
 * suite is skipped, and reported as skipped; it used to "pass" on made-up
 * counts. In CI, which runs the tests as compass_ci_app, such a role is
 * an error.
 */
export async function rlsSuiteRuns(file: string): Promise<boolean> {
  if (!SHOULD_RUN) return false;
  const bypassed = await roleBypassesRls();
  if (bypassed && process.env.CI) {
    throw new Error(
      `${file}: the database role is a superuser or has BYPASSRLS, so these tests ` +
        'would prove nothing. CI must run them as compass_ci_app.',
    );
  }
  return !bypassed;
}

/**
 * How many rows of `table` matching `whereClause` org A sees, org B sees,
 * and the system context sees (the maintenance handle: what sign-in and
 * the worker run in). With neither a tenant nor the system context no row
 * may be visible; that is asserted here, for every table checked through
 * this helper. It used to return every row: "no tenant set" meant "let it
 * through", so a query that forgot to set one read every customer's data.
 */
export async function countUnderEachContext(
  table: string,
  whereClause: string,
  orgA: string,
  orgB: string,
): Promise<{ aSeen: number; bSeen: number; totalSeen: number }> {
  const db = getDb(undefined, { system: 'maintenance' });
  const query = sql.raw(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${whereClause}`);
  const aSeen = await withOrgContext(db, orgA, async (tx) => countOf(await tx.execute(query)));
  const bSeen = await withOrgContext(db, orgB, async (tx) => countOf(await tx.execute(query)));
  const noneSeen = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.system_context', '', true)`);
    return countOf(await tx.execute(query));
  });
  expect(noneSeen).toBe(0);
  const totalSeen = countOf(await db.execute(query));
  return { aSeen, bSeen, totalSeen };
}
