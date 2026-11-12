/**
 * Review RUNAPI-20 (2026-11-12): run.create and run.attachSessions check
 * the read model for approved orders, then decide AttachToRun on each
 * order's own stream. When an order changed in between (unapproved, say),
 * the domain refused it with an error the router did not translate, so
 * the client got a server error (500) and the log a server fault. Here
 * the read model says approved while the stream says submitted, which is
 * that moment held still.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/run-order-refusals.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { getDb, schema as s } from '@compass/db';
import { appRouter } from '../trpc/router';
import { SHOULD_RUN } from './helpers/pg';
import { callerFor } from './helpers/ctx';
import { seedRoles, seedMember, sessionOf } from './helpers/fixtures';
import { errorOf } from './helpers/errors';
import { cleanUpAfterAll, noteOrg } from './helpers/cleanup';

cleanUpAfterAll();

type Caller = ReturnType<typeof appRouter.createCaller>;
let fix: { storeId: string; skuIds: string[]; buyer: Caller; reviewer: Caller } | null = null;

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({
      slug: `refuse-${suffix}`,
      name: 'Run refusals',
      localeDefault: 'en',
      timezone: 'UTC',
    })
    .returning();
  noteOrg(org!.id);
  const orgId = org!.id;
  const roleId = (await seedRoles(db, orgId, ['super_admin'])).super_admin!;
  const [store] = await db
    .insert(s.stores)
    .values({ orgId, name: 'Store', code: `RR-${suffix.slice(-6)}` })
    .returning();
  const skus = await db
    .insert(s.skus)
    .values(
      ['Rice', 'Flour', 'Salt'].map((name) => ({
        orgId,
        code: `${name}-${suffix.slice(-8)}`,
        names: { en: name },
        unit: 'kg',
        step: '1',
      })),
    )
    .returning();
  const person = async (n: number): Promise<Caller> => {
    const who = await seedMember(db, orgId, {
      name: `Refusals ${n}`,
      stores: [store!.id],
      roles: [{ roleId }],
    });
    return callerFor(await sessionOf(orgId, who));
  };
  fix = {
    storeId: store!.id,
    skuIds: skus.map((sku) => sku.id),
    buyer: await person(1),
    reviewer: await person(2),
  };
});

/** An order its stream calls submitted and the read model approved. */
async function approvedOnlyInReadModel(skuId: string): Promise<string> {
  const { storeId, buyer } = fix!;
  const draft = await buyer.order.adjustItem({ storeId, skuId, qty: '1' });
  await buyer.order.submit({ sessionId: draft.sessionId });
  await getDb(undefined, { system: 'maintenance' })
    .update(s.orderSessionsV)
    .set({ status: 'approved' })
    .where(eq(s.orderSessionsV.id, draft.sessionId));
  return draft.sessionId;
}

describe.skipIf(!SHOULD_RUN)('an order that changed under a run command (PG-gated)', () => {
  test('run.create refuses it as the domain does, not with a server error', async () => {
    const sessionId = await approvedOnlyInReadModel(fix!.skuIds[0]!);
    expect(await errorOf(() => fix!.buyer.run.create({ sessionIds: [sessionId] }))).toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: 'order.errors.cannotAttach',
    });
  });

  test('so does run.attachSessions', async () => {
    const { storeId, skuIds, buyer, reviewer } = fix!;
    const draft = await buyer.order.adjustItem({ storeId, skuId: skuIds[1]!, qty: '1' });
    await buyer.order.submit({ sessionId: draft.sessionId });
    await reviewer.order.claim({ sessionId: draft.sessionId });
    await reviewer.order.approve({ sessionId: draft.sessionId });
    const run = await buyer.run.create({ sessionIds: [draft.sessionId] });

    const sessionId = await approvedOnlyInReadModel(skuIds[2]!);
    expect(
      await errorOf(() => buyer.run.attachSessions({ runId: run.runId, sessionIds: [sessionId] })),
    ).toMatchObject({ code: 'PRECONDITION_FAILED', message: 'order.errors.cannotAttach' });
  });
});
