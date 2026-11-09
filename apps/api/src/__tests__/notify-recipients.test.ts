/**
 * Who is told (COREAPI-06, 2026-11-09): the people a notification goes to
 * are the people the pages let act. Allow overrides were ignored, so a
 * member who could approve a store's orders only through one never heard
 * that an order was waiting.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/notify-recipients.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, schema as s } from '@compass/db';
import { findRecipientsByPermission, findRecipientsByPermissionInStore } from '../services/notify';

const HERE = dirname(fileURLToPath(import.meta.url));
type SeedData = {
  BUILTIN_ROLES: readonly { slug: string; rank: number; permissions: readonly string[] }[];
};
const { BUILTIN_ROLES } = (await import(
  resolve(HERE, '../../../../packages/db/src/seed-data.ts')
)) as SeedData;

const SHOULD_RUN = !!process.env.DATABASE_URL && process.env.SKIP_PG_TESTS !== '1';
const KEY = 'order.approve';

type Db = ReturnType<typeof getDb>;
type Grant =
  | { role: 'manager' | 'staff'; store: 'A' | 'B' | null }
  | { effect: 'allow' | 'deny'; store: 'A' | 'B' | null; expired?: boolean };

let fix: {
  db: Db;
  orgId: string;
  storeA: string;
  storeB: string;
  person: (grants: Grant[], status?: 'active' | 'suspended') => Promise<string>;
} | null = null;

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug: `notify-${suffix}`, name: 'Notify', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  const orgId = org!.id;
  const roleIds: Record<string, string> = {};
  for (const slug of ['manager', 'staff']) {
    const def = BUILTIN_ROLES.find((r) => r.slug === slug)!;
    const [role] = await db
      .insert(s.roles)
      .values({ orgId, slug, name: slug, rank: def.rank, isBuiltIn: true })
      .returning();
    roleIds[slug] = role!.id;
    for (const key of def.permissions) {
      await db.insert(s.permissions).values({ key, description: key }).onConflictDoNothing();
      await db
        .insert(s.rolePermissions)
        .values({ roleId: role!.id, permissionKey: key })
        .onConflictDoNothing();
    }
  }
  await db.insert(s.permissions).values({ key: KEY, description: KEY }).onConflictDoNothing();
  const [a] = await db
    .insert(s.stores)
    .values({ orgId, name: 'A', code: `NA-${suffix.slice(-6)}` })
    .returning();
  const [b] = await db
    .insert(s.stores)
    .values({ orgId, name: 'B', code: `NB-${suffix.slice(-6)}` })
    .returning();
  const storeOf = (x: 'A' | 'B' | null) => (x === 'A' ? a!.id : x === 'B' ? b!.id : null);
  let n = 0;
  const person = async (grants: Grant[], status: 'active' | 'suspended' = 'active') => {
    n += 1;
    const [u] = await db
      .insert(s.users)
      .values({ displayName: `Notify ${n}`, tgUserId: BigInt(`${suffix}${n}`.slice(-12)) })
      .returning();
    const [m] = await db.insert(s.members).values({ orgId, userId: u!.id, status }).returning();
    for (const g of grants) {
      const scopeId = storeOf(g.store);
      const scopeType = scopeId ? 'store' : 'global';
      if ('role' in g) {
        await db
          .insert(s.memberRoleBindings)
          .values({ memberId: m!.id, roleId: roleIds[g.role]!, scopeType, scopeId });
      } else {
        await db.insert(s.memberPermissionOverrides).values({
          memberId: m!.id,
          permissionKey: KEY,
          effect: g.effect,
          scopeType,
          scopeId,
          expiresAt: g.expired ? new Date(Date.now() - 60_000) : null,
        });
      }
    }
    return u!.id;
  };
  fix = { db, orgId, storeA: a!.id, storeB: b!.id, person };
});

async function heard(userId: string) {
  const { db, orgId, storeA, storeB } = fix!;
  return {
    A: (await findRecipientsByPermissionInStore(db, orgId, KEY, storeA)).includes(userId),
    B: (await findRecipientsByPermissionInStore(db, orgId, KEY, storeB)).includes(userId),
    anywhere: (await findRecipientsByPermission(db, orgId, KEY)).includes(userId),
  };
}

describe.skipIf(!SHOULD_RUN)('notification recipients follow the effective permission', () => {
  test('a role on one store: that store only', async () => {
    const id = await fix!.person([{ role: 'manager', store: 'A' }]);
    expect(await heard(id)).toEqual({ A: true, B: false, anywhere: true });
  });

  test('an allow override alone is enough, everywhere it applies', async () => {
    const global = await fix!.person([
      { role: 'staff', store: 'A' },
      { effect: 'allow', store: null },
    ]);
    expect(await heard(global)).toEqual({ A: true, B: true, anywhere: true });
    const inA = await fix!.person([{ effect: 'allow', store: 'A' }]);
    expect(await heard(inA)).toEqual({ A: true, B: false, anywhere: true });
  });

  test('a deny wins where it applies', async () => {
    const deniedInA = await fix!.person([
      { role: 'manager', store: null },
      { effect: 'deny', store: 'A' },
    ]);
    expect(await heard(deniedInA)).toEqual({ A: false, B: true, anywhere: true });
    const deniedEverywhere = await fix!.person([
      { role: 'manager', store: 'A' },
      { effect: 'deny', store: null },
    ]);
    expect(await heard(deniedEverywhere)).toEqual({ A: false, B: false, anywhere: false });
    const allowedButDeniedInA = await fix!.person([
      { effect: 'allow', store: null },
      { effect: 'deny', store: 'A' },
    ]);
    expect(await heard(allowedButDeniedInA)).toEqual({ A: false, B: true, anywhere: true });
  });

  test('a suspended member or an expired allow hears nothing', async () => {
    const suspended = await fix!.person([{ effect: 'allow', store: null }], 'suspended');
    expect(await heard(suspended)).toEqual({ A: false, B: false, anywhere: false });
    const expired = await fix!.person([{ effect: 'allow', store: null, expired: true }]);
    expect(await heard(expired)).toEqual({ A: false, B: false, anywhere: false });
  });
});
