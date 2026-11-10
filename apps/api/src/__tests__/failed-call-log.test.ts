/**
 * COREAPI-02 (2026-11-09): a refused call is logged on the server. tRPC v11
 * hands a procedure's failure back from `next()` instead of throwing it, so
 * the error log middleware's try/catch never ran and nothing was logged.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { preconditionFailed } from '@compass/domain';
import { logger } from '../infra/log';
import { publicProcedure, rethrowDomainError, router } from '../trpc/trpc';
import type { RequestContext } from '../trpc/context';

const probe = router({
  forbidden: publicProcedure.mutation(() => {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'auth.errors.missingPermission',
      cause: { missingPermission: 'run.purchase' },
    });
  }),
  rule: publicProcedure.mutation(() =>
    rethrowDomainError(preconditionFailed('run.errors.notPurchasing', { status: 'planned' })),
  ),
  named: publicProcedure.mutation(() => {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'attendance.errors.justPunched',
      cause: { context: { at: '09:01', name: 'Bob Example' } },
    });
  }),
  invalid: publicProcedure
    .input(z.object({ amount: z.string().regex(/^\d+$/) }))
    .mutation(() => 'never'),
  signedOut: publicProcedure.mutation(() => {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'auth.errors.required' });
  }),
  refusedRead: publicProcedure.query(() => {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'run.errors.notVisible' });
  }),
  down: publicProcedure.mutation(() => {
    throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'common.errors.internal' });
  }),
  broken: publicProcedure.mutation(() => {
    throw new Error('a bug');
  }),
  fine: publicProcedure.mutation(() => 'ok'),
});

const ctx = {
  traceId: 'trace-1',
  session: { userId: 'user-1', orgId: 'org-1' },
} as unknown as RequestContext;
const caller = probe.createCaller(ctx);

type Spy = ReturnType<typeof spyOn>;
let spies: Record<'debug' | 'info' | 'warn' | 'error', Spy>;

beforeEach(() => {
  const quiet = () => undefined;
  spies = {
    debug: spyOn(logger, 'debug').mockImplementation(quiet),
    info: spyOn(logger, 'info').mockImplementation(quiet),
    warn: spyOn(logger, 'warn').mockImplementation(quiet),
    error: spyOn(logger, 'error').mockImplementation(quiet),
  };
});
afterEach(() => {
  for (const spy of Object.values(spies)) spy.mockRestore();
});

/** Each level's logged objects, after a call that may fail. */
async function logged(call: () => Promise<unknown>) {
  await call().catch(() => undefined);
  const at = (level: keyof typeof spies) =>
    spies[level].mock.calls.map((args: unknown[]) => args[0] as Record<string, unknown>);
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') };
}

describe('failed calls in the server log', () => {
  test('a refused mutation: who, what, the key and the missing permission', async () => {
    const out = await logged(() => caller.forbidden());
    expect(out.info).toHaveLength(1);
    expect(out.info[0]).toMatchObject({
      path: 'forbidden',
      type: 'mutation',
      code: 'FORBIDDEN',
      key: 'auth.errors.missingPermission',
      missingPermission: 'run.purchase',
      traceId: 'trace-1',
      userId: 'user-1',
      orgId: 'org-1',
    });
  });

  test("a domain rule's refusal keeps its context", async () => {
    const out = await logged(() => caller.rule());
    expect(out.info[0]).toMatchObject({
      code: 'PRECONDITION_FAILED',
      key: 'run.errors.notPurchasing',
      context: { status: 'planned' },
    });
  });

  test('no name from the details', async () => {
    const out = await logged(() => caller.named());
    expect(out.info[0]!.context).toEqual({ at: '09:01' });
  });

  test('a rejected input names the field, never the value', async () => {
    const out = await logged(() => caller.invalid({ amount: 'SECRET-41.31' }));
    expect(out.info[0]).toMatchObject({
      code: 'BAD_REQUEST',
      key: 'common.errors.validation',
      fields: ['amount'],
    });
    expect(JSON.stringify(out.info[0])).not.toContain('SECRET');
  });

  test('routine failures stay at debug: a refused read, a call without a session', async () => {
    for (const call of [() => caller.refusedRead(), () => caller.signedOut()]) {
      const out = await logged(call);
      expect(out.info).toHaveLength(0);
      expect(
        out.debug.some(
          (o: Record<string, unknown>) => o.code === 'FORBIDDEN' || o.code === 'UNAUTHORIZED',
        ),
      ).toBe(true);
      for (const spy of Object.values(spies)) spy.mockClear();
    }
  });

  test('another server fault is a warning', async () => {
    const out = await logged(() => caller.down());
    expect(out.warn[0]).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  test("a bug is left to tRPC's onError, which logs its cause; success logs nothing", async () => {
    for (const call of [() => caller.broken(), () => caller.fine()]) {
      const out = await logged(call);
      expect([...out.debug, ...out.info, ...out.warn, ...out.error]).toHaveLength(0);
    }
  });
});
