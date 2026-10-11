/**
 * Postgres Row-Level Security helpers.
 *
 * Every request that touches org-scoped data must run inside a transaction
 * with `app.current_org_id` set. The schema's RLS policies refer to this
 * GUC so that even a buggy WHERE clause can't leak across tenants.
 */
import { sql } from 'drizzle-orm';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import { unprobed } from './client';
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
  return unprobed(db).transaction(async (tx) => {
    if (orgId) {
      // Also drop any system context the connection carries (a maintenance
      // handle has one for its whole life): inside here, only this tenant.
      await tx.execute(
        sql`SELECT set_config('app.current_org_id', ${orgId}::text, true), set_config('app.system_context', '', true)`,
      );
    }
    // PgTransaction is structurally similar to DB but lacks `$client`.
    // Drizzle's transaction passes a tx with a compatible query API; we
    // cast through unknown so the inner code path can use the same shape.
    return fn(tx as unknown as DB);
  }, options);
}

/** Why a piece of code is allowed to read or write across tenants. */
export type SystemReason =
  /** Finding who is signing in, before it is known which tenant they belong to. */
  | 'auth'
  /** Background work that walks every tenant: the outbox, cleanup, metrics. */
  | 'worker'
  /** Liveness and readiness checks, which touch no tenant's rows. */
  | 'health'
  /** Schema migrations, seeds and operator scripts. */
  | 'maintenance'
  /** Client logs and metrics, which can arrive before anyone has signed in. */
  | 'telemetry';

/**
 * Run `fn` in a transaction that is deliberately not tied to one tenant.
 *
 * This is the only sanctioned way to query across organisations. It sets
 * `app.system_context`, which the row-level policies will accept in place
 * of an organisation once they stop accepting "nothing set". Every use is
 * a place where tenant isolation rests on the code being right, so keep
 * them few and say why.
 */
export async function withSystemContext<T>(
  db: DB,
  reason: SystemReason,
  fn: (tx: DB) => Promise<T>,
  options?: OrgTransactionOptions,
): Promise<T> {
  return unprobed(db).transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.system_context', ${reason}, true)`);
    return fn(tx as unknown as DB);
  }, options);
}

/**
 * One statement, deliberately not tied to a tenant. For code whose
 * statements must each commit by themselves (rotating a refresh token
 * revokes a family and THEN fails the request; in one transaction the
 * failure would undo the revocation).
 */
export function inSystem<T>(
  db: DB,
  reason: SystemReason,
  statement: (tx: DB) => PromiseLike<T>,
): Promise<T> {
  return withSystemContext(db, reason, async (tx) => await statement(tx));
}
