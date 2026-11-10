/**
 * Session permissions honour per-member overrides (2026-10-30 operation
 * atlas ADM-1/2/3). Run with: DATABASE_URL=… bun test apps/api/src/__tests__/session-overrides.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, schema as s } from '@compass/db';
import { appRouter } from '../trpc/router';
import { loadSession } from '../trpc/context';
import { flatEffectivePermissions } from '../services/storeScope';
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

describe('flatEffectivePermissions', () => {
  const store = (key: string, id: string) => ({ key, scopeType: 'store', scopeId: id });
  const global = (key: string) => ({ key, scopeType: 'global', scopeId: null });

  test('a global deny removes a key granted in a store (ADM-1)', () => {
    const flat = flatEffectivePermissions([store('users.manage', 'A')], [{ ...global('users.manage'), effect: 'deny' }]);
    expect(flat.has('users.manage')).toBe(false);
  });

  test('a deny in one store keeps a key still effective in another (ADM-3)', () => {
    const flat = flatEffectivePermissions(
      [store('users.manage', 'A'), store('users.manage', 'B')],
      [{ ...store('users.manage', 'A'), effect: 'deny' }],
    );
    expect(flat.has('users.manage')).toBe(true);
  });

  test('a deny in the only store that grants it removes it', () => {
    const flat = flatEffectivePermissions([store('users.manage', 'A')], [{ ...store('users.manage', 'A'), effect: 'deny' }]);
    expect(flat.has('users.manage')).toBe(false);
  });

  test('allows add keys globally or in a store (ADM-2)', () => {
    const flat = flatEffectivePermissions([], [
      { ...global('users.manage'), effect: 'allow' },
      { ...store('sales.record', 'B'), effect: 'allow' },
    ]);
    expect([...flat].sort()).toEqual(['sales.record', 'users.manage']);
  });

  test('org.admin only ever comes from a global row', () => {
    expect(flatEffectivePermissions([store('org.admin', 'A')], []).has('org.admin')).toBe(false);
    expect(flatEffectivePermissions([], [{ ...store('org.admin', 'A'), effect: 'allow' }]).has('org.admin')).toBe(false);
    expect(flatEffectivePermissions([global('org.admin')], []).has('org.admin')).toBe(true);
  });

  // Review CONF-04 (2026-11-09): dishes and recipes belong to every store.
  test('dishes.manage only ever comes from a global row', () => {
    const has = (flat: Set<string>) => flat.has('dishes.manage');
    expect(has(flatEffectivePermissions([store('dishes.manage', 'A')], []))).toBe(false);
    expect(has(flatEffectivePermissions([], [{ ...store('dishes.manage', 'A'), effect: 'allow' }]))).toBe(false);
    expect(has(flatEffectivePermissions([], [{ ...global('dishes.manage'), effect: 'allow' }]))).toBe(true);
    // A deny in one store cannot take an org-wide key away there either.
    expect(
      has(flatEffectivePermissions([global('dishes.manage')], [{ ...store('dishes.manage', 'A'), effect: 'deny' }])),
    ).toBe(true);
  });
});

let callers: { denied: ReturnType<typeof appRouter.createCaller>; plain: ReturnType<typeof appRouter.createCaller> } | null = null;

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug: `ovr-${suffix}`, name: 'Session overrides', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  const def = BUILTIN_ROLES.find((r) => r.slug === 'manager')!;
  const [role] = await db
    .insert(s.roles)
    .values({ orgId: org!.id, slug: 'manager', name: 'manager', rank: def.rank, isBuiltIn: true })
    .returning();
  for (const key of def.permissions) {
    await db.insert(s.permissions).values({ key, description: key }).onConflictDoNothing();
    await db.insert(s.rolePermissions).values({ roleId: role!.id, permissionKey: key }).onConflictDoNothing();
  }
  const [store] = await db
    .insert(s.stores)
    .values({ orgId: org!.id, name: 'Store', code: `O-${suffix.slice(-6)}` })
    .returning();
  const make = async (n: number, deny: boolean) => {
    const [user] = await db
      .insert(s.users)
      .values({ displayName: `Mgr ${n}`, tgUserId: freshTgId() })
      .returning();
    const [m] = await db.insert(s.members).values({ orgId: org!.id, userId: user!.id, status: 'active' }).returning();
    await db.insert(s.memberRoleBindings).values({ memberId: m!.id, roleId: role!.id, scopeType: 'store', scopeId: store!.id });
    await db.insert(s.memberStoreAssignments).values({ memberId: m!.id, storeId: store!.id, assignedBy: user!.id });
    if (deny) {
      await db.insert(s.memberPermissionOverrides).values({
        memberId: m!.id,
        permissionKey: 'users.manage',
        effect: 'deny',
        scopeType: 'global',
      });
    }
    const session = await loadSession(db, user!.id, org!.id, m!.id);
    if (!session) throw new Error('session failed to load');
    return callerFor(session);
  };
  callers = { denied: await make(1, true), plain: await make(2, false) };
});

describe.skipIf(!SHOULD_RUN)('session permissions with overrides (PG-gated)', () => {
  test('ADM-1: a manager denied users.manage globally is refused by admin reads', async () => {
    let code: string | undefined;
    try {
      await callers!.denied.admin.memberList();
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('FORBIDDEN');
  });

  test('a manager without the deny still reads them', async () => {
    const list = await callers!.plain.admin.memberList();
    expect(Array.isArray(list) || typeof list === 'object').toBe(true);
  });
});
