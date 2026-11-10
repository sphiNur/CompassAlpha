import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index';

export type DB = ReturnType<typeof drizzle<typeof schema>>;

// One pool per database and kind of handle. A process normally has one; a
// test process has both kinds, the plain handle for the code under test and
// the maintenance one for building fixtures. The address is part of the key
// (DB-17): a script or test that asks for a second database gets that
// database, not the pool of the first.
type Kind = 'app' | 'maintenance';
const pools = new Map<string, { client: ReturnType<typeof postgres>; db: DB }>();

export interface GetDbOptions {
  /**
   * Open every connection already in the system context, so that plain
   * queries on the handle cross tenants. For processes that are
   * maintenance from start to finish: the seed, the CLI, and test
   * fixtures. Never for a server: there, each tenant-less query must say
   * so on its own (`withSystemContext`), and this would say it for all
   * of them. `withOrgContext` still narrows to one tenant on such a handle.
   */
  system?: 'maintenance';
}

export function getDb(url?: string, options: GetDbOptions = {}): DB {
  const connectionString = url ?? process.env.DATABASE_URL;
  const refusal = connectionString ? testDatabaseRefusal(connectionString) : null;
  if (refusal) return refusingHandle(refusal);
  if (!connectionString) throw new Error('DATABASE_URL not set');
  const kind: Kind = options.system ? 'maintenance' : 'app';
  const key = `${kind} ${connectionString}`;
  const existing = pools.get(key);
  if (existing) return existing.db;
  const client = postgres(connectionString, {
    max: 20,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: false,
    ...(options.system
      ? { connection: { 'app.system_context': options.system } as Record<string, string> }
      : {}),
  });
  const raw = drizzle(client, { schema, logger: process.env.DB_DEBUG === '1' });
  // A maintenance handle is tenant-less by declaration; there is nothing
  // for the probe to find on it.
  const db = options.system ? raw : probed(raw);
  pools.set(key, { client, db });
  return db;
}

/**
 * Tests insert fixtures and delete rows, so a test run (`bun test` sets
 * NODE_ENV=test) uses only a database whose name says it is throwaway:
 * one with "test" or "e2e" as a word of its name, like CI's compass_test,
 * a local compass_test_x and the end-to-end run's compass_e2e. Letters
 * inside a word do not count: "latest" or "contest" is refused (the same
 * rule as tests/e2e/env.ts). Bun reads the repository's .env by
 * itself, and there DATABASE_URL is the development database, so a run
 * that forgot SKIP_PG_TESTS=1 used to write its fixtures into it.
 *
 * Returns why the database is refused, or null. ALLOW_ANY_TEST_DB=1
 * lifts the rule for one run.
 */
export function testDatabaseRefusal(
  connectionString: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (env.NODE_ENV !== 'test' || env.ALLOW_ANY_TEST_DB === '1') return null;
  const name = databaseName(connectionString);
  if (/(^|[_-])(e2e|test)([_-]|$)/i.test(name)) return null;
  return (
    'A test run may use only a throwaway database, one with "test" or "e2e" as a word of its name, ' +
    `and this one is ${name ? `"${name}"` : 'unnamed'}. Tests write and delete rows: point ` +
    'DATABASE_URL at a database such as compass_test (bun takes it from .env when the shell ' +
    'sets none), or set ALLOW_ANY_TEST_DB=1.'
  );
}

/**
 * What getDb hands out for a refused database: no pool, no connection,
 * and every use throws the refusal. Code that only builds a context
 * around the handle, as several unit tests do through createContext,
 * still runs.
 */
function refusingHandle(refusal: string): DB {
  return new Proxy({} as DB, {
    get(_target, prop) {
      // Awaiting the handle, or returning it from an async function, is not a use.
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      throw new Error(refusal);
    },
  });
}

function databaseName(connectionString: string): string {
  try {
    return decodeURIComponent(new URL(connectionString).pathname.slice(1));
  } catch {
    return '';
  }
}

/**
 * Finding every query that runs without a tenant.
 *
 * Since migrations/sql/950_rls_fail_closed.sql the row-level policies let
 * a query through only for its own organisation or in a system context
 * (`app_is_system()`). A query that set neither sees no rows and cannot
 * write: no leak between customers, but a screen or a job that silently
 * finds nothing. Every query has to be given a tenant or marked as
 * deliberately tenant-less (`withSystemContext`). This is how the ones
 * that forgot are found.
 *
 * A tenant is set per transaction, so a query issued on the root handle
 * (outside `withOrgContext` / `withSystemContext`) has none by
 * construction. The handle returned by `getDb` reports each such use,
 * once per call site:
 *
 *   DB_TENANT_PROBE unset or `warn`   one JSON line on stderr per site
 *                                     (the default, so also production
 *                                     unless its .env says otherwise)
 *   DB_TENANT_PROBE=throw             the query throws (the end-to-end
 *                                     run; the goal for production once
 *                                     the warnings stop)
 *   DB_TENANT_PROBE=off               nothing
 */
const ROOT_OPERATIONS = new Set([
  'select',
  'selectDistinct',
  'selectDistinctOn',
  'insert',
  'update',
  'delete',
  'execute',
  'transaction',
  'query',
  '$count',
]);
const rawHandles = new WeakMap<object, DB>();
const reportedSites = new Set<string>();

export interface TenantlessQuery {
  /** The Drizzle entry point that was used: `select`, `execute`, ... */
  operation: string;
  /** `file:line` of the caller, relative to the repository where possible. */
  site: string;
}

function warnOnStderr(use: TenantlessQuery): void {
  process.stderr.write(
    `${JSON.stringify({ level: 'warn', event: 'db.no_tenant_context', ...use })}\n`,
  );
}

let reporter: (use: TenantlessQuery) => void = warnOnStderr;

/**
 * Route the reports somewhere else (a logger; an array in a test). `null`
 * puts back the line on stderr: the reporter outlives a test file, since
 * `bun test` runs every file in one process (TEST2-17).
 */
export function setTenantlessQueryReporter(fn: ((use: TenantlessQuery) => void) | null): void {
  reporter = fn ?? warnOnStderr;
  reportedSites.clear();
}

function callSite(): string {
  const frames = (new Error().stack ?? '').split('\n').slice(1);
  for (const frame of frames) {
    if (frame.includes('node_modules')) continue;
    if (/packages[\\/]db[\\/]src[\\/](client|rls)\.ts/.test(frame)) continue;
    const match = /\(?((?:\/|[A-Za-z]:\\)[^()]+:\d+):\d+\)?\s*$/.exec(frame);
    if (!match) continue;
    return match[1]!.replace(/^.*?[\\/](apps|packages|tests)[\\/]/, '$1/');
  }
  return 'unknown';
}

function probed(raw: DB): DB {
  const handle = new Proxy(raw, {
    get(target, prop, receiver) {
      const mode = process.env.DB_TENANT_PROBE ?? 'warn';
      if (mode !== 'off' && typeof prop === 'string' && ROOT_OPERATIONS.has(prop)) {
        const site = callSite();
        if (mode === 'throw') {
          throw new Error(
            `db.${prop} at ${site} runs without a tenant. Wrap it in withOrgContext, or in ` +
              'withSystemContext if it is meant to cross tenants.',
          );
        }
        if (!reportedSites.has(site)) {
          reportedSites.add(site);
          reporter({ operation: prop, site });
        }
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  rawHandles.set(handle, raw);
  return handle;
}

/**
 * The handle without the probe, for the two helpers in rls.ts that open
 * the transactions everything else is supposed to run in.
 */
export function unprobed(db: DB): DB {
  return rawHandles.get(db) ?? db;
}

export async function closeDb(): Promise<void> {
  const open = [...pools.values()];
  pools.clear();
  await Promise.all(open.map(({ client }) => client.end({ timeout: 5 })));
}

export { schema };
