/**
 * 2026-10-21 follow-ups: `sales.void` (migration 0049) and the atomic
 * `dishes.save` (CA-55). Also `sales.summary` (review CONF-17), which
 * leaves voided sales out.
 *
 * The first blocks are pure (run everywhere). The rest is PG-gated like
 * sales-inventory-permissions.test.ts (skipped when DATABASE_URL is unset
 * or SKIP_PG_TESTS=1).
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { getDb, schema as s } from '@compass/db';
import { buildSaleReversal, SALE_VOID_REASON, SALE_VOID_SOURCE_TYPE } from '../trpc/routers/sales';
import { duplicateIngredientSkuIds } from '../trpc/routers/dishes';
import { SHOULD_RUN } from './helpers/pg';
import { callerFor } from './helpers/ctx';
import { seedMember, sessionOf } from './helpers/fixtures';
import { errorOf, pgErrorOf } from './helpers/errors';
import { cleanUpAfterAll, noteOrg } from './helpers/cleanup';

cleanUpAfterAll();

// ---------- pure ----------------------------------------------------------

describe('buildSaleReversal', () => {
  test('negates each consumption delta', () => {
    expect(
      buildSaleReversal([
        { skuId: 'a', delta: '-0.500' },
        { skuId: 'b', delta: '-1.250' },
      ]),
    ).toEqual([
      { skuId: 'a', delta: '0.500' },
      { skuId: 'b', delta: '1.250' },
    ]);
  });

  test('sums per SKU without float drift and drops zero nets', () => {
    expect(
      buildSaleReversal([
        { skuId: 'a', delta: '-0.100' },
        { skuId: 'a', delta: '-0.200' },
        { skuId: 'z', delta: '-0.001' },
        { skuId: 'z', delta: '0.001' },
      ]),
    ).toEqual([{ skuId: 'a', delta: '0.300' }]);
  });

  test('no consumption rows → nothing to reverse', () => {
    expect(buildSaleReversal([])).toEqual([]);
  });

  test('reversal rows use their own source_type so the unique index cannot collide', () => {
    expect(SALE_VOID_SOURCE_TYPE).not.toBe('sale');
    expect(SALE_VOID_REASON).toBe('consumption_reversed');
  });
});

describe('duplicateIngredientSkuIds', () => {
  test('lists each repeated skuId once', () => {
    expect(
      duplicateIngredientSkuIds([{ skuId: 'a' }, { skuId: 'b' }, { skuId: 'a' }, { skuId: 'a' }]),
    ).toEqual(['a']);
  });
  test('empty for a clean recipe', () => {
    expect(duplicateIngredientSkuIds([{ skuId: 'a' }, { skuId: 'b' }])).toEqual([]);
  });
});

// ---------- PG-gated ------------------------------------------------------

interface Fixture {
  orgId: string;
  salesRoleId: string;
  dishesRoleId: string;
  dishId: string;
  skuId: string;
  sku2Id: string;
  suffix: string;
}

let fix: Fixture | null = null;

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug: `void-${suffix}`, name: 'Sales void', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  noteOrg(org!.id);
  for (const key of ['sales.record', 'dishes.manage']) {
    await db.insert(s.permissions).values({ key, description: key }).onConflictDoNothing();
  }
  const [salesRole] = await db
    .insert(s.roles)
    .values({ orgId: org!.id, slug: `sales-${suffix}`, name: 'Sales', rank: 20 })
    .returning();
  await db
    .insert(s.rolePermissions)
    .values({ roleId: salesRole!.id, permissionKey: 'sales.record' });
  // dishes.manage counts only when granted organisation-wide (review
  // CONF-04), so the menu role is an org-tier one, bound globally below.
  const [dishesRole] = await db
    .insert(s.roles)
    .values({ orgId: org!.id, slug: `menu-${suffix}`, name: 'Menu', rank: 80 })
    .returning();
  await db
    .insert(s.rolePermissions)
    .values({ roleId: dishesRole!.id, permissionKey: 'dishes.manage' });
  const [sku] = await db
    .insert(s.skus)
    .values({ orgId: org!.id, code: `V1-${suffix.slice(-8)}`, names: { en: 'Flour' }, unit: 'kg' })
    .returning();
  const [sku2] = await db
    .insert(s.skus)
    .values({ orgId: org!.id, code: `V2-${suffix.slice(-8)}`, names: { en: 'Salt' }, unit: 'kg' })
    .returning();
  const [dish] = await db
    .insert(s.dishes)
    .values({ orgId: org!.id, names: { en: 'Bread' }, unitPrice: '10.00' })
    .returning();
  await db
    .insert(s.dishIngredients)
    .values({ dishId: dish!.id, skuId: sku!.id, qtyPerServing: '0.2500' });
  fix = {
    orgId: org!.id,
    salesRoleId: salesRole!.id,
    dishesRoleId: dishesRole!.id,
    dishId: dish!.id,
    skuId: sku!.id,
    sku2Id: sku2!.id,
    suffix,
  };
});

async function makeStore(name: string): Promise<string> {
  const db = getDb(undefined, { system: 'maintenance' });
  const [store] = await db.insert(s.stores).values({ orgId: fix!.orgId, name }).returning();
  return store!.id;
}

/** A member holding `roleId` in one store, or organisation-wide when `storeId` is null. */
async function memberCaller(roleId: string, storeId: string | null) {
  const db = getDb(undefined, { system: 'maintenance' });
  const who = await seedMember(db, fix!.orgId, { name: 'Void', roles: [{ roleId, storeId }] });
  return callerFor(await sessionOf(fix!.orgId, who));
}

async function onHand(storeId: string, skuId: string): Promise<number> {
  const db = getDb(undefined, { system: 'maintenance' });
  const rows = await db
    .select({ delta: s.inventoryMovements.delta })
    .from(s.inventoryMovements)
    .where(and(eq(s.inventoryMovements.storeId, storeId), eq(s.inventoryMovements.skuId, skuId)));
  return rows.reduce((sum, r) => sum + Number(r.delta), 0);
}

describe.skipIf(!SHOULD_RUN)('sales.void', () => {
  test('reverses the consumption and marks the sale voided', async () => {
    const storeId = await makeStore(`void-ok-${Math.random()}`);
    const caller = await memberCaller(fix!.salesRoleId, storeId);
    const { saleId } = await caller.sales.record({ storeId, dishId: fix!.dishId, qty: '2' });
    expect(await onHand(storeId, fix!.skuId)).toBeCloseTo(-0.5, 3);

    const res = await caller.sales.void({ saleId, reason: 'wrong dish' });
    expect(res.alreadyVoided).toBe(false);
    expect(res.reversed).toEqual([{ skuId: fix!.skuId, qty: '0.500' }]);
    expect(await onHand(storeId, fix!.skuId)).toBeCloseTo(0, 3);

    const list = await caller.sales.list({ storeId });
    const row = list.find((r) => r.id === saleId);
    expect(row?.voidedAt).toBeTruthy();
    expect(row?.voidReason).toBe('wrong dish');

    // Re-void is a no-op: no second reversal.
    const again = await caller.sales.void({ saleId, reason: 'again' });
    expect(again.alreadyVoided).toBe(true);
    expect(await onHand(storeId, fix!.skuId)).toBeCloseTo(0, 3);
  });

  test('a member of another store cannot void', async () => {
    const storeA = await makeStore(`void-a-${Math.random()}`);
    const storeB = await makeStore(`void-b-${Math.random()}`);
    const callerA = await memberCaller(fix!.salesRoleId, storeA);
    const callerB = await memberCaller(fix!.salesRoleId, storeB);
    const { saleId } = await callerA.sales.record({
      storeId: storeA,
      dishId: fix!.dishId,
      qty: '1',
    });
    const err = await errorOf(() => callerB.sales.void({ saleId, reason: 'nope' }));
    expect(err?.code).toBe('FORBIDDEN');
  });

  test('unknown sale → NOT_FOUND', async () => {
    const storeId = await makeStore(`void-404-${Math.random()}`);
    const caller = await memberCaller(fix!.salesRoleId, storeId);
    const err = await errorOf(() =>
      caller.sales.void({ saleId: '00000000-0000-4000-8000-000000000000', reason: 'x' }),
    );
    expect(err?.code).toBe('NOT_FOUND');
  });
});

describe.skipIf(!SHOULD_RUN)('migration 0049 on the database', () => {
  // Review TEST2-18: what the migrated table does, not words in the SQL.
  test('a sale stands unvoided until voided; a reason needs a void time', async () => {
    const storeId = await makeStore(`void-0049-${Math.random()}`);
    const caller = await memberCaller(fix!.salesRoleId, storeId);
    const { saleId } = await caller.sales.record({ storeId, dishId: fix!.dishId, qty: '1' });
    const db = getDb(undefined, { system: 'maintenance' });
    const [row] = await db
      .select({ at: s.sales.voidedAt, by: s.sales.voidedByMemberId, reason: s.sales.voidReason })
      .from(s.sales)
      .where(eq(s.sales.id, saleId));
    expect(row).toEqual({ at: null, by: null, reason: null });
    // sales_void_consistency_check: a reason without a time, or a time
    // with an empty reason, is refused.
    for (const half of [{ voidReason: 'wrong dish' }, { voidedAt: new Date(), voidReason: '' }]) {
      const refused = await pgErrorOf(() =>
        db.update(s.sales).set(half).where(eq(s.sales.id, saleId)),
      );
      expect(refused).toMatchObject({ code: '23514', constraint: 'sales_void_consistency_check' });
    }
  });
});

describe.skipIf(!SHOULD_RUN)('sales.summary (review CONF-17)', () => {
  test('counts every standing sale of the day, past the list cap', async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    const storeId = await makeStore(`summary-${Math.random()}`);
    await db
      .insert(s.permissions)
      .values({ key: 'prices.view', description: 'prices.view' })
      .onConflictDoNothing();
    const [pricedRole] = await db
      .insert(s.roles)
      .values({ orgId: fix!.orgId, slug: `priced-${fix!.suffix}`, name: 'Priced', rank: 30 })
      .returning();
    await db.insert(s.rolePermissions).values([
      { roleId: pricedRole!.id, permissionKey: 'sales.record' },
      { roleId: pricedRole!.id, permissionKey: 'prices.view' },
    ]);
    const priced = await memberCaller(pricedRole!.id, storeId);
    const unpriced = await memberCaller(fix!.salesRoleId, storeId);
    // 201 servings at 10.00 and half a serving at 3.33: more rows than
    // sales.list returns.
    const sale = { orgId: fix!.orgId, storeId, dishId: fix!.dishId };
    const rows = await db
      .insert(s.sales)
      .values([
        ...Array.from({ length: 201 }, () => ({ ...sale, qty: '1', unitPrice: '10.00' })),
        { ...sale, qty: '0.5', unitPrice: '3.33' },
      ])
      .returning({ id: s.sales.id });
    await priced.sales.void({ saleId: rows[0]!.id, reason: 'wrong dish' });

    expect(await priced.sales.list({ storeId })).toHaveLength(200);
    // 200 servings that stand, plus the half: 200 × 10.00 + 1.67 (1.665
    // rounds half-up, D1).
    expect(await priced.sales.summary({ storeId })).toEqual({
      servings: '200.5',
      revenue: '2001.67',
    });
    // D6: without prices.view in this store there is no revenue.
    expect(await unpriced.sales.summary({ storeId })).toEqual({
      servings: '200.5',
      revenue: null,
    });
  });

  test('a day without sales is zero', async () => {
    const storeId = await makeStore(`summary-empty-${Math.random()}`);
    const caller = await memberCaller(fix!.salesRoleId, storeId);
    expect(await caller.sales.summary({ storeId })).toEqual({ servings: '0', revenue: null });
  });

  test('a member of another store cannot read it', async () => {
    const storeA = await makeStore(`summary-a-${Math.random()}`);
    const storeB = await makeStore(`summary-b-${Math.random()}`);
    const callerB = await memberCaller(fix!.salesRoleId, storeB);
    const err = await errorOf(() => callerB.sales.summary({ storeId: storeA }));
    expect(err?.code).toBe('FORBIDDEN');
  });
});

describe.skipIf(!SHOULD_RUN)('dishes.save', () => {
  test('creates then updates fields and recipe together', async () => {
    const caller = await memberCaller(fix!.dishesRoleId, null);
    const created = await caller.dishes.save({
      names: { en: 'Soup' },
      unitPrice: '5.00',
      ingredients: [{ skuId: fix!.skuId, qtyPerServing: '0.1000' }],
    });
    expect(created.created).toBe(true);
    await caller.dishes.save({
      dishId: created.dishId,
      names: { en: 'Soup 2' },
      unitPrice: '6.00',
      ingredients: [{ skuId: fix!.sku2Id, qtyPerServing: '0.0050' }],
    });
    const { dishes, ingredients } = await caller.dishes.list();
    const dish = dishes.find((d) => d.id === created.dishId);
    expect(dish?.names.en).toBe('Soup 2');
    expect(ingredients.filter((i) => i.dishId === created.dishId).map((i) => i.skuId)).toEqual([
      fix!.sku2Id,
    ]);
  });

  test('duplicate skuIds are rejected and nothing is written', async () => {
    const caller = await memberCaller(fix!.dishesRoleId, null);
    const err = await errorOf(() =>
      caller.dishes.save({
        dishId: fix!.dishId,
        names: { en: 'Changed' },
        ingredients: [
          { skuId: fix!.skuId, qtyPerServing: '1' },
          { skuId: fix!.skuId, qtyPerServing: '2' },
        ],
      }),
    );
    expect(err?.code).toBe('BAD_REQUEST');
    expect(err?.message).toBe('dishes.errors.duplicateIngredient');
    const { dishes } = await caller.dishes.list();
    expect(dishes.find((d) => d.id === fix!.dishId)?.names.en).toBe('Bread');
  });
});

describe.skipIf(!SHOULD_RUN)('dishes.list ingredientCount (CONF-24)', () => {
  test('counts the recipe rows, with or without sending them', async () => {
    const caller = await memberCaller(fix!.dishesRoleId, null);
    const two = await caller.dishes.save({
      names: { en: 'Two parts' },
      ingredients: [
        { skuId: fix!.skuId, qtyPerServing: '0.1000' },
        { skuId: fix!.sku2Id, qtyPerServing: '0.2000' },
      ],
    });
    const none = await caller.dishes.save({ names: { en: 'No recipe' }, ingredients: [] });

    const full = await caller.dishes.list();
    expect(full.dishes.find((d) => d.id === two.dishId)?.ingredientCount).toBe(2);
    expect(full.dishes.find((d) => d.id === none.dishId)?.ingredientCount).toBe(0);
    expect(full.ingredients.filter((i) => i.dishId === two.dishId)).toHaveLength(2);

    const counted = await caller.dishes.list({ withIngredients: false });
    expect(counted.ingredients).toEqual([]);
    expect(counted.dishes.find((d) => d.id === two.dishId)?.ingredientCount).toBe(2);
    expect(counted.dishes.find((d) => d.id === none.dishId)?.ingredientCount).toBe(0);
  });
});

describe.skipIf(!SHOULD_RUN)('DX-DSH-1 an archived product in a recipe', () => {
  test('is refused on save instead of being kept silently', async () => {
    const caller = await memberCaller(fix!.dishesRoleId, null);
    const db = getDb(undefined, { system: 'maintenance' });
    const [gone] = await db
      .insert(s.skus)
      .values({
        orgId: fix!.orgId,
        code: `VA-${Math.random().toString(36).slice(2, 10)}`,
        names: { en: 'Banana' },
        unit: 'kg',
        isArchived: true,
      })
      .returning();
    const created = await caller.dishes.save({
      names: { en: 'Porridge' },
      ingredients: [{ skuId: fix!.skuId, qtyPerServing: '0.1' }],
    });
    const err = await errorOf(() =>
      caller.dishes.save({
        dishId: created.dishId,
        names: { en: 'Porridge' },
        unitPrice: '7.00',
        ingredients: [
          { skuId: fix!.skuId, qtyPerServing: '0.1' },
          { skuId: gone!.id, qtyPerServing: '0.1' },
        ],
      }),
    );
    expect(err?.code).toBe('BAD_REQUEST');
    expect(err?.message).toBe('dishes.errors.archivedIngredient');
    const { ingredients } = await caller.dishes.list();
    expect(ingredients.filter((i) => i.dishId === created.dishId).map((i) => i.skuId)).toEqual([
      fix!.skuId,
    ]);
  });
});
