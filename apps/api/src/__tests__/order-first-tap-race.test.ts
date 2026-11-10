/**
 * ORD-6 / ORD-7 (2026-10-30 operation atlas): two devices of one person
 * making the day's first change at once used to answer one of them with
 * a 500 and lose that tap; ordering in a store without order.draft
 * answered 500 instead of 403.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/order-first-tap-race.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { getDb, schema as s } from '@compass/db';
import { appRouter } from '../trpc/router';
import { SHOULD_RUN } from './helpers/pg';
import { callerFor } from './helpers/ctx';
import { seedRoles, seedMember, sessionOf } from './helpers/fixtures';
import { codeOf } from './helpers/errors';

type Caller = ReturnType<typeof appRouter.createCaller>;
let fix: {
  orgId: string;
  storeId: string;
  skuIds: string[];
  staff: Array<{ memberId: string; devices: () => Promise<[Caller, Caller]> }>;
  noDraft: Caller;
} | null = null;

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug: `race-${suffix}`, name: 'First tap race', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  const orgId = org!.id;
  const roleIds = await seedRoles(db, orgId, ['staff', 'purchaser']);
  const [store] = await db.insert(s.stores).values({ orgId, name: 'Store', code: `R-${suffix.slice(-6)}` }).returning();
  const skuIds: string[] = [];
  for (let i = 0; i < 6; i++) {
    const [sku] = await db
      .insert(s.skus)
      .values({ orgId, code: `RC-${suffix.slice(-6)}-${i}`, names: { en: `Item ${i}` }, unit: 'kg', step: '1' })
      .returning();
    skuIds.push(sku!.id);
  }
  let n = 0;
  const person = async (slug: string) => {
    n += 1;
    const who = await seedMember(db, orgId, {
      name: `P${n}`,
      stores: [store!.id],
      roles: [{ roleId: roleIds[slug]!, storeId: store!.id }],
    });
    const caller = async () => callerFor(await sessionOf(orgId, who));
    return {
      memberId: who.memberId,
      devices: async () => [await caller(), await caller()] as [Caller, Caller],
    };
  };
  const staff = [await person('staff'), await person('staff'), await person('staff')];
  const buyer = await person('purchaser');
  fix = { orgId, storeId: store!.id, skuIds, staff, noDraft: (await buyer.devices())[0] };
});

describe.skipIf(!SHOULD_RUN)('the day\'s first change from two devices (PG-gated)', () => {
  test('ORD-6: both taps land, on one draft', async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    for (const [i, p] of fix!.staff.entries()) {
      const [a, b] = await p.devices();
      const results = await Promise.allSettled([
        a.order.adjustItem({ storeId: fix!.storeId, skuId: fix!.skuIds[i * 2]!, qty: '2' }),
        b.order.adjustItem({ storeId: fix!.storeId, skuId: fix!.skuIds[i * 2 + 1]!, qty: '3' }),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      const drafts = await db
        .select({ id: s.orderSessionsV.id })
        .from(s.orderSessionsV)
        .where(and(eq(s.orderSessionsV.initiatedByMemberId, p.memberId), eq(s.orderSessionsV.status, 'draft')));
      expect(drafts).toHaveLength(1);
      const items = await db.select().from(s.orderItemsV).where(eq(s.orderItemsV.sessionId, drafts[0]!.id));
      expect(items).toHaveLength(2);
    }
  });

  test('ORD-7: ordering where one has no order.draft is FORBIDDEN, not a server error', async () => {
    const order = () =>
      fix!.noDraft.order.adjustItem({ storeId: fix!.storeId, skuId: fix!.skuIds[0]!, qty: '1' });
    expect(await codeOf(order)).toBe('FORBIDDEN');
  });
});
