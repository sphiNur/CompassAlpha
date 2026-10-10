/**
 * Read endpoints that must not be open to every signed-in member.
 * The gate runs before any query, so no database is needed.
 */
import { describe, expect, test } from 'bun:test';
import { logger } from '../infra/log';
import { appRouter } from '../trpc/router';
import type { RequestContext } from '../trpc/context';

function callerWith(permissions: string[]) {
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
    session: {
      userId: '00000000-0000-4000-8000-000000000001',
      memberId: '00000000-0000-4000-8000-000000000002',
      orgId: '00000000-0000-4000-8000-000000000003',
      orgTimezone: 'UTC',
      permissions: new Set(permissions),
      roleSlugs: new Set(),
    },
    async withOrg() {
      throw new Error('reached the handler');
    },
  };
  return appRouter.createCaller(ctx);
}

describe('system.recentLogs', () => {
  test('is forbidden without system.logs.view', async () => {
    await expect(callerWith(['order.draft']).system.recentLogs({})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  test('reaches the handler with it', async () => {
    await expect(callerWith(['system.logs.view']).system.recentLogs({})).rejects.toThrow(
      'reached the handler',
    );
  });
});
