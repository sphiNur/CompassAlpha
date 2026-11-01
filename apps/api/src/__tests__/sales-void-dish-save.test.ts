/**
 * 2026-10-21 follow-ups: `sales.void` (migration 0049) and the atomic
 * `dishes.save` (CA-55).
 *
 * The first blocks are pure (run everywhere). The rest is PG-gated like
 * sales-inventory-permissions.test.ts (skipped when DATABASE_URL is unset
 * or SKIP_PG_TESTS=1).
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, schema as s, withOrgContext } from '@compass/db';
import { logger } from '../infra/log';
import { appRouter } from '../trpc/router';
import { loadSession, type RequestContext, type SessionContext } from '../trpc/context';
import { buildSaleReversal, SALE_VOID_REASON, SALE_VOID_SOURCE_TYPE } from '../trpc/routers/sales';
import { duplicateIngredientSkuIds } from '../trpc/routers/dishes';

const HERE = dirname(fileURLToPath(import.meta.url));

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

describe('migration 0049 is additive', () => {
  const sql = readFileSync(
    resolve(HERE, '../../../../packages/db/migrations/0049_sales_void.sql'),
    'utf8',
  );
  test('adds the three void columns and nothing destructive', () => {
    for (const col of ['voided_at', 'voided_by_member_id', 'void_reason']) {
      expect(sql).toContain(`"${col}"`);
    }
    expect(sql).not.toMatch(/\b(DROP|DELETE|TRUNCATE)\b/i);
  });
});

// ---------- PG-gated ------------------------------------------------------

(function loadEnv() {
  let dir = HERE;
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate) && existsSync(resolve(dir, 'pnpm-workspace.yaml'))) {
      for (const raw of readFileSync(candidate, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const idx = line.indexOf('=');
        if (idx < 0) continue;
        const key = line.slice(0, idx).trim();
        const val = line
          .slice(idx + 1)
          .trim()
          .replace(/^"(.*)"$/, '$1');
        if (!(key in process.env)) process.env[key] = val;
      }
      return;
    }
    dir = resolve(dir, '..');
  }
})();

const SHOULD_RUN = !!process.env.DATABASE_URL && process.env.SKIP_PG_TESTS !== '1';

function buildCtx(db: ReturnType<typeof getDb>, session: SessionContext): RequestContext {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hono: {} as any,
    db,
    log: logger,
    traceId: `test-${Date.now()}`,
    ip: null,
    userAgent: null,
    idempotencyKey: null,
    session,
    async withOrg(fn, options) {
      return withOrgContext(db, session.orgId, fn, options);
    },
  };
}

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
  const [dishesRole] = await db
    .insert(s.roles)
    .values({ orgId: org!.id, slug: `menu-${suffix}`, name: 'Menu', rank: 50 })
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

async function memberCaller(roleId: string, storeId: string) {
  const db = getDb(undefined, { system: 'maintenance' });
  const tgUserId = BigInt(`${fix!.suffix}${Math.floor(Math.random() * 1e6)}`.slice(-12));
  const [user] = await db.insert(s.users).values({ displayName: 'Void', tgUserId }).returning();
  const [member] = await db
    .insert(s.members)
    .values({ orgId: fix!.orgId, userId: user!.id, status: 'active' })
    .returning();
  await db
    .insert(s.memberRoleBindings)
    .values({ memberId: member!.id, roleId, scopeType: 'store', scopeId: storeId });
  const session = await loadSession(db, user!.id, fix!.orgId, member!.id);
  if (!session) throw new Error('session failed to load');
  return appRouter.createCaller(buildCtx(db, session));
}

async function onHand(storeId: string, skuId: string): Promise<number> {
  const db = getDb(undefined, { system: 'maintenance' });
  const rows = await db
    .select({ delta: s.inventoryMovements.delta })
    .from(s.inventoryMovements)
    .where(and(eq(s.inventoryMovements.storeId, storeId), eq(s.inventoryMovements.skuId, skuId)));
  return rows.reduce((sum, r) => sum + Number(r.delta), 0);
}

async function errorOf(
  fn: () => Promise<unknown>,
): Promise<{ code?: string; message: string } | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return { code: (err as { code?: string }).code, message: (err as Error).message };
  }
}

describe('sales.void', () => {
  test.skipIf(!SHOULD_RUN)('reverses the consumption and marks the sale voided', async () => {
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

  test.skipIf(!SHOULD_RUN)('a member of another store cannot void', async () => {
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

  test.skipIf(!SHOULD_RUN)('unknown sale → NOT_FOUND', async () => {
    const storeId = await makeStore(`void-404-${Math.random()}`);
    const caller = await memberCaller(fix!.salesRoleId, storeId);
    const err = await errorOf(() =>
      caller.sales.void({ saleId: '00000000-0000-4000-8000-000000000000', reason: 'x' }),
    );
    expect(err?.code).toBe('NOT_FOUND');
  });
});

describe('dishes.save', () => {
  test.skipIf(!SHOULD_RUN)('creates then updates fields and recipe together', async () => {
    const storeId = await makeStore(`dish-${Math.random()}`);
    const caller = await memberCaller(fix!.dishesRoleId, storeId);
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
    expect((dish?.names as Record<string, string>).en).toBe('Soup 2');
    expect(ingredients.filter((i) => i.dishId === created.dishId).map((i) => i.skuId)).toEqual([
      fix!.sku2Id,
    ]);
  });

  test.skipIf(!SHOULD_RUN)('duplicate skuIds are rejected and nothing is written', async () => {
    const storeId = await makeStore(`dish-dup-${Math.random()}`);
    const caller = await memberCaller(fix!.dishesRoleId, storeId);
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
    expect((dishes.find((d) => d.id === fix!.dishId)?.names as Record<string, string>).en).toBe(
      'Bread',
    );
  });
});

describe('DX-DSH-1 an archived product in a recipe', () => {
  test.skipIf(!SHOULD_RUN)('is refused on save instead of being kept silently', async () => {
    const storeId = await makeStore(`dish-archived-${Math.random()}`);
    const caller = await memberCaller(fix!.dishesRoleId, storeId);
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
