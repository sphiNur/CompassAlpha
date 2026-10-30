/**
 * Role guards (2026-10-30 operation atlas: ADM-4, ADM-5). Before the fix:
 *   - an admin could put keys they do not hold (system.impersonate,
 *     run.amend, …) into a new or existing role and grant it;
 *   - a manager could make a role above their own rank the store default,
 *     which later invitees then received.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/role-guards.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { getDb, schema as s, withOrgContext } from '@compass/db';
import { logger } from '../infra/log';
import { appRouter } from '../trpc/router';
import { loadSession, type RequestContext, type SessionContext } from '../trpc/context';
import { eq } from 'drizzle-orm';

const HERE = dirname(fileURLToPath(import.meta.url));
type SeedData = {
  BUILTIN_ROLES: readonly { slug: string; rank: number; permissions: readonly string[] }[];
};
const seedDataPath = resolve(HERE, '../../../../packages/db/src/seed-data.ts');
const { BUILTIN_ROLES } = (await import(seedDataPath)) as SeedData;

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

type Caller = ReturnType<typeof appRouter.createCaller>;
let fix: { db: ReturnType<typeof getDb>; storeId: string; orgId: string; admin: Caller; manager: Caller; owner: Caller; roleIds: Record<string, string> } | null = null;

async function errorOf(fn: () => Promise<unknown>): Promise<{ code?: string; message: string } | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return { code: (err as { code?: string }).code, message: (err as Error).message };
  }
}

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug: `roles-${suffix}`, name: 'Role guards', localeDefault: 'en', timezone: 'UTC' })
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
      await db.insert(s.rolePermissions).values({ roleId: role!.id, permissionKey: key }).onConflictDoNothing();
    }
  }
  const [store] = await db.insert(s.stores).values({ orgId, name: 'Store', code: `R-${suffix.slice(-6)}` }).returning();
  let n = 0;
  const member = async (slug: string, scope: 'global' | 'store') => {
    n += 1;
    const [u] = await db
      .insert(s.users)
      .values({ displayName: `Roles ${n}`, tgUserId: BigInt(`${suffix}${n}`.slice(-12)) })
      .returning();
    const [m] = await db.insert(s.members).values({ orgId, userId: u!.id, status: 'active' }).returning();
    await db.insert(s.memberStoreAssignments).values({ memberId: m!.id, storeId: store!.id, assignedBy: u!.id });
    await db
      .insert(s.memberRoleBindings)
      .values({ memberId: m!.id, roleId: roleIds[slug]!, scopeType: scope, scopeId: scope === 'store' ? store!.id : null });
    const session = await loadSession(db, u!.id, orgId, m!.id);
    if (!session) throw new Error('session failed to load');
    return appRouter.createCaller(buildCtx(db, session));
  };
  const owner = await member('super_admin', 'global');
  const admin = await member('admin', 'global');
  const manager = await member('manager', 'store');
  fix = { db, storeId: store!.id, orgId, admin, manager, owner, roleIds };
});

describe.skipIf(!SHOULD_RUN)('role guards (PG-gated)', () => {
  test('ADM-4: an admin cannot mint a role with keys they do not hold', async () => {
    const err = await errorOf(() =>
      fix!.admin.admin.roleCreate({ slug: 'amender', name: 'Amender', rank: 70, permissionKeys: ['system.impersonate'] }),
    );
    expect(err?.code).toBe('FORBIDDEN');
    expect(err?.message).toBe('auth.errors.missingPermission');
    expect(
      await errorOf(() =>
        fix!.admin.admin.roleCreate({ slug: 'helper', name: 'Helper', rank: 20, permissionKeys: ['order.draft'] }),
      ),
    ).toBeNull();
  });

  test('ADM-4: nor add such a key to an existing role; keys it already has may stay', async () => {
    const { db, admin, roleIds } = fix!;
    const current = (
      await db
        .select({ key: s.rolePermissions.permissionKey })
        .from(s.rolePermissions)
        .where(eq(s.rolePermissions.roleId, roleIds.manager!))
    ).map((r) => r.key);
    const err = await errorOf(() =>
      admin.admin.roleUpdate({ roleId: roleIds.manager!, permissionKeys: [...current, 'system.impersonate'] }),
    );
    expect(err?.message).toBe('auth.errors.missingPermission');
    expect(await errorOf(() => admin.admin.roleUpdate({ roleId: roleIds.manager!, permissionKeys: current }))).toBeNull();
  });

  test('ADM-22: a built-in role keeps its rank, and says so', async () => {
    const { admin, roleIds } = fix!;
    const err = await errorOf(() => admin.admin.roleUpdate({ roleId: roleIds.manager!, rank: 55 }));
    expect(err?.code).toBe('BAD_REQUEST');
    expect(err?.message).toBe('admin.errors.builtinRankLocked');
  });

  test('ADM-5: a manager cannot make a role at or above their rank the store default', async () => {
    const { manager, storeId } = fix!;
    const err = await errorOf(() => manager.admin.storeUpdate({ storeId, defaultRoleSlug: 'manager' }));
    expect(err?.code).toBe('FORBIDDEN');
    expect(err?.message).toBe('auth.errors.cannotGrantEqualOrHigher');
    expect(await errorOf(() => manager.admin.storeUpdate({ storeId, defaultRoleSlug: 'staff' }))).toBeNull();
  });

  test('ADM-14: a store manager neither sees nor revokes an admin invite for their store', async () => {
    const { owner, manager, storeId } = fix!;
    await owner.admin.memberInviteCreate({ roleSlug: 'admin', storeIds: [storeId] });
    const all = await owner.admin.memberInviteList();
    const adminInvite = all.find((i) => i.roles.some((r) => r.slug === 'admin'));
    expect(adminInvite).toBeTruthy();
    const seen = await manager.admin.memberInviteList();
    expect(seen.some((i) => i.id === adminInvite!.id)).toBe(false);
    const err = await errorOf(() => manager.admin.memberInviteRevoke({ inviteId: adminInvite!.id }));
    expect(err?.code).toBe('FORBIDDEN');
  });

  test('ADM-15: a link whose inviter lost the authority is no longer listed', async () => {
    const { owner, manager, storeId, db, roleIds } = fix!;
    await manager.admin.memberInviteCreate({ roleSlug: 'staff', storeIds: [storeId] });
    const before = await owner.admin.memberInviteList();
    const mine = before.filter((i) => i.roles.some((r) => r.slug === 'staff'));
    expect(mine.length).toBeGreaterThan(0);
    // The manager stops being a manager of the store.
    await db
      .delete(s.memberRoleBindings)
      .where(eq(s.memberRoleBindings.roleId, roleIds.manager!));
    const after = await owner.admin.memberInviteList();
    for (const inv of mine) expect(after.some((i) => i.id === inv.id)).toBe(false);
  });

  test('ADM-16: inviting into an archived store says it is archived', async () => {
    const { owner, db, orgId } = fix!;
    const [gone] = await db
      .insert(s.stores)
      .values({ orgId, name: 'Gone', code: `G-${Date.now().toString().slice(-6)}`, isActive: false })
      .returning();
    const err = await errorOf(() =>
      owner.admin.memberInviteCreate({ roleSlug: 'staff', storeIds: [gone!.id] }),
    );
    expect(err?.message).toBe('auth.errors.storeArchived');
  });

  test('ADM-16: a member also in a store the manager does not run is marked statusOutOfReach', async () => {
    const { owner, db, orgId, storeId, roleIds } = fix!;
    const tag = `${Date.now()}`.slice(-9);
    const [other] = await db
      .insert(s.stores)
      .values({ orgId, name: 'Other', code: `O-${tag.slice(-6)}` })
      .returning();
    const person = async (name: string, n: number) => {
      const [u] = await db
        .insert(s.users)
        .values({ displayName: name, tgUserId: BigInt(`7${tag}${n}`) })
        .returning();
      const [m] = await db.insert(s.members).values({ orgId, userId: u!.id, status: 'active' }).returning();
      return { u: u!, m: m! };
    };
    const boss = await person('ADM16 manager', 1);
    await db.insert(s.memberStoreAssignments).values({ memberId: boss.m.id, storeId, assignedBy: boss.u.id });
    await db
      .insert(s.memberRoleBindings)
      .values({ memberId: boss.m.id, roleId: roleIds.manager!, scopeType: 'store', scopeId: storeId });
    const both = await person('ADM16 both stores', 2);
    const here = await person('ADM16 here only', 3);
    for (const [who, sid] of [[both, storeId], [both, other!.id], [here, storeId]] as const) {
      await db.insert(s.memberStoreAssignments).values({ memberId: who.m.id, storeId: sid, assignedBy: boss.u.id });
      await db
        .insert(s.memberRoleBindings)
        .values({ memberId: who.m.id, roleId: roleIds.staff!, scopeType: 'store', scopeId: sid });
    }
    const session = await loadSession(db, boss.u.id, orgId, boss.m.id);
    const manager = appRouter.createCaller(buildCtx(db, session!));
    const seen = await manager.admin.memberList();
    expect(seen.find((m) => m.memberId === both.m.id)?.statusOutOfReach).toBe(true);
    expect(seen.find((m) => m.memberId === here.m.id)?.statusOutOfReach).toBe(false);
    const full = await owner.admin.memberList();
    expect(full.find((m) => m.memberId === both.m.id)?.statusOutOfReach).toBe(false);
  });
  test('ADM-13: a store manager finds their own suspend in the audit log', async () => {
    const { db, orgId, storeId, roleIds } = fix!;
    const tag = `${Date.now()}`.slice(-9);
    const person = async (name: string, n: number) => {
      const [u] = await db
        .insert(s.users)
        .values({ displayName: name, tgUserId: BigInt(`6${tag}${n}`) })
        .returning();
      const [m] = await db.insert(s.members).values({ orgId, userId: u!.id, status: 'active' }).returning();
      await db.insert(s.memberStoreAssignments).values({ memberId: m!.id, storeId, assignedBy: u!.id });
      return { u: u!, m: m! };
    };
    const boss = await person('ADM13 manager', 1);
    await db
      .insert(s.memberRoleBindings)
      .values({ memberId: boss.m.id, roleId: roleIds.manager!, scopeType: 'store', scopeId: storeId });
    const worker = await person('ADM13 staff', 2);
    await db
      .insert(s.memberRoleBindings)
      .values({ memberId: worker.m.id, roleId: roleIds.staff!, scopeType: 'store', scopeId: storeId });
    const session = await loadSession(db, boss.u.id, orgId, boss.m.id);
    const manager = appRouter.createCaller(buildCtx(db, session!));
    await manager.admin.memberSetStatus({ memberId: worker.m.id, status: 'suspended' });
    const rows = await manager.admin.adminAuditList({ limit: 50 });
    expect(
      rows.some((r) => r.action === 'admin.member.setStatus' && r.resourceId === worker.m.id),
    ).toBe(true);
  });

  test('AUTH-5: recentLogs honours level and kind', async () => {
    const { owner, db, orgId } = fix!;
    await db.insert(s.clientLogs).values([
      { orgId, sessionId: 'auth5', level: 'info', kind: 'nav' },
      { orgId, sessionId: 'auth5', level: 'error', kind: 'crash' },
      { orgId, sessionId: 'auth5', level: 'error', kind: 'net' },
    ]);
    const errors = await owner.system.recentLogs({ limit: 50, level: 'error' });
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.every((r) => r.level === 'error')).toBe(true);
    const crashes = await owner.system.recentLogs({ limit: 50, level: 'error', kind: 'crash' });
    expect(crashes.length).toBeGreaterThanOrEqual(1);
    expect(crashes.every((r) => r.kind === 'crash')).toBe(true);
  });
  test('AUTH-14: switching the primary language to the second one clears the second', async () => {
    const { admin } = fix!;
    await admin.auth.setSecondaryLocale({ secondaryLocale: 'ru' });
    const same = await admin.auth.setLocale({ locale: 'ru' });
    expect(same.user.secondaryLocale).toBeNull();
    await admin.auth.setSecondaryLocale({ secondaryLocale: 'zh' });
    const other = await admin.auth.setLocale({ locale: 'en' });
    expect(other.user.secondaryLocale).toBe('zh');
  });

  test('ADM-23: a transfer must start from a store the member is in', async () => {
    const { owner, db, orgId, storeId, roleIds } = fix!;
    const tag = `${Date.now()}`.slice(-9);
    const [other] = await db
      .insert(s.stores)
      .values({ orgId, name: 'Elsewhere', code: `E-${tag.slice(-6)}` })
      .returning();
    const [u] = await db
      .insert(s.users)
      .values({ displayName: 'ADM23 staff', tgUserId: BigInt(`5${tag}1`) })
      .returning();
    const [m] = await db.insert(s.members).values({ orgId, userId: u!.id, status: 'active' }).returning();
    await db.insert(s.memberStoreAssignments).values({ memberId: m!.id, storeId, assignedBy: u!.id });
    await db
      .insert(s.memberRoleBindings)
      .values({ memberId: m!.id, roleId: roleIds.staff!, scopeType: 'store', scopeId: storeId });
    const wrong = await errorOf(() =>
      owner.admin.memberTransferStore({
        memberId: m!.id,
        fromStoreId: other!.id,
        toStoreId: storeId,
        mirrorRoles: true,
      }),
    );
    expect(wrong?.message).toBe('admin.errors.memberNotInSourceStore');
    await owner.admin.memberTransferStore({
      memberId: m!.id,
      fromStoreId: storeId,
      toStoreId: other!.id,
      mirrorRoles: true,
    });
  });
});

