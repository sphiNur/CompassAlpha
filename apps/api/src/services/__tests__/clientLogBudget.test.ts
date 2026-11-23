/**
 * Review (2026-11-23): system.log needs no sign-in, and 60 calls a minute
 * of 200 events each let one address store about 190 MB a minute in
 * ops.client_logs and the journal. A budget of bytes per address and
 * minute now sits beside the call limit; and the limiter's buckets, which
 * were replaced only by a re-hit, are swept.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { _rateBucketCount, _resetRateBuckets, checkRate, SWEEP_EVERY } from '../rateLimit';
import { logRowBytes } from '../../trpc/routers/system';
import { appRouter } from '../../trpc/router';
import { logger } from '../../infra/log';
import { testHono } from '../../__tests__/helpers/ctx';
import type { RequestContext } from '../../trpc/context';

afterEach(() => _resetRateBuckets());

describe('a rate budget counted in something other than calls', () => {
  test('a cost adds up, and the call that would pass the budget is refused', () => {
    const opts = { window: 60_000, max: 100 };
    expect(checkRate('t', 'a', opts, 60)).toBe(true);
    expect(checkRate('t', 'a', opts, 41)).toBe(false);
    expect(checkRate('t', 'a', opts, 40)).toBe(true);
    expect(checkRate('t', 'a', opts, 1)).toBe(false);
    // One call bigger than the whole budget is refused on its own.
    expect(checkRate('t', 'b', opts, 101)).toBe(false);
  });

  test('without a cost, calls count one each, as before', () => {
    const opts = { window: 60_000, max: 2 };
    expect(checkRate('t', 'c', opts)).toBe(true);
    expect(checkRate('t', 'c', opts)).toBe(true);
    expect(checkRate('t', 'c', opts)).toBe(false);
  });

  test('expired buckets are swept, not kept for every address ever seen', () => {
    for (let i = 0; i < SWEEP_EVERY - 1; i++) checkRate('t', `ip-${i}`, { window: -1, max: 5 });
    expect(_rateBucketCount()).toBe(SWEEP_EVERY - 1);
    checkRate('t', 'one-more', { window: 60_000, max: 5 });
    expect(_rateBucketCount()).toBe(1);
  });
});

describe('system.log and its byte budget', () => {
  const caller = (ip: string) =>
    appRouter.createCaller({
      hono: testHono() as unknown as RequestContext['hono'],
      // No database: a batch the budget lets through fails at its insert.
      db: {} as RequestContext['db'],
      log: logger,
      traceId: 'test',
      ip,
      trustedIp: ip,
      userAgent: null,
      idempotencyKey: null,
      session: null,
      async withOrg() {
        throw new Error('no tenant here');
      },
    } as RequestContext);
  const event = (errorStack: string) => ({ sessionId: 's1', kind: 'error', errorStack });
  // An ordinary stack trace, about 8 KB.
  const stack = 'at render (app.js:12:345)\n'.repeat(300);
  const batch = () => ({ events: Array.from({ length: 200 }, () => event(stack)) });

  test('a row costs its text and data', () => {
    expect(
      logRowBytes({ sessionId: 'ab', kind: 'k', level: 'info', clientTs: 0, data: { a: 1 } }),
    ).toBe(2 + 1 + JSON.stringify({ a: 1 }).length);
  });

  test('a batch over an address’s minute budget is refused before anything is written', async () => {
    // 200 × 8 KB is 1.6 MB: over the 1 MB budget in one batch. The caller
    // has no database, so getting this answer means nothing was written.
    await expect(caller('10.0.0.1').system.log(batch())).rejects.toThrow(
      'system.errors.logRateLimited',
    );
  });
});
