/**
 * A database failure is not a sign-out (COREAPI-15, 2026-11-09).
 *
 * The request context read the token and the session in one try, so when
 * the session could not be loaded a signed-in user was answered
 * UNAUTHORIZED: the app went to refresh its token, and the log blamed the
 * JWT. No database is needed here: the session lookup is a stub.
 */
import { describe, expect, test } from 'bun:test';
import { logger } from '../infra/log';
import { appRouter } from '../trpc/router';
import { sessionFromToken, type RequestContext, type SessionContext } from '../trpc/context';

const CLAIMS = {
  sub: '00000000-0000-4000-8000-000000000001',
  org: '00000000-0000-4000-8000-000000000003',
  mid: '00000000-0000-4000-8000-000000000002',
  fam: 'family-1',
};
const SESSION: SessionContext = {
  userId: CLAIMS.sub,
  memberId: CLAIMS.mid,
  orgId: CLAIMS.org,
  orgTimezone: 'UTC',
  permissions: new Set(),
  roleSlugs: new Set(),
};

function deps(over: Partial<Parameters<typeof sessionFromToken>[1]> = {}) {
  const lines: string[] = [];
  return {
    lines,
    deps: {
      verifyAccess: async () => CLAIMS,
      loadSession: async () => ({ ...SESSION }),
      log: {
        warn: (_: object, msg: string) => void lines.push(`warn: ${msg}`),
        error: (_: object, msg: string) => void lines.push(`error: ${msg}`),
      },
      ...over,
    } as Parameters<typeof sessionFromToken>[1],
  };
}

describe('sessionFromToken', () => {
  test('a good token and a readable session sign the request in', async () => {
    const { deps: d } = deps();
    const r = await sessionFromToken('t', d);
    expect(r.unavailable).toBe(false);
    expect(r.session?.memberId).toBe(CLAIMS.mid);
    expect(r.session?.refreshFamily).toBe('family-1');
  });

  test('a bad token is anonymous, and the session is never read', async () => {
    let read = false;
    const { deps: d, lines } = deps({
      verifyAccess: async () => {
        throw new Error('signature verification failed');
      },
      loadSession: async () => {
        read = true;
        return SESSION;
      },
    });
    expect(await sessionFromToken('t', d)).toEqual({ session: null, unavailable: false });
    expect(read).toBe(false);
    expect(lines).toEqual(['warn: invalid jwt; treating as anonymous']);
  });

  test('a session that cannot be read is unavailable, not anonymous', async () => {
    const { deps: d, lines } = deps({
      loadSession: async () => {
        throw new Error('connection terminated unexpectedly');
      },
    });
    expect(await sessionFromToken('t', d)).toEqual({ session: null, unavailable: true });
    expect(lines).toEqual(['error: session lookup failed']);
  });

  test('a member who left the workspace is anonymous', async () => {
    const { deps: d } = deps({ loadSession: async () => null });
    expect(await sessionFromToken('t', d)).toEqual({ session: null, unavailable: false });
  });
});

describe('a signed-in procedure without a session', () => {
  const callerWith = (sessionUnavailable: boolean) => {
    const ctx: RequestContext = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hono: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: {} as any,
      log: logger,
      traceId: 'test',
      ip: null,
      userAgent: null,
      idempotencyKey: null,
      session: null,
      sessionUnavailable,
      async withOrg() {
        throw new Error('reached the handler');
      },
    };
    return appRouter.createCaller(ctx);
  };

  test('answers SERVICE_UNAVAILABLE when the session could not be read', async () => {
    await expect(callerWith(true).system.recentLogs({})).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'common.errors.internal',
    });
  });

  test('answers UNAUTHORIZED when there was no usable token', async () => {
    await expect(callerWith(false).system.recentLogs({})).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});
