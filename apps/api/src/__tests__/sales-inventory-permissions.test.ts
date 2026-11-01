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
 * The first block is pure (runs everywhere): migration 0048 must grant
 * every built-in role permission defined in seed-data.ts. The rest is
 * PG-gated like store-scoped-admin.test.ts (skipped when DATABASE_URL is
 * unset or SKIP_PG_TESTS=1).
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { getDb, schema as s, withOrgContext } from '@compass/db';
import { logger } from '../infra/log';
import { appRouter } from '../trpc/router';
import { loadSession, type RequestContext, type SessionContext } from '../trpc/context';

const HERE = dirname(fileURLToPath(import.meta.url));

// seed-data.ts isn't exported from @compass/db and sits outside this
// package's rootDir, so load it at runtime (a non-literal specifier
// keeps tsc from pulling it into the program).
type SeedData = {
  BUILTIN_ROLES: readonly { slug: string; permissions: readonly string[] }[];
};
const seedDataPath = resolve(HERE, '../../../../packages/db/src/seed-data.ts');
const { BUILTIN_ROLES } = (await import(seedDataPath)) as SeedData;

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
  const sql = readFileSync(
    resolve(HERE, '../../../../packages/db/migrations/0048_backfill_builtin_role_permissions.sql'),
    'utf8',
  );

  test('each backfilled grant is still part of the seed definition', () => {
    for (const [slug, key] of BACKFILL) {
      const role = BUILTIN_ROLES.find((r) => r.slug === slug);
      expect(role?.permissions).toContain(key);
    }
  });

  test('grants exactly the backfill pairs', () => {
    const pairs = [...sql.matchAll(/\('([a-z_]+)', '([a-z_.]+)'\)/g)]
      .map((m) => `${m[1]}:${m[2]}`)
      .filter((p) => BUILTIN_ROLES.some((r) => p.startsWith(`${r.slug}:`)));
    expect(pairs.sort()).toEqual(BACKFILL.map(([a, b]) => `${a}:${b}`).sort());
  });

  test('only built-in roles are touched and nothing is removed', () => {
    expect(sql).toContain('r.is_built_in = true');
    expect(sql).not.toMatch(/\bDELETE\b/i);
    expect(sql).toContain('ON CONFLICT DO NOTHING');
  });
});

// ---------- PG-gated runtime gates ----------------------------------------

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

function buildCtx(
  db: ReturnType<typeof getDb>,
  session: SessionContext,
  idempotencyKey: string | null = null,
): RequestContext {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hono: {} as any,
    db,
    log: logger,
    traceId: `test-${Date.now()}`,
    ip: null,
    userAgent: null,
    idempotencyKey,
    session,
    async withOrg(fn, options) {
      return withOrgContext(db, session.orgId, fn, options);
    },
  };
}

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
  const tgUserId = BigInt(`${fix!.suffix}${Math.floor(Math.random() * 1e6)}`.slice(-12));
  const [user] = await db.insert(s.users).values({ displayName: 'CA10', tgUserId }).returning();
  const [member] = await db
    .insert(s.members)
    .values({ orgId: fix!.orgId, userId: user!.id, status: 'active' })
    .returning();
  await db.insert(s.memberRoleBindings).values({
    memberId: member!.id,
    roleId,
    scopeType: 'store',
    scopeId: storeId,
  });
  for (const key of denies) {
    await db.insert(s.memberPermissionOverrides).values({
      memberId: member!.id,
      permissionKey: key,
      effect: 'deny',
      scopeType: 'store',
      scopeId: storeId,
    });
  }
  const session = await loadSession(db, user!.id, fix!.orgId, member!.id);
  if (!session) throw new Error('session failed to load');
  return appRouter.createCaller(buildCtx(db, session, idempotencyKey));
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

describe('CA-10 sales.record has no users.manage fallback', () => {
  test.skipIf(!SHOULD_RUN)('built-in manager records a sale at their store', async () => {
    const storeId = await makeStore(`CA10-sale-ok-${Math.random()}`);
    const caller = await memberCaller(fix!.managerRoleId, storeId);
    const res = await caller.sales.record({ storeId, dishId: fix!.dishId, qty: '2' });
    expect(res.saleId).toBeTruthy();
    expect(res.deducted).toEqual([{ skuId: fix!.skuId, qty: '0.500' }]);
  });

  test.skipIf(!SHOULD_RUN)('a store-level deny of sales.record blocks the manager', async () => {
    const storeId = await makeStore(`CA10-sale-deny-${Math.random()}`);
    const caller = await memberCaller(fix!.managerRoleId, storeId, ['sales.record']);
    const err = await errorOf(() =>
      caller.sales.record({ storeId, dishId: fix!.dishId, qty: '1' }),
    );
    expect(err?.code).toBe('FORBIDDEN');
    expect(err?.message).toBe('sales.errors.cannotRecord');
  });

  test.skipIf(!SHOULD_RUN)('a custom role with only users.manage cannot record sales', async () => {
    const storeId = await makeStore(`CA10-sale-um-${Math.random()}`);
    const caller = await memberCaller(fix!.usersManageOnlyRoleId, storeId);
    const err = await errorOf(() =>
      caller.sales.record({ storeId, dishId: fix!.dishId, qty: '1' }),
    );
    expect(err?.code).toBe('FORBIDDEN');
    expect(err?.message).toBe('sales.errors.cannotRecord');
  });

  test.skipIf(!SHOULD_RUN)('sales are rejected for an archived store', async () => {
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

describe('CA-10 inventory.adjust has no users.manage fallback', () => {
  test.skipIf(!SHOULD_RUN)('built-in manager can stocktake their store', async () => {
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

  test.skipIf(!SHOULD_RUN)(
    'a store-level deny of inventory.adjust blocks the manager',
    async () => {
      const storeId = await makeStore(`CA10-st-deny-${Math.random()}`);
      const caller = await memberCaller(fix!.managerRoleId, storeId, ['inventory.adjust']);
      const err = await errorOf(() =>
        caller.inventory.stocktake({ storeId, skuId: fix!.skuId, target: '3' }),
      );
      expect(err?.code).toBe('FORBIDDEN');
      expect(err?.message).toBe('inventory.errors.cannotAdjust');
    },
  );

  test.skipIf(!SHOULD_RUN)('a custom role with only users.manage cannot stocktake', async () => {
    const storeId = await makeStore(`CA10-st-um-${Math.random()}`);
    const caller = await memberCaller(fix!.usersManageOnlyRoleId, storeId);
    const err = await errorOf(() =>
      caller.inventory.stocktake({ storeId, skuId: fix!.skuId, target: '3' }),
    );
    expect(err?.code).toBe('FORBIDDEN');
    expect(err?.message).toBe('inventory.errors.cannotAdjust');
  });
});

describe('DX-INV-1 / DX-INV-2 stocktake counts', () => {
  test.skipIf(!SHOULD_RUN)('each bad count is refused with its own reason', async () => {
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

  test.skipIf(!SHOULD_RUN)('a retried count with the same key is not posted twice', async () => {
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

describe('DX-SAL-1 a sale that drives stock below zero', () => {
  test.skipIf(!SHOULD_RUN)('is kept, and names the ingredients now below zero', async () => {
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
