/**
 * D1 (2026-11-13): inventory.stocktakeBatch, the count mode's one save.
 * Each count is applied as inventory.stocktake applies one (a ledger row
 * with reason 'stocktake' for the difference, none when it matches), all
 * in one transaction, and a retry with the same key replays. PG-gated.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { getDb, schema as s } from '@compass/db';
import { SHOULD_RUN } from './helpers/pg';
import { callerFor } from './helpers/ctx';
import { seedMember, seedRoles, sessionOf } from './helpers/fixtures';
import { errorOf } from './helpers/errors';
import { cleanUpAfterAll, noteOrg } from './helpers/cleanup';

cleanUpAfterAll();

interface Fixture {
  orgId: string;
  managerRoleId: string;
  skuIds: [string, string, string];
}

let fix: Fixture | null = null;

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug: `d1-count-${suffix}`, name: 'D1 count mode', localeDefault: 'en' })
    .returning();
  noteOrg(org!.id);
  const roles = await seedRoles(db, org!.id, ['manager']);
  const skus = await db
    .insert(s.skus)
    .values(
      ['Flour', 'Rice', 'Oil'].map((name, i) => ({
        orgId: org!.id,
        code: `D1-${i}-${suffix.slice(-6)}`,
        names: { en: name },
        unit: 'kg',
      })),
    )
    .returning();
  fix = {
    orgId: org!.id,
    managerRoleId: roles.manager!,
    skuIds: [skus[0]!.id, skus[1]!.id, skus[2]!.id],
  };
});

async function makeStore(): Promise<string> {
  const db = getDb(undefined, { system: 'maintenance' });
  const [store] = await db
    .insert(s.stores)
    .values({ orgId: fix!.orgId, name: `D1 store ${Math.random()}` })
    .returning();
  return store!.id;
}

async function managerOf(
  storeId: string,
  denies: string[] = [],
  idempotencyKey: string | null = null,
) {
  const db = getDb(undefined, { system: 'maintenance' });
  const who = await seedMember(db, fix!.orgId, {
    name: 'D1 manager',
    roles: [{ roleId: fix!.managerRoleId, storeId }],
  });
  for (const key of denies) {
    await db.insert(s.memberPermissionOverrides).values({
      memberId: who.memberId,
      permissionKey: key,
      effect: 'deny',
      scopeType: 'store',
      scopeId: storeId,
    });
  }
  return callerFor(await sessionOf(fix!.orgId, who), { idempotencyKey });
}

async function movementsOf(storeId: string) {
  const db = getDb(undefined, { system: 'maintenance' });
  return db
    .select({
      skuId: s.inventoryMovements.skuId,
      delta: s.inventoryMovements.delta,
      reason: s.inventoryMovements.reason,
    })
    .from(s.inventoryMovements)
    .where(
      and(eq(s.inventoryMovements.orgId, fix!.orgId), eq(s.inventoryMovements.storeId, storeId)),
    );
}

describe.skipIf(!SHOULD_RUN)('D1 inventory.stocktakeBatch', () => {
  test('records each count as a stocktake, and skips one that matches', async () => {
    const storeId = await makeStore();
    const caller = await managerOf(storeId);
    const [flour, rice, oil] = fix!.skuIds;
    await caller.inventory.stocktake({ storeId, skuId: rice, target: '3' });
    await caller.inventory.stocktake({ storeId, skuId: oil, target: '2' });

    const res = await caller.inventory.stocktakeBatch({
      storeId,
      counts: [
        { skuId: flour, target: '5' },
        { skuId: rice, target: '3.000' },
        { skuId: oil, target: '1.5' },
      ],
    });
    expect(res.applied).toBe(2);
    expect(res.results).toEqual([
      { skuId: flour, skipped: false, appliedDelta: '5.000', newOnHand: '5.000' },
      { skuId: rice, skipped: true, currentOnHand: '3.000' },
      { skuId: oil, skipped: false, appliedDelta: '-0.500', newOnHand: '1.500' },
    ]);

    const levels = await caller.inventory.levels({ storeId });
    const onHand = Object.fromEntries(levels.map((l) => [l.skuId, l.onHand]));
    expect(onHand).toEqual({ [flour]: '5.000', [rice]: '3.000', [oil]: '1.500' });
    // The same ledger rows a one-product stocktake writes.
    const rows = await movementsOf(storeId);
    expect(rows.every((r) => r.reason === 'stocktake')).toBe(true);
    expect(rows).toHaveLength(4);
  });

  test('a retry with the same key replays instead of counting again', async () => {
    const storeId = await makeStore();
    const key = `d1-batch-${Date.now()}-${Math.random()}`;
    const counter = await managerOf(storeId, [], key);
    const [flour] = fix!.skuIds;
    const input = { storeId, counts: [{ skuId: flour, target: '4' }] };
    const first = await counter.inventory.stocktakeBatch(input);
    // Someone else corrects the stock between the first post and its retry.
    const other = await managerOf(storeId);
    await other.inventory.stocktake({ storeId, skuId: flour, target: '6' });
    const retry = await counter.inventory.stocktakeBatch(input);
    expect(retry).toEqual(first);
    const levels = await other.inventory.levels({ storeId });
    expect(levels.find((l) => l.skuId === flour)?.onHand).toBe('6.000');
  });

  test('one product of another organisation: nothing is written', async () => {
    const storeId = await makeStore();
    const caller = await managerOf(storeId);
    const err = await errorOf(() =>
      caller.inventory.stocktakeBatch({
        storeId,
        counts: [
          { skuId: fix!.skuIds[0], target: '1' },
          { skuId: crypto.randomUUID(), target: '1' },
        ],
      }),
    );
    expect(err?.code).toBe('NOT_FOUND');
    expect(err?.message).toBe('admin.errors.skuNotFound');
    expect(await movementsOf(storeId)).toEqual([]);
  });

  test('a store-level deny of inventory.adjust refuses the batch', async () => {
    const storeId = await makeStore();
    const caller = await managerOf(storeId, ['inventory.adjust']);
    const err = await errorOf(() =>
      caller.inventory.stocktakeBatch({
        storeId,
        counts: [{ skuId: fix!.skuIds[0], target: '1' }],
      }),
    );
    expect(err?.code).toBe('FORBIDDEN');
    expect(err?.message).toBe('inventory.errors.cannotAdjust');
  });

  test('a product twice, or a bad count, is refused', async () => {
    const storeId = await makeStore();
    const caller = await managerOf(storeId);
    const [flour, rice] = fix!.skuIds;
    const twice = await errorOf(() =>
      caller.inventory.stocktakeBatch({
        storeId,
        counts: [
          { skuId: flour, target: '1' },
          { skuId: flour, target: '2' },
        ],
      }),
    );
    expect(twice?.code).toBe('BAD_REQUEST');
    const bad = await errorOf(() =>
      caller.inventory.stocktakeBatch({
        storeId,
        counts: [
          { skuId: flour, target: '1' },
          { skuId: rice, target: '-1' },
        ],
      }),
    );
    expect(bad?.code).toBe('BAD_REQUEST');
    expect(bad?.message).toContain('inventory.errors.countNegative');
    expect(await movementsOf(storeId)).toEqual([]);
  });
});
