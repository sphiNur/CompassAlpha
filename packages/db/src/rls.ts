/**
 * Postgres Row-Level Security helpers.
 *
 * Every request that touches org-scoped data must run inside a transaction
 * with `app.current_org_id` set. The schema's RLS policies refer to this
 * GUC so that even a buggy WHERE clause can't leak across tenants.
 */
import { sql } from 'drizzle-orm';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import type { DB } from './client';

export type OrgTransactionOptions = PgTransactionConfig;

export async function setOrgContext(db: DB, orgId: string): Promise<void> {
  // Validates the orgId is a UUID at the SQL layer to prevent injection in SET LOCAL.
  await db.execute(sql`SELECT set_config('app.current_org_id', ${orgId}::text, true)`);
}

export async function clearOrgContext(db: DB): Promise<void> {
  await db.execute(sql`SELECT set_config('app.current_org_id', '', true)`);
}

/**
 * Run `fn` inside a transaction with `app.current_org_id = orgId`.
 * If `orgId` is null, the transaction runs WITHOUT org context �?caller must
 * ensure the queries are admin-only and explicitly cross-tenant safe.
 */
export async function withOrgContext<T>(
  db: DB,
  orgId: string | null,
  fn: (tx: DB) => Promise<T>,
  options?: OrgTransactionOptions,
): Promise<T> {
  return db.transaction(async (tx) => {
    if (orgId) {
      await tx.execute(sql`SELECT set_config('app.current_org_id', ${orgId}::text, true)`);
    }
    // PgTransaction is structurally similar to DB but lacks `$client`.
    // Drizzle's transaction passes a tx with a compatible query API; we
    // cast through unknown so the inner code path can use the same shape.
    return fn(tx as unknown as DB);
  }, options);
}
