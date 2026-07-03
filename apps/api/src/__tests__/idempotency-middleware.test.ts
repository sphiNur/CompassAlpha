/**
 * Pins the tRPC v11 middleware-result contract the idempotency middleware
 * (trpc.ts) relies on for its cache-hit short-circuit (P0 H2).
 *
 * The bug: on a cache hit the middleware returned the RAW cached payload
 * (e.g. `{ runId, lastSeq }`), which has no `ok` field. tRPC's procedure
 * caller treats a middleware result without `ok === true` as a failure and
 * throws INTERNAL_SERVER_ERROR — so every idempotent replay 500'd instead
 * of returning the prior response, silently defeating the whole mechanism.
 *
 * The fix returns a properly-shaped `{ ok: true, data, ctx }` result. This
 * test validates that contract without a DB, and will fail loudly if a
 * future tRPC upgrade changes how short-circuited middleware results are
 * consumed (e.g. starts requiring the internal marker).
 */
import { describe, it, expect } from 'bun:test';
import { initTRPC } from '@trpc/server';

const t = initTRPC.context<Record<string, unknown>>().create();

describe('tRPC middleware short-circuit contract (idempotency cache hit)', () => {
  it('returns the synthetic ok-result data WITHOUT running the handler', async () => {
    let handlerRuns = 0;
    const cached = { runId: 'cached-run', lastSeq: 7 };
    const shortCircuit = t.middleware(async (opts) => {
      // Same shape the idempotency middleware returns on a cache hit.
      return {
        ok: true,
        data: cached,
        ctx: opts.ctx,
      } as unknown as Awaited<ReturnType<typeof opts.next>>;
    });
    const router = t.router({
      purchaseItem: t.procedure.use(shortCircuit).mutation(() => {
        handlerRuns++;
        return { runId: 'fresh-run', lastSeq: 99 };
      }),
    });

    const res = await router.createCaller({}).purchaseItem();

    expect(res).toEqual(cached); // prior response, not the handler's
    expect(handlerRuns).toBe(0); // handler must NOT run on a cache hit
  });

  it('runs the handler and returns its data on a miss (control)', async () => {
    let handlerRuns = 0;
    const passthrough = t.middleware(async (opts) => opts.next());
    const router = t.router({
      purchaseItem: t.procedure.use(passthrough).mutation(() => {
        handlerRuns++;
        return { runId: 'fresh-run', lastSeq: 99 };
      }),
    });

    const res = await router.createCaller({}).purchaseItem();

    expect(res).toEqual({ runId: 'fresh-run', lastSeq: 99 });
    expect(handlerRuns).toBe(1);
  });
});
