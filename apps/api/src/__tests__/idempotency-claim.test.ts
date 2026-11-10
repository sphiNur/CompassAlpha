/**
 * R3 (2026-10-30): the idempotency middleware claims a key before it runs
 * the handler. Two requests with the same key used to both miss the
 * cache and both run (a double-tapped sale was booked twice).
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/idempotency-claim.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { getDb, schema as s } from '@compass/db';
import { idempotencyRequestHash, idempotentMutation, router } from '../trpc/trpc';
import type { SessionContext } from '../trpc/context';
import { SHOULD_RUN } from './helpers/pg';
import { freshTgId } from './helpers/telegram';
import { testContext } from './helpers/ctx';
import { errorOf } from './helpers/errors';
import { cleanUpAfterAll, noteOrg, noteUser } from './helpers/cleanup';

cleanUpAfterAll();

let session: SessionContext | null = null;
let runs = 0;
let failNext = false;

const testRouter = router({
  slowWrite: idempotentMutation.mutation(async () => {
    runs += 1;
    const n = runs;
    await new Promise((r) => setTimeout(r, 150));
    if (failNext) {
      failNext = false;
      throw new Error('handler failed');
    }
    return { n };
  }),
  buy: idempotentMutation
    .input(z.object({ item: z.string(), qty: z.number() }))
    .mutation(async ({ input }) => {
      runs += 1;
      return { bought: input.item, n: runs };
    }),
});

function caller(key: string) {
  return testRouter.createCaller(testContext(session!, { idempotencyKey: key }));
}

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const slug = `idem-${Date.now()}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug, name: 'Idempotency claim test', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  noteOrg(org!.id);
  const [user] = await db
    .insert(s.users)
    .values({ displayName: 'Idem', tgUserId: freshTgId() })
    .returning();
  noteUser(user!.id);
  const [member] = await db
    .insert(s.members)
    .values({ orgId: org!.id, userId: user!.id })
    .returning();
  session = {
    userId: user!.id,
    memberId: member!.id,
    orgId: org!.id,
    orgTimezone: 'UTC',
    permissions: new Set<string>(),
    roleSlugs: new Set<string>(),
  } as unknown as SessionContext;
});

describe.skipIf(!SHOULD_RUN)('idempotency claim (PG-gated)', () => {
  test('two concurrent requests with one key run the handler once and share its answer', async () => {
    const key = randomUUID();
    const before = runs;
    const [a, b] = await Promise.all([caller(key).slowWrite(), caller(key).slowWrite()]);
    expect(runs - before).toBe(1);
    expect(a).toEqual(b);
    // And a later retry gets the cached answer without running again.
    const c = await caller(key).slowWrite();
    expect(c).toEqual(a);
    expect(runs - before).toBe(1);
  });

  test('a mutation without input works over HTTP with a key (empty body)', async () => {
    const post = () =>
      fetchRequestHandler({
        endpoint: '/trpc',
        router: testRouter,
        req: new Request('http://test/trpc/slowWrite', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
        }),
        createContext: () => testContext(session!, { idempotencyKey: randomUUID() }),
      });
    const res = await post();
    expect(res.status).toBe(200);
  });

  test('a failed attempt frees its key so the retry runs', async () => {
    const key = randomUUID();
    failNext = true;
    await expect(caller(key).slowWrite()).rejects.toThrow('handler failed');
    const before = runs;
    const ok = await caller(key).slowWrite();
    expect(runs - before).toBe(1);
    expect(ok.n).toBe(runs);
  });

  test('BUY-16: one key with a different body is refused, not answered with the old result', async () => {
    const key = randomUUID();
    const first = await caller(key).buy({ item: 'apple', qty: 1 });
    // The same request again (keys in another order) is the cached answer.
    expect(await caller(key).buy({ qty: 1, item: 'apple' })).toEqual(first);
    const before = runs;
    expect(await errorOf(() => caller(key).buy({ item: 'chicken', qty: 1 }))).toMatchObject({
      code: 'CONFLICT',
      message: 'common.errors.idempotencyKeyReused',
    });
    expect(runs).toBe(before);
  });

  test('BUY-16: the body hash ignores key order and undefined fields', () => {
    expect(idempotencyRequestHash({ a: 1, b: [1, { c: 2, d: undefined }] })).toBe(
      idempotencyRequestHash({ b: [1, { c: 2 }], a: 1 }),
    );
    expect(idempotencyRequestHash({ a: 1 })).not.toBe(idempotencyRequestHash({ a: 2 }));
  });

  test('different keys still each run', async () => {
    const before = runs;
    await Promise.all([caller(randomUUID()).slowWrite(), caller(randomUUID()).slowWrite()]);
    expect(runs - before).toBe(2);
  });
});
