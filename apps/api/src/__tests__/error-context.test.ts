/**
 * CMP-FE-1 / CMP-COPY-2 (2026-10-31): the client fills a refusal's
 * sentence ("at most {days} days back", "a multiple of {step}") from
 * `data.context`. Domain errors always sent it; a router's own TRPCError
 * with `cause.context` (settlement's date limit) now does too.
 */
import { describe, expect, test } from 'bun:test';
import { TRPCError } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { validation } from '@compass/domain';
import { publicProcedure, router } from '../trpc/trpc';
import type { RequestContext } from '../trpc/context';

const probe = router({
  tooOld: publicProcedure.query(() => {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'settlement.errors.dateTooOld',
      cause: { field: 'date', reason: 'too-old', context: { days: 90 } },
    });
  }),
  noContext: publicProcedure.query(() => {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'settlement.errors.futureDate',
      cause: { field: 'date', reason: 'future-date' },
    });
  }),
  domain: publicProcedure.query(() => {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'order.errors.qtyNotMultipleOfStep',
      cause: validation('order.errors.qtyNotMultipleOfStep', { step: '0.500' }),
    });
  }),
});

async function errorData(path: string): Promise<Record<string, unknown>> {
  const res = await fetchRequestHandler({
    endpoint: '/trpc',
    req: new Request(`http://local/trpc/${path}`),
    router: probe,
    createContext: () => ({}) as unknown as RequestContext,
  });
  const body = (await res.json()) as { error: { message: string; data: Record<string, unknown> } };
  return { message: body.error.message, ...body.error.data };
}

describe('error context reaches the client', () => {
  test('a TRPCError cause with context', async () => {
    const data = await errorData('tooOld');
    expect(data.message).toBe('settlement.errors.dateTooOld');
    expect(data.context).toEqual({ days: 90 });
  });

  test('no context, no field', async () => {
    const data = await errorData('noContext');
    expect(data.message).toBe('settlement.errors.futureDate');
    expect('context' in data).toBe(false);
  });

  test('a domain error keeps its key and context', async () => {
    const data = await errorData('domain');
    expect(data.i18nKey).toBe('order.errors.qtyNotMultipleOfStep');
    expect(data.context).toEqual({ step: '0.500' });
  });
});
