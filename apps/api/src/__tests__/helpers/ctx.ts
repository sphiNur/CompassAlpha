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
import { getDb, withOrgContext } from '@compass/db';
import { logger } from '../../infra/log';
import type { RequestContext, SessionContext } from '../../trpc/context';
import { appRouter } from '../../trpc/router';

type Db = ReturnType<typeof getDb>;

export interface TestContextOptions {
  /** As the X-Idempotency-Key header would set it. */
  idempotencyKey?: string | null;
}

/** What createContext builds for a request signed in as `session` (null: anonymous). */
export function testContext(
  session: SessionContext | null,
  options: TestContextOptions = {},
): RequestContext {
  const db = getDb();
  return {
    // No procedure reads the Hono request itself.
    hono: {} as RequestContext['hono'],
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
    hono: {} as RequestContext['hono'],
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
