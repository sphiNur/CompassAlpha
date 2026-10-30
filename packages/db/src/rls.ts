/**
 * Postgres Row-Level Security helpers.
 *
 * Every request that touches org-scoped data must run inside a transaction
 * with `app.current_org_id` set. The schema's RLS policies refer to this
 * GUC so that even a buggy WHERE clause can't leak across tenants.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { sql, type SQL } from 'drizzle-orm';
import type { PgTransactionConfig } from 'drizzle-orm/pg-core';
import { unprobed } from './client';
import type { DB } from './client';

export type OrgTransactionOptions = PgTransactionConfig;

/**
 * Work to do once the surrounding transaction has committed.
 *
 * B9 (2026-10-30): the realtime hub told clients "order X is now at seq
 * 12" from inside the transaction that wrote seq 12. A client that
 * refetched straight away read 11, and kept it until the next change;
 * a transaction that then rolled back had announced a change that never
 * happened. The transactions opened here keep a list of such callbacks:
 * they run after COMMIT, in order, and are dropped on rollback. A nested
 * transaction (a savepoint) hands its list to the outer one.
 */
interface AfterCommit {
  callbacks: Array<() => void>;
  /** Set once the transaction has ended; later callbacks run (or drop) at once. */
  outcome: 'committed' | 'rolledBack' | null;
}
const afterCommitScope = new AsyncLocalStorage<AfterCommit>();

/**
 * Run `fn` after the transaction this code is in commits; never, if it
 * rolls back. Outside a transaction opened by withOrgContext /
 * withSystemContext, run it now.
 */
export function afterCommit(fn: () => void): void {
  const scope = afterCommitScope.getStore();
  if (!scope || scope.outcome === 'committed') {
    runQuietly(fn);
    return;
  }
  if (scope.outcome === 'rolledBack') return;
  scope.callbacks.push(fn);
}

function runQuietly(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    // A failing listener must not turn a committed write into an error.
    console.error('[db] after-commit callback failed', err);
  }
}

async function collectingAfterCommit<T>(open: () => Promise<T>): Promise<T> {
  const outer = afterCommitScope.getStore();
  const scope: AfterCommit = { callbacks: [], outcome: null };
  let result: T;
  try {
    result = await afterCommitScope.run(scope, open);
  } catch (err) {
    scope.outcome = 'rolledBack';
    throw err;
  }
  scope.outcome = 'committed';
  if (outer && outer.outcome === null) {
    outer.callbacks.push(...scope.callbacks);
  } else {
    for (const fn of scope.callbacks) runQuietly(fn);
  }
  return result;
}

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
  return collectingAfterCommit(() =>
    unprobed(db).transaction(async (tx) => {
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
    }, options),
  );
}

/**
 * Why a piece of code is allowed to read or write across tenants.
 *
 * The database accepts exactly these values (`app_is_system()` in
 * migrations/sql/900_rls_policies.sql, D3); any other string opens
 * nothing. Add a reason in both places.
 */
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

/** Every SystemReason, for the check that the database's list matches. */
export const SYSTEM_REASONS: readonly SystemReason[] = [
  'auth',
  'worker',
  'health',
  'maintenance',
  'telemetry',
];

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
  return collectingAfterCommit(() =>
    unprobed(db).transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.system_context', ${reason}, true)`);
      return fn(tx as unknown as DB);
    }, options),
  );
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

/**
 * Let this transaction delete rows from `domain.events`.
 *
 * The event store is append-only at the database (migration 0055): a
 * trigger refuses UPDATE, DELETE and TRUNCATE. The maintenance purges
 * (admin purge of a session, run, date or workspace; the fake-data
 * wipe) are the only code that removes events on purpose, and each one
 * calls this first, inside the same transaction. The setting is
 * transaction-local, so it ends with the commit or rollback and never
 * leaks to the next user of the pooled connection. Updates stay refused.
 */
export async function allowEventPurge(tx: {
  execute: (query: SQL) => PromiseLike<unknown>;
}): Promise<void> {
  await tx.execute(sql`SELECT set_config('app.event_purge', 'on', true)`);
}
