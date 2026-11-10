/**
 * Organisation-level authority (2026-11-09 full review):
 *   - ADM1-01: an org admin who also kept a legacy store-scoped
 *     super_admin binding was ranked 100 for organisation-wide acts, so
 *     they could grant `admin` globally, suspend, rename or remove a
 *     fellow admin, mint a role of their own tier or set a fellow admin a
 *     global override. Only global bindings count there now.
 *   - ADM1-17: a store manager could revoke a (legacy) low-rank GLOBAL
 *     binding, i.e. take a role away in every store at once.
 *   - ADM1-02: a held custom role could move across ADMIN_RANK, leaving
 *     its bindings in the wrong scope.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/org-authority.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { getDb, schema as s, withOrgContext } from '@compass/db';
import { logger } from '../infra/log';
import { appRouter } from '../trpc/router';
import { loadSession, type RequestContext, type SessionContext } from '../trpc/context';
import { SHOULD_RUN } from './helpers/pg';
import { freshTgId } from './helpers/telegram';

const HERE = dirname(fileURLToPath(import.meta.url));
type SeedData = {
  BUILTIN_ROLES: readonly { slug: string; rank: number; permissions: readonly string[] }[];
};
const { BUILTIN_ROLES } = (await import(
  resolve(HERE, '../../../../packages/db/src/seed-data.ts')
)) as SeedData;

type Db = ReturnType<typeof getDb>;
type Caller = ReturnType<typeof appRouter.createCaller>;

function callerFor(db: Db, session: SessionContext): Caller {
  const ctx: RequestContext = {
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
  return appRouter.createCaller(ctx);
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

interface Person {
  userId: string;
  memberId: string;
  as: Caller;
}

let fix: {
  db: Db;
  orgId: string;
  storeId: string;
  roleIds: Record<string, string>;
  owner: Person;
  legacyAdmin: Person;
  peerAdmin: Person;
  manager: Person;
  staff: Person;
  person: (bindings: Array<{ slug: string; storeId?: string }>) => Promise<Person>;
} | null = null;

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({
      slug: `org-auth-${suffix}`,
      name: 'Org authority',
      localeDefault: 'en',
      timezone: 'UTC',
    })
    .returning();
  const orgId = org!.id;
  const roleIds: Record<string, string> = {};
  for (const slug of ['super_admin', 'admin', 'manager', 'staff']) {
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
  const [store] = await db
    .insert(s.stores)
    .values({ orgId, name: 'Store', code: `OA-${suffix.slice(-6)}` })
    .returning();
  const storeId = store!.id;
  let n = 0;
  // `slug` with a storeId is a store binding; without one, a global one.
  const person = async (bindings: Array<{ slug: string; storeId?: string }>): Promise<Person> => {
    n += 1;
    const [u] = await db
      .insert(s.users)
      .values({ displayName: `Org authority ${n}`, tgUserId: freshTgId() })
      .returning();
    const [m] = await db
      .insert(s.members)
      .values({ orgId, userId: u!.id, status: 'active' })
      .returning();
    await db
      .insert(s.memberStoreAssignments)
      .values({ memberId: m!.id, storeId, assignedBy: u!.id });
    for (const b of bindings) {
      await db.insert(s.memberRoleBindings).values({
        memberId: m!.id,
        roleId: roleIds[b.slug]!,
        scopeType: b.storeId ? 'store' : 'global',
        scopeId: b.storeId ?? null,
      });
    }
    const session = await loadSession(db, u!.id, orgId, m!.id);
    if (!session) throw new Error('session failed to load');
    return { userId: u!.id, memberId: m!.id, as: callerFor(db, session) };
  };
  fix = {
    db,
    orgId,
    storeId,
    roleIds,
    owner: await person([{ slug: 'super_admin' }]),
    // An org admin who also kept a store-scoped super_admin binding
    // from before grantRole refused organisation-tier roles per store.
    legacyAdmin: await person([{ slug: 'admin' }, { slug: 'super_admin', storeId }]),
    peerAdmin: await person([{ slug: 'admin' }]),
    manager: await person([{ slug: 'manager', storeId }]),
    staff: await person([{ slug: 'staff', storeId }]),
    person,
  };
});

describe.skipIf(!SHOULD_RUN)(
  'organisation-level rank counts global bindings only (ADM1-01)',
  () => {
    test('no global grant of a role at the actor’s global rank', async () => {
      const { legacyAdmin, staff } = fix!;
      const err = await errorOf(() =>
        legacyAdmin.as.admin.grantRole({
          userId: staff.userId,
          roleSlug: 'admin',
          scopeType: 'global',
        }),
      );
      expect(err?.code).toBe('FORBIDDEN');
      expect(err?.message).toBe('auth.errors.cannotGrantEqualOrHigher');
    });

    test('no suspending, renaming or removing a fellow admin', async () => {
      const { legacyAdmin, peerAdmin } = fix!;
      for (const act of [
        () =>
          legacyAdmin.as.admin.memberSetStatus({
            memberId: peerAdmin.memberId,
            status: 'suspended',
          }),
        () =>
          legacyAdmin.as.admin.memberSetDisplayName({
            memberId: peerAdmin.memberId,
            displayName: 'Renamed',
          }),
        () => legacyAdmin.as.admin.memberRemove({ memberId: peerAdmin.memberId }),
      ]) {
        const err = await errorOf(act);
        expect(err?.code).toBe('FORBIDDEN');
        expect(err?.message).toBe('auth.errors.cannotRevokeEqualOrHigher');
      }
    });

    test('no role of their own tier, and no global override on a fellow admin', async () => {
      const { legacyAdmin, peerAdmin } = fix!;
      const mint = await errorOf(() =>
        legacyAdmin.as.admin.roleCreate({ slug: 'regional-lead', name: 'Regional lead', rank: 85 }),
      );
      expect(mint?.code).toBe('FORBIDDEN');
      expect(mint?.message).toBe('auth.errors.cannotGrantEqualOrHigher');
      const override = await errorOf(() =>
        legacyAdmin.as.admin.memberPermissionSet({
          memberId: peerAdmin.memberId,
          permissionKey: 'users.manage',
          effect: 'deny',
          scopeType: 'global',
        }),
      );
      expect(override?.code).toBe('FORBIDDEN');
      expect(override?.message).toBe('auth.errors.cannotGrantEqualOrHigher');
    });

    test('below their global rank everything still works', async () => {
      const { legacyAdmin, manager, person, storeId } = fix!;
      const leaving = await person([{ slug: 'staff', storeId }]);
      expect(
        await errorOf(() =>
          legacyAdmin.as.admin.memberSetStatus({ memberId: leaving.memberId, status: 'suspended' }),
        ),
      ).toBeNull();
      expect(
        await errorOf(() =>
          legacyAdmin.as.admin.memberSetDisplayName({
            memberId: manager.memberId,
            displayName: 'Manager renamed',
          }),
        ),
      ).toBeNull();
    });
  },
);

describe.skipIf(!SHOULD_RUN)(
  'a global binding is taken away by an org admin only (ADM1-17)',
  () => {
    test('a store manager cannot revoke a low-rank global binding', async () => {
      const { db, roleIds, manager, owner, person } = fix!;
      // A staff binding left global from before migration 0007.
      const holder = await person([{ slug: 'staff' }]);
      const [binding] = await db
        .select({ id: s.memberRoleBindings.id })
        .from(s.memberRoleBindings)
        .where(
          and(
            eq(s.memberRoleBindings.memberId, holder.memberId),
            eq(s.memberRoleBindings.roleId, roleIds.staff!),
            eq(s.memberRoleBindings.scopeType, 'global'),
          ),
        );
      const err = await errorOf(() => manager.as.admin.revokeRole({ bindingId: binding!.id }));
      expect(err?.code).toBe('FORBIDDEN');
      expect(err?.message).toBe('auth.errors.missingPermission');
      expect(await errorOf(() => owner.as.admin.revokeRole({ bindingId: binding!.id }))).toBeNull();
    });
  },
);

describe.skipIf(!SHOULD_RUN)('a held role keeps its tier (ADM1-02)', () => {
  const createRole = async (slug: string, rank: number): Promise<string> => {
    await fix!.owner.as.admin.roleCreate({ slug, name: slug, rank });
    const role = await fix!.db.query.roles.findFirst({
      where: (r, { and: and2, eq: eq2 }) => and2(eq2(r.orgId, fix!.orgId), eq2(r.slug, slug)),
    });
    return role!.id;
  };

  test('a store role somebody holds cannot move up to the organisation tier', async () => {
    const { owner, staff, storeId } = fix!;
    const roleId = await createRole('shift-lead', 70);
    await owner.as.admin.grantRole({
      userId: staff.userId,
      roleSlug: 'shift-lead',
      scopeType: 'store',
      scopeId: storeId,
    });
    const err = await errorOf(() => owner.as.admin.roleUpdate({ roleId, rank: 90 }));
    expect(err?.code).toBe('PRECONDITION_FAILED');
    expect(err?.message).toBe('admin.errors.rankTierChangeHasBindings');
    // Within its tier the level still moves.
    expect(await errorOf(() => owner.as.admin.roleUpdate({ roleId, rank: 75 }))).toBeNull();
  });

  test('an organisation role somebody holds cannot move down to the store tier', async () => {
    const { owner, manager } = fix!;
    const roleId = await createRole('area-head', 85);
    await owner.as.admin.grantRole({
      userId: manager.userId,
      roleSlug: 'area-head',
      scopeType: 'global',
    });
    const err = await errorOf(() => owner.as.admin.roleUpdate({ roleId, rank: 70 }));
    expect(err?.code).toBe('PRECONDITION_FAILED');
    expect(err?.message).toBe('admin.errors.rankTierChangeHasBindings');
  });

  test('a role nobody holds moves freely', async () => {
    const { owner } = fix!;
    const roleId = await createRole('spare', 70);
    expect(await errorOf(() => owner.as.admin.roleUpdate({ roleId, rank: 90 }))).toBeNull();
    expect(await errorOf(() => owner.as.admin.roleUpdate({ roleId, rank: 60 }))).toBeNull();
  });
});
