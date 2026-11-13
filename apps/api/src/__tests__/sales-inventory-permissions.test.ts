/**
 * 2026-10-21 audit CA-10 / CA-57: sales.record and inventory.adjust no
 * longer fall back to users.manage.
 *
 * The fallback made a store-level deny override of sales.record /
 * inventory.adjust a no-op for managers (who hold users.manage) and
 * let any custom role holding users.manage record sales and post
 * stocktakes. Migration 0048 backfills the built-in role grants so
 * removing the fallback doesn't strand older orgs.
 *
 * The first block is pure (runs everywhere): what migration 0048 grants
 * must still be part of seed-data.ts. The rest is PG-gated (skipped when
 * DATABASE_URL is unset or SKIP_PG_TESTS=1), 0048 itself included: it is
 * run again on roles set up for it (review TEST2-18; the test used to look
 * for words in its SQL).
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { getDb, schema as s } from '@compass/db';
import { SHOULD_RUN } from './helpers/pg';
import { callerFor } from './helpers/ctx';
import { BUILTIN_ROLES } from '@compass/db/seed-data';
import { seedMember, sessionOf } from './helpers/fixtures';
import { errorOf } from './helpers/errors';
import { cleanUpAfterAll, noteOrg } from './helpers/cleanup';
import { rerunMigration } from './helpers/migrations';

cleanUpAfterAll();

// ---------- migration 0048 is a narrow backfill ---------------------------

// The three grants seed-data.ts gained after older orgs were provisioned.
// 0048 must backfill exactly these and nothing else, so it can't undo a
// permission an org admin deliberately removed from a built-in role.
const BACKFILL = [
  ['manager', 'sales.record'],
  ['manager', 'inventory.adjust'],
  ['staff', 'sales.record'],
] as const;

describe('CA-10 migration 0048 backfills the missing built-in grants only', () => {
  test('each backfilled grant is still part of the seed definition', () => {
    for (const [slug, key] of BACKFILL) {
      const role = BUILTIN_ROLES.find((r) => r.slug === slug);
      expect(role?.permissions).toContain(key);
    }
  });

  test.skipIf(!SHOULD_RUN)(
    'run on an older org: the three grants, built-in roles only, nothing removed, twice',
    async () => {
      const db = getDb(undefined, { system: 'maintenance' });
      const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
      const role = async (orgId: string, slug: string, isBuiltIn: boolean, keys: string[]) => {
        const [made] = await db
          .insert(s.roles)
          .values({ orgId, slug, name: slug, rank: 20, isBuiltIn })
          .returning();
        for (const permissionKey of keys) {
          await db.insert(s.rolePermissions).values({ roleId: made!.id, permissionKey });
        }
        return made!.id;
      };
      const org = async (tag: string) => {
        const [made] = await db
          .insert(s.organizations)
          .values({ slug: `ca10-${tag}-${suffix}`, name: 'CA-10 backfill', localeDefault: 'en' })
          .returning();
        noteOrg(made!.id);
        return made!.id;
      };
      await db
        .insert(s.permissions)
        .values({ key: 'users.manage', description: 'users.manage' })
        .onConflictDoNothing();
      // An org from before the grants, whose admin had also taken
      // everything else but users.manage from its managers, and one whose
      // "staff" is a role of its own, not the built-in one.
      const older = await org('old');
      const manager = await role(older, 'manager', true, ['users.manage']);
      const staff = await role(older, 'staff', true, []);
      const customStaff = await role(await org('custom'), 'staff', false, []);

      await rerunMigration('0048_backfill_builtin_role_permissions.sql');
      await rerunMigration('0048_backfill_builtin_role_permissions.sql');

      const keysOf = async (roleId: string) =>
        (
          await db
            .select({ key: s.rolePermissions.permissionKey })
            .from(s.rolePermissions)
            .where(eq(s.rolePermissions.roleId, roleId))
        )
          .map((r) => r.key)
          .sort();
      expect(await keysOf(manager)).toEqual(['inventory.adjust', 'sales.record', 'users.manage']);
      expect(await keysOf(staff)).toEqual(['sales.record']);
      expect(await keysOf(customStaff)).toEqual([]);
    },
  );
});

// ---------- PG-gated runtime gates ----------------------------------------

interface Fixture {
  orgId: string;
  managerRoleId: string;
  usersManageOnlyRoleId: string;
  dishId: string;
  skuId: string;
  suffix: string;
}

let fix: Fixture | null = null;

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

  const [org] = await db
    .insert(s.organizations)
    .values({
      slug: `ca10-${suffix}`,
      name: 'CA-10 sales/inventory gates',
      localeDefault: 'en',
      timezone: 'UTC',
    })
    .returning();
  noteOrg(org!.id);

  for (const key of ['users.manage', 'sales.record', 'inventory.adjust']) {
    await db.insert(s.permissions).values({ key, description: key }).onConflictDoNothing();
  }

  // The built-in manager as migration 0048 leaves it.
  const manager = BUILTIN_ROLES.find((r) => r.slug === 'manager')!;
  const [managerRole] = await db
    .insert(s.roles)
    .values({ orgId: org!.id, slug: 'manager', name: 'Manager', rank: 60, isBuiltIn: true })
    .returning();
  for (const key of manager.permissions) {
    await db.insert(s.permissions).values({ key, description: key }).onConflictDoNothing();
    await db
      .insert(s.rolePermissions)
      .values({ roleId: managerRole!.id, permissionKey: key })
      .onConflictDoNothing();
  }

  // A custom role that can manage people but was never given sales or
  // inventory authority. Pre-CA-10 the fallback let it do both.
  const [customRole] = await db
    .insert(s.roles)
    .values({ orgId: org!.id, slug: `people-${suffix}`, name: 'People lead', rank: 50 })
    .returning();
  await db
    .insert(s.rolePermissions)
    .values({ roleId: customRole!.id, permissionKey: 'users.manage' });

  const [sku] = await db
    .insert(s.skus)
    .values({
      orgId: org!.id,
      code: `CA10-${suffix.slice(-8)}`,
      names: { en: 'Flour' },
      unit: 'kg',
    })
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
    managerRoleId: managerRole!.id,
    usersManageOnlyRoleId: customRole!.id,
    dishId: dish!.id,
    skuId: sku!.id,
    suffix,
  };
});

async function makeStore(name: string): Promise<string> {
  const db = getDb(undefined, { system: 'maintenance' });
  const [store] = await db.insert(s.stores).values({ orgId: fix!.orgId, name }).returning();
  return store!.id;
}

/** A member holding `roleId` scoped to `storeId`, plus a caller for them. */
async function memberCaller(
  roleId: string,
  storeId: string,
  denies: string[] = [],
  idempotencyKey: string | null = null,
) {
  const db = getDb(undefined, { system: 'maintenance' });
  const who = await seedMember(db, fix!.orgId, { name: 'CA10', roles: [{ roleId, storeId }] });
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

describe.skipIf(!SHOULD_RUN)('CA-10 sales.record has no users.manage fallback', () => {
  test('built-in manager records a sale at their store', async () => {
    const storeId = await makeStore(`CA10-sale-ok-${Math.random()}`);
    const caller = await memberCaller(fix!.managerRoleId, storeId);
    const res = await caller.sales.record({ storeId, dishId: fix!.dishId, qty: '2' });
    expect(res.saleId).toBeTruthy();
    expect(res.deducted).toEqual([{ skuId: fix!.skuId, qty: '0.500' }]);
  });

  test('a store-level deny of sales.record blocks the manager', async () => {
    const storeId = await makeStore(`CA10-sale-deny-${Math.random()}`);
    const caller = await memberCaller(fix!.managerRoleId, storeId, ['sales.record']);
    const err = await errorOf(() =>
      caller.sales.record({ storeId, dishId: fix!.dishId, qty: '1' }),
    );
    expect(err?.code).toBe('FORBIDDEN');
    expect(err?.message).toBe('sales.errors.cannotRecord');
  });

  test('a custom role with only users.manage cannot record sales', async () => {
    const storeId = await makeStore(`CA10-sale-um-${Math.random()}`);
    const caller = await memberCaller(fix!.usersManageOnlyRoleId, storeId);
    const err = await errorOf(() =>
      caller.sales.record({ storeId, dishId: fix!.dishId, qty: '1' }),
    );
    expect(err?.code).toBe('FORBIDDEN');
    expect(err?.message).toBe('sales.errors.cannotRecord');
  });

  test('sales are rejected for an archived store', async () => {
    const storeId = await makeStore(`CA10-sale-archived-${Math.random()}`);
    const caller = await memberCaller(fix!.managerRoleId, storeId);
    const db = getDb(undefined, { system: 'maintenance' });
    await db.update(s.stores).set({ isActive: false }).where(eq(s.stores.id, storeId));
    const err = await errorOf(() =>
      caller.sales.record({ storeId, dishId: fix!.dishId, qty: '1' }),
    );
    expect(err?.code).toBe('PRECONDITION_FAILED');
    expect(err?.message).toBe('auth.errors.storeArchived');
  });
});

describe.skipIf(!SHOULD_RUN)('CA-10 inventory.adjust has no users.manage fallback', () => {
  test('built-in manager can stocktake their store', async () => {
    const storeId = await makeStore(`CA10-st-ok-${Math.random()}`);
    const caller = await memberCaller(fix!.managerRoleId, storeId);
    const err = await errorOf(() =>
      caller.inventory.stocktake({ storeId, skuId: fix!.skuId, target: '3' }),
    );
    expect(err).toBeNull();

    // The stocktake wrote a movement; levels must read it back (it threw
    // on the raw timestamp string for every store that had stock).
    const levels = await caller.inventory.levels({ storeId });
    const row = levels.find((l) => l.skuId === fix!.skuId);
    expect(row?.onHand).toBe('3.000');
    expect(Number.isNaN(Date.parse(row!.lastMovementAt))).toBe(false);
  });

  test('a store-level deny of inventory.adjust blocks the manager', async () => {
    const storeId = await makeStore(`CA10-st-deny-${Math.random()}`);
    const caller = await memberCaller(fix!.managerRoleId, storeId, ['inventory.adjust']);
    const err = await errorOf(() =>
      caller.inventory.stocktake({ storeId, skuId: fix!.skuId, target: '3' }),
    );
    expect(err?.code).toBe('FORBIDDEN');
    expect(err?.message).toBe('inventory.errors.cannotAdjust');
  });

  test('a custom role with only users.manage cannot stocktake', async () => {
    const storeId = await makeStore(`CA10-st-um-${Math.random()}`);
    const caller = await memberCaller(fix!.usersManageOnlyRoleId, storeId);
    const err = await errorOf(() =>
      caller.inventory.stocktake({ storeId, skuId: fix!.skuId, target: '3' }),
    );
    expect(err?.code).toBe('FORBIDDEN');
    expect(err?.message).toBe('inventory.errors.cannotAdjust');
  });
});

describe.skipIf(!SHOULD_RUN)('DX-INV-1 / DX-INV-2 stocktake counts', () => {
  test('each bad count is refused with its own reason', async () => {
    const storeId = await makeStore(`DX-INV1-${Math.random()}`);
    const caller = await memberCaller(fix!.managerRoleId, storeId);
    const cases: Array<[string, string]> = [
      ['', 'inventory.errors.countRequired'],
      ['-3', 'inventory.errors.countNegative'],
      ['abc', 'inventory.errors.countNotNumber'],
      ['20.0001', 'inventory.errors.countDecimals'],
      ['100000000', 'inventory.errors.countTooLarge'],
    ];
    for (const [target, key] of cases) {
      const err = await errorOf(() =>
        caller.inventory.stocktake({ storeId, skuId: fix!.skuId, target }),
      );
      expect(err?.code).toBe('BAD_REQUEST');
      expect(err?.message).toContain(key);
    }
  });

  test('a retried count with the same key is not posted twice', async () => {
    const storeId = await makeStore(`DX-INV2-${Math.random()}`);
    const key = `dx-inv2-${Date.now()}-${Math.random()}`;
    const counter = await memberCaller(fix!.managerRoleId, storeId, [], key);
    const first = await counter.inventory.stocktake({ storeId, skuId: fix!.skuId, target: '5' });
    expect(first.skipped).toBe(false);
    // A sale moves the stock between the first post and its retry.
    const seller = await memberCaller(fix!.managerRoleId, storeId);
    await seller.sales.record({ storeId, dishId: fix!.dishId, qty: '2' });
    const retry = await counter.inventory.stocktake({ storeId, skuId: fix!.skuId, target: '5' });
    expect(retry).toEqual(first);
    const levels = await seller.inventory.levels({ storeId });
    // 5 counted, then 2 × 0.25 sold; the retry did not re-count to 5.
    expect(levels.find((l) => l.skuId === fix!.skuId)?.onHand).toBe('4.500');
  });
});

describe.skipIf(!SHOULD_RUN)('DX-SAL-1 a sale that drives stock below zero', () => {
  test('is kept, and names the ingredients now below zero', async () => {
    const storeId = await makeStore(`DX-SAL1-${Math.random()}`);
    const caller = await memberCaller(fix!.managerRoleId, storeId);
    const res = await caller.sales.record({ storeId, dishId: fix!.dishId, qty: '2' });
    expect(res.saleId).toBeTruthy();
    expect(res.negativeStock).toEqual([
      { skuId: fix!.skuId, names: { en: 'Flour' }, onHand: '-0.500' },
    ]);

    await caller.inventory.stocktake({ storeId, skuId: fix!.skuId, target: '10' });
    const covered = await caller.sales.record({ storeId, dishId: fix!.dishId, qty: '1' });
    expect(covered.negativeStock).toEqual([]);
  });
});
