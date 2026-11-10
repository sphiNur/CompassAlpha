/**
 * ORD-6 / ORD-7 (2026-10-30 operation atlas): two devices of one person
 * making the day's first change at once used to answer one of them with
 * a 500 and lose that tap; ordering in a store without order.draft
 * answered 500 instead of 403.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/order-first-tap-race.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { getDb, schema as s } from '@compass/db';
import { appRouter } from '../trpc/router';
import { loadSession } from '../trpc/context';
import { SHOULD_RUN } from './helpers/pg';
import { freshTgId } from './helpers/telegram';
import { callerFor } from './helpers/ctx';

const HERE = dirname(fileURLToPath(import.meta.url));
type SeedData = {
  BUILTIN_ROLES: readonly { slug: string; rank: number; permissions: readonly string[] }[];
};
const { BUILTIN_ROLES } = (await import(
  resolve(HERE, '../../../../packages/db/src/seed-data.ts')
)) as SeedData;

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
  const roleIds: Record<string, string> = {};
  for (const slug of ['staff', 'purchaser']) {
    const def = BUILTIN_ROLES.find((r) => r.slug === slug)!;
    const [role] = await db.insert(s.roles).values({ orgId, slug, name: slug, rank: def.rank, isBuiltIn: true }).returning();
    roleIds[slug] = role!.id;
    for (const key of def.permissions) {
      await db.insert(s.permissions).values({ key, description: key }).onConflictDoNothing();
      await db.insert(s.rolePermissions).values({ roleId: role!.id, permissionKey: key }).onConflictDoNothing();
    }
  }
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
    const [user] = await db.insert(s.users).values({ displayName: `P${n}`, tgUserId: freshTgId() }).returning();
    const [m] = await db.insert(s.members).values({ orgId, userId: user!.id, status: 'active' }).returning();
    await db.insert(s.memberRoleBindings).values({ memberId: m!.id, roleId: roleIds[slug]!, scopeType: 'store', scopeId: store!.id });
    await db.insert(s.memberStoreAssignments).values({ memberId: m!.id, storeId: store!.id, assignedBy: user!.id });
    const caller = async () => {
      const session = await loadSession(db, user!.id, orgId, m!.id);
      if (!session) throw new Error('session failed to load');
      return callerFor(session);
    };
    return { memberId: m!.id, devices: async () => [await caller(), await caller()] as [Caller, Caller] };
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
    let code: string | undefined;
    try {
      await fix!.noDraft.order.adjustItem({ storeId: fix!.storeId, skuId: fix!.skuIds[0]!, qty: '1' });
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('FORBIDDEN');
  });
});
