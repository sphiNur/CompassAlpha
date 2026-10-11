import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index';

export type DB = ReturnType<typeof drizzle<typeof schema>>;

let _client: ReturnType<typeof postgres> | null = null;
let _db: DB | null = null;

export function getDb(url?: string): DB {
  if (_db) return _db;
  const connectionString = url ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL not set');
  _client = postgres(connectionString, {
    max: 20,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: false,
  });
  const raw = drizzle(_client, { schema, logger: process.env.DB_DEBUG === '1' });
  _db = probed(raw);
  return _db;
}

/**
 * Finding every query that runs without a tenant.
 *
 * The row-level policies currently let everything through when no
 * organisation is set, which is how the login path and the worker read
 * across tenants, and also how any query that simply forgot would leak
 * between customers. Before the policies can be made to refuse, every
 * such query has to be either given a tenant or marked as deliberately
 * tenant-less (`withSystemContext`). This is how they are found.
 *
 * A tenant is set per transaction, so a query issued on the root handle
 * (outside `withOrgContext` / `withSystemContext`) has none by
 * construction. The handle returned by `getDb` reports each such use,
 * once per call site:
 *
 *   DB_TENANT_PROBE unset or `warn`   one JSON line on stderr per site
 *   DB_TENANT_PROBE=throw             the query throws (tests, and
 *                                     production once the list is empty)
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

let reporter: (use: TenantlessQuery) => void = (use) => {
  process.stderr.write(
    `${JSON.stringify({ level: 'warn', event: 'db.no_tenant_context', ...use })}\n`,
  );
};

/** Route the reports somewhere else (a logger; an array in a test). */
export function setTenantlessQueryReporter(fn: (use: TenantlessQuery) => void): void {
  reporter = fn;
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
  if (_client) {
    await _client.end({ timeout: 5 });
    _client = null;
    _db = null;
  }
}

export { schema };
