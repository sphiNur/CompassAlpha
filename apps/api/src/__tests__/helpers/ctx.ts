/**
 * Request contexts for calling tRPC procedures from the API tests (review
 * TEST1-02, 2026-11). The suites used to build their own, some 40 copies
 * that had drifted: a few dropped withOrg's transaction options, some ran
 * anonymous calls in a made-up null organisation, and most handed the code
 * under test the maintenance handle they write fixtures with, under which
 * the RLS policies let every row through.
 *
 * Procedures here run on `getDb()`, the handle the server's createContext
 * uses: no system context, so every query is held to the organisation's
 * RLS policies as in production. Fixtures are still written with
 * `getDb(undefined, { system: 'maintenance' })`.
 */
import { sql } from 'drizzle-orm';
import { getDb, withOrgContext } from '@compass/db';
import { logger } from '../../infra/log';
import type { RequestContext, SessionContext } from '../../trpc/context';
import { appRouter } from '../../trpc/router';

type Db = ReturnType<typeof getDb>;

export interface TestContextOptions {
  /** As the X-Idempotency-Key header would set it. */
  idempotencyKey?: string | null;
  /** The request side, and where the response's headers land (testHono). */
  hono?: TestHono;
}

/**
 * The part of a Hono context the procedures use: the request's headers
 * (the refresh cookie, review MWD-14) and the response headers they add
 * (`Set-Cookie`), which a test reads back from `setCookies`.
 */
export interface TestHono {
  req: { raw: Request; header: (name: string) => string | undefined };
  header: (name: string, value: string, options?: { append?: boolean }) => void;
  setCookies: string[];
}

export function testHono(requestHeaders: Record<string, string> = {}): TestHono {
  const raw = new Request('http://localhost/trpc/test', { headers: requestHeaders });
  const setCookies: string[] = [];
  return {
    req: { raw, header: (name) => raw.headers.get(name) ?? undefined },
    header: (name, value) => {
      if (name.toLowerCase() === 'set-cookie') setCookies.push(value);
    },
    setCookies,
  };
}

/** What createContext builds for a request signed in as `session` (null: anonymous). */
export function testContext(
  session: SessionContext | null,
  options: TestContextOptions = {},
): RequestContext {
  const db = getDb();
  return {
    hono: (options.hono ?? testHono()) as unknown as RequestContext['hono'],
    db,
    log: logger,
    traceId: `test-${Date.now()}`,
    ip: null,
    userAgent: null,
    idempotencyKey: options.idempotencyKey ?? null,
    session,
    async withOrg(fn, txOptions) {
      if (!session) throw new Error('withOrg requires authenticated session');
      return withOrgContext(db, session.orgId, fn, txOptions);
    },
  };
}

/** The app router, called as `session` (null: anonymous). */
export function callerFor(session: SessionContext | null, options?: TestContextOptions) {
  return appRouter.createCaller(testContext(session, options));
}

/**
 * A caller with no database behind it, for tests of the checks that run
 * before a handler: a call they let through fails with "reached the
 * handler" at its first `withOrg`.
 */
export function gateCaller(
  session: SessionContext | null,
  options: { sessionUnavailable?: boolean } = {},
) {
  return appRouter.createCaller({
    hono: testHono() as unknown as RequestContext['hono'],
    db: {} as Db,
    log: logger,
    traceId: 'test',
    ip: null,
    userAgent: null,
    idempotencyKey: null,
    session,
    sessionUnavailable: options.sessionUnavailable,
    async withOrg() {
      throw new Error('reached the handler');
    },
  });
}

/**
 * Opens `n` connections on the server's handle and leaves them in the
 * pool, so that `n` calls a test starts together do run at the same time
 * (review TEST1-11, 2026-11). Otherwise the first call can take an open
 * connection while the others wait the 25 ms or so it takes to open new
 * ones. By then the first has committed, and a race test never races.
 */
export async function openConnections(orgId: string, n: number): Promise<void> {
  const db = getDb();
  // Each holds its connection for 50 ms, so none is handed back before
  // the others are open.
  await Promise.all(
    Array.from({ length: n }, () =>
      withOrgContext(db, orgId, (tx) => tx.execute(sql`SELECT pg_sleep(0.05)`)),
    ),
  );
}

/**
 * Resolves once a statement whose text contains `fragment` waits for a lock
 * in this database (review TEST1-19, 2026-11). A race test holds a row and
 * waits here, so that it knows the other side has reached that row before
 * letting go, instead of sleeping and hoping it has. Fails after `ms`.
 */
export async function untilWaitingForLock(fragment: string, ms = 5_000): Promise<void> {
  const db = getDb(undefined, { system: 'maintenance' });
  const until = Date.now() + ms;
  for (;;) {
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'
        AND query LIKE ${`%${fragment}%`}
    `)) as unknown as Array<{ n: number }>;
    if ((rows[0]?.n ?? 0) > 0) return;
    if (Date.now() > until) {
      throw new Error(`no statement on ${fragment} waited for a lock within ${ms} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
