/**
 * Review RUNAPI-06 (2026-11-09): run.list took the organisation's newest
 * 50 runs and filtered them by the reader's stores afterwards. A store's
 * reader got fewer than 50, or none, and a run still waiting for that
 * store's receipt fell off the receiving page once 50 newer runs existed:
 * the store could not confirm it and the run could never finish.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/run-list-scope.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
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
const seedDataPath = resolve(HERE, '../../../../packages/db/src/seed-data.ts');
const { BUILTIN_ROLES } = (await import(seedDataPath)) as SeedData;

type Caller = ReturnType<typeof appRouter.createCaller>;
let fix: {
  orgId: string;
  storeA: string;
  storeB: string;
  skuId: string;
  staffA: Caller;
  staffB: Caller;
} | null = null;

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug: `runlist-${suffix}`, name: 'Run list', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  const orgId = org!.id;
  const def = BUILTIN_ROLES.find((r) => r.slug === 'staff')!;
  const [role] = await db
    .insert(s.roles)
    .values({ orgId, slug: 'staff', name: 'staff', rank: def.rank, isBuiltIn: true })
    .returning();
  for (const key of def.permissions) {
    await db.insert(s.permissions).values({ key, description: key }).onConflictDoNothing();
    await db
      .insert(s.rolePermissions)
      .values({ roleId: role!.id, permissionKey: key })
      .onConflictDoNothing();
  }
  const store = async (name: string) =>
    (
      await db
        .insert(s.stores)
        .values({ orgId, name, code: `${name}-${suffix.slice(-6)}` })
        .returning()
    )[0]!.id;
  const storeA = await store('A');
  const storeB = await store('B');
  const [sku] = await db
    .insert(s.skus)
    .values({ orgId, code: `RL-${suffix.slice(-8)}`, names: { en: 'Rice' }, unit: 'kg', step: '1' })
    .returning();
  let n = 0;
  const staff = async (storeId: string): Promise<Caller> => {
    n += 1;
    const [u] = await db
      .insert(s.users)
      .values({ displayName: `Run list ${n}`, tgUserId: freshTgId() })
      .returning();
    const [m] = await db
      .insert(s.members)
      .values({ orgId, userId: u!.id, status: 'active' })
      .returning();
    await db
      .insert(s.memberStoreAssignments)
      .values({ memberId: m!.id, storeId, assignedBy: u!.id });
    await db
      .insert(s.memberRoleBindings)
      .values({ memberId: m!.id, roleId: role!.id, scopeType: 'store', scopeId: storeId });
    const session = await loadSession(db, u!.id, orgId, m!.id);
    if (!session) throw new Error('session failed to load');
    return callerFor(session);
  };
  fix = {
    orgId,
    storeA,
    storeB,
    skuId: sku!.id,
    staffA: await staff(storeA),
    staffB: await staff(storeB),
  };
});

describe.skipIf(!SHOULD_RUN)('run.list scope (PG-gated)', () => {
  test("a store's runs are listed past 50 newer runs of other stores; an open one always", async () => {
    const { orgId, storeA, storeB, skuId, staffA, staffB } = fix!;
    const orderA = (await staffA.order.adjustItem({ storeId: storeA, skuId, qty: '1' })).sessionId;
    const orderB = (await staffB.order.adjustItem({ storeId: storeB, skuId, qty: '1' })).sessionId;
    const db = getDb(undefined, { system: 'maintenance' });
    const run = (runDate: string, runIndex: number, status: string, sessionId: string) => ({
      id: randomUUID(),
      orgId,
      runDate,
      runIndex,
      status,
      sessionIdsJson: [sessionId] as unknown as Record<string, unknown>,
    });
    const waiting = run('2026-01-01', 0, 'delivering', orderA);
    const doneA = run('2026-01-02', 0, 'finished', orderA);
    const newerB = Array.from({ length: 50 }, (_, i) => run('2026-02-01', i, 'finished', orderB));
    await db.insert(s.marketRunsV).values([waiting, doneA, ...newerB]);

    const listed = (await staffA.run.list()).map((r) => r.id);
    // The old query: the 50 newest are store B's, so store A saw nothing.
    expect(listed).toContain(waiting.id);
    expect(listed).toContain(doneA.id);
    expect(listed.some((id) => newerB.some((r) => r.id === id))).toBe(false);

    // Store B's reader gets its 50, plus an older run of B's still out
    // for delivery: open runs are not cut by the limit.
    const later = run('2025-12-01', 0, 'delivering', orderB);
    await db.insert(s.marketRunsV).values(later);
    const listedB = (await staffB.run.list()).map((r) => r.id);
    expect(listedB).toContain(later.id);
    expect(listedB.filter((id) => newerB.some((r) => r.id === id))).toHaveLength(50);
  });
});
