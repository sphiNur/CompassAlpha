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
import { getDb, schema as s } from '@compass/db';
import { appRouter } from '../trpc/router';
import { eq } from 'drizzle-orm';
import { SHOULD_RUN } from './helpers/pg';
import { callerFor } from './helpers/ctx';
import { BUILTIN_ROLES } from '@compass/db/seed-data';
import { seedFinishedPurchase, seedRoles, seedMember, sessionOf } from './helpers/fixtures';
import { errorOf } from './helpers/errors';
import { cleanUpAfterAll, noteOrg } from './helpers/cleanup';

cleanUpAfterAll();

type Caller = ReturnType<typeof appRouter.createCaller>;
let fix: { db: ReturnType<typeof getDb>; storeId: string; orgId: string; admin: Caller; manager: Caller; owner: Caller; roleIds: Record<string, string> } | null = null;

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug: `roles-${suffix}`, name: 'Role guards', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  noteOrg(org!.id);
  const orgId = org!.id;
  const roleIds = await seedRoles(db, orgId, ['super_admin', 'admin', 'manager', 'staff']);
  const [store] = await db.insert(s.stores).values({ orgId, name: 'Store', code: `R-${suffix.slice(-6)}` }).returning();
  let n = 0;
  const member = async (slug: string, scope: 'global' | 'store') => {
    n += 1;
    const who = await seedMember(db, orgId, {
      name: `Roles ${n}`,
      stores: [store!.id],
      roles: [{ roleId: roleIds[slug]!, storeId: scope === 'store' ? store!.id : null }],
    });
    return callerFor(await sessionOf(orgId, who));
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
    expect(err?.message).toBe('admin.errors.roleKeyNotHeld');
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
    expect(err?.message).toBe('admin.errors.roleKeyNotHeld');
    expect(await errorOf(() => admin.admin.roleUpdate({ roleId: roleIds.manager!, permissionKeys: current }))).toBeNull();
  });

  test('DX-ADM-2: a key held in one store only cannot go into an org-wide role', async () => {
    const { db, orgId, storeId, roleIds, admin } = fix!;
    const tag = `${Date.now()}`.slice(-9);
    // A custom store role carrying run.amend, which the built-in admin lacks.
    const [night] = await db
      .insert(s.roles)
      .values({ orgId, slug: `night-${tag}`, name: 'Night shift', rank: 30 })
      .returning();
    await db.insert(s.rolePermissions).values({ roleId: night!.id, permissionKey: 'run.amend' });
    const who = await seedMember(db, orgId, {
      name: 'DX-ADM-2 admin',
      stores: [storeId],
      roles: [{ roleId: roleIds.admin! }, { roleId: night!.id, storeId }],
    });
    const session = await sessionOf(orgId, who);
    // The flat session set has the key, which is what used to let it through.
    expect(session.permissions.has('run.amend')).toBe(true);
    const kate = callerFor(session);

    const createErr = await errorOf(() =>
      kate.admin.roleCreate({ slug: `amender-${tag}`, name: 'Amender', rank: 70, permissionKeys: ['run.amend'] }),
    );
    expect(createErr?.code).toBe('FORBIDDEN');
    // ADM1-18: the refusal says which key.
    expect(createErr?.message).toBe('admin.errors.roleKeyNotHeld');
    expect((createErr?.cause as { context?: unknown } | undefined)?.context).toEqual({
      permission: 'run.amend',
    });

    const managerKeys = (
      await db
        .select({ key: s.rolePermissions.permissionKey })
        .from(s.rolePermissions)
        .where(eq(s.rolePermissions.roleId, roleIds.manager!))
    ).map((r) => r.key);
    const updateErr = await errorOf(() =>
      kate.admin.roleUpdate({ roleId: roleIds.manager!, permissionKeys: [...managerKeys, 'run.amend'] }),
    );
    expect(updateErr?.code).toBe('FORBIDDEN');
    expect(updateErr?.message).toBe('admin.errors.roleKeyNotHeld');
    const after = await db
      .select({ key: s.rolePermissions.permissionKey })
      .from(s.rolePermissions)
      .where(eq(s.rolePermissions.roleId, roleIds.manager!));
    expect(after.some((r) => r.key === 'run.amend')).toBe(false);

    // Keys held org-wide still go in.
    expect(
      await errorOf(() =>
        kate.admin.roleCreate({ slug: `drafter-${tag}`, name: 'Drafter', rank: 20, permissionKeys: ['order.draft'] }),
      ),
    ).toBeNull();

    // DX-ADM-1: roleList says where each role can be handed on.
    const mine = (await kate.admin.roleList()).find((r) => r.id === night!.id)!;
    expect(mine.passOn.global).toBe(false);
    expect(mine.passOn.storeIds).toContain(storeId);
    const plain = await admin.admin.roleList();
    const theirs = plain.find((r) => r.id === night!.id)!;
    expect(theirs.passOn).toEqual({ global: false, storeIds: [] });
    const builtIn = plain.find((r) => r.id === roleIds.manager!)!;
    expect(builtIn.passOn.global).toBe(true);
    expect(builtIn.passOn.storeIds).toContain(storeId);
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
    const { owner, storeId, db, orgId, roleIds } = fix!;
    // An inviter of its own, so the shared manager keeps their role (review
    // TEST2-09: this used to delete every manager binding in the org).
    const inviter = await seedMember(db, orgId, {
      name: 'ADM15 manager',
      stores: [storeId],
      roles: [{ roleId: roleIds.manager!, storeId }],
    });
    const manager = callerFor(await sessionOf(orgId, inviter));
    await manager.admin.memberInviteCreate({ roleSlug: 'staff', storeIds: [storeId] });
    const theirs = (list: Awaited<ReturnType<Caller['admin']['memberInviteList']>>) =>
      list.filter((i) => i.invitedBy?.userId === inviter.userId);
    expect(theirs(await owner.admin.memberInviteList())).toHaveLength(1);
    // The manager stops being a manager of the store.
    await db
      .delete(s.memberRoleBindings)
      .where(eq(s.memberRoleBindings.id, inviter.bindingIds[0]!));
    expect(theirs(await owner.admin.memberInviteList())).toEqual([]);
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
    // Staff in each of `stores`.
    const staffIn = (name: string, stores: string[]) =>
      seedMember(db, orgId, {
        name,
        stores,
        roles: stores.map((sid) => ({ roleId: roleIds.staff!, storeId: sid })),
      });
    const boss = await seedMember(db, orgId, {
      name: 'ADM16 manager',
      stores: [storeId],
      roles: [{ roleId: roleIds.manager!, storeId }],
    });
    const both = await staffIn('ADM16 both stores', [storeId, other!.id]);
    const here = await staffIn('ADM16 here only', [storeId]);
    const manager = callerFor(await sessionOf(orgId, boss));
    const seen = await manager.admin.memberList();
    expect(seen.find((m) => m.memberId === both.memberId)?.statusOutOfReach).toBe(true);
    expect(seen.find((m) => m.memberId === here.memberId)?.statusOutOfReach).toBe(false);
    const full = await owner.admin.memberList();
    expect(full.find((m) => m.memberId === both.memberId)?.statusOutOfReach).toBe(false);
  });

  test('CMP-ADM-1: the member list gives each role its rank; the manager cannot revoke their own', async () => {
    const { db, orgId, storeId, roleIds } = fix!;
    const who = await seedMember(db, orgId, {
      name: 'ADM1 manager',
      stores: [storeId],
      roles: [{ roleId: roleIds.manager!, storeId }],
    });
    const manager = callerFor(await sessionOf(orgId, who));
    const seen = await manager.admin.memberList();
    const own = seen.find((x) => x.userId === who.userId)!.roles.find((r) => r.slug === 'manager')!;
    expect(own.rank).toBe(BUILTIN_ROLES.find((r) => r.slug === 'manager')!.rank);
    // What the web hides (lib/authority canRevokeRole) is what the server refuses.
    const err = await errorOf(() => manager.admin.revokeRole({ bindingId: own.bindingId }));
    expect(err?.message).toBe('auth.errors.cannotRevokeEqualOrHigher');
  });

  test('CMP-SHL-1: the session carries the person’s own Telegram id', async () => {
    const { manager, db } = fix!;
    const me = await manager.auth.me();
    const [u] = await db.select().from(s.users).where(eq(s.users.id, me.user.id));
    expect(me.user.tgUserId).toBe(String(u!.tgUserId));
  });

  test('ADM-13: a store manager finds their own suspend in the audit log', async () => {
    const { db, orgId, storeId, roleIds } = fix!;
    const person = (name: string, roleId: string) =>
      seedMember(db, orgId, { name, stores: [storeId], roles: [{ roleId, storeId }] });
    const boss = await person('ADM13 manager', roleIds.manager!);
    const worker = await person('ADM13 staff', roleIds.staff!);
    const manager = callerFor(await sessionOf(orgId, boss));
    await manager.admin.memberSetStatus({ memberId: worker.memberId, status: 'suspended' });
    const rows = await manager.admin.adminAuditList({ limit: 50 });
    expect(
      rows.some((r) => r.action === 'admin.member.setStatus' && r.resourceId === worker.memberId),
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
    const who = await seedMember(db, orgId, {
      name: 'ADM23 staff',
      stores: [storeId],
      roles: [{ roleId: roleIds.staff!, storeId }],
    });
    const wrong = await errorOf(() =>
      owner.admin.memberTransferStore({
        memberId: who.memberId,
        fromStoreId: other!.id,
        toStoreId: storeId,
        mirrorRoles: true,
      }),
    );
    expect(wrong?.message).toBe('admin.errors.memberNotInSourceStore');
    await owner.admin.memberTransferStore({
      memberId: who.memberId,
      fromStoreId: storeId,
      toStoreId: other!.id,
      mirrorRoles: true,
    });
  });

  test('CLS-25: a dish save based on an older version is refused, not applied', async () => {
    const { owner } = fix!;
    const { dishId } = await owner.dishes.save({
      code: `V-${Date.now().toString().slice(-6)}`,
      names: { en: 'Versioned' },
      ingredients: [],
    });
    const read = async () =>
      (await owner.dishes.list()).dishes.find((d) => d.id === dishId)!.updatedAt;
    const opened = new Date(await read()).toISOString();
    await owner.dishes.save({
      dishId,
      expectedUpdatedAt: opened,
      names: { en: 'First edit' },
      ingredients: [],
    });
    const stale = await errorOf(() =>
      owner.dishes.save({
        dishId,
        expectedUpdatedAt: opened,
        names: { en: 'Second edit from an old screen' },
        ingredients: [],
      }),
    );
    expect(stale?.message).toBe('dishes.errors.changedElsewhere');
    // Without the field the old behaviour (last write wins) is unchanged.
    await owner.dishes.save({ dishId, names: { en: 'No version' }, ingredients: [] });
  });

  test('HIS-19: reports.view alone opens finance for its own store; neither key is refused', async () => {
    const { db, orgId, storeId, roleIds } = fix!;
    const tag = `${Date.now()}`.slice(-9);
    const [accountant] = await db
      .insert(s.roles)
      .values({ orgId, slug: `acct-${tag}`, name: 'Accountant', rank: 15, isBuiltIn: false })
      .returning();
    await db.insert(s.permissions).values({ key: 'reports.view', description: 'reports.view' }).onConflictDoNothing();
    await db.insert(s.rolePermissions).values({ roleId: accountant!.id, permissionKey: 'reports.view' });
    const person = async (roleId: string, n: number) => {
      const who = await seedMember(db, orgId, {
        name: `HIS19 ${n}`,
        stores: [storeId],
        roles: [{ roleId, storeId }],
      });
      return callerFor(await sessionOf(orgId, who));
    };
    const reader = await person(accountant!.id, 1);
    const range = { startDate: '2026-10-01', endDate: '2026-10-30' };
    await seedFinishedPurchase(db, orgId, {
      runDate: '2026-10-15',
      unitPrice: '1000',
      splits: [{ storeId, qty: '1' }],
    });
    // The store's purchase is counted. Without prices.view the money
    // stays hidden (D6).
    expect(await reader.report.totals(range)).toMatchObject({
      runCount: 1,
      cashLines: 1,
      total: null,
    });
    const stores = await reader.catalog.stores({ permission: 'finance' });
    expect(stores.map((st) => st.id)).toEqual([storeId]);
    const staff = await person(roleIds.staff!, 2);
    const err = await errorOf(() => staff.report.totals(range));
    expect(err?.code).toBe('FORBIDDEN');
  });

  test('SHL-2: the session carries effective permissions per store', async () => {
    const { db, orgId, storeId, roleIds } = fix!;
    const tag = `${Date.now()}`.slice(-9);
    const [other] = await db
      .insert(s.stores)
      .values({ orgId, name: 'Second', code: `S-${tag.slice(-6)}` })
      .returning();
    const who = await seedMember(db, orgId, {
      name: 'SHL2 split',
      stores: [storeId, other!.id],
      roles: [
        { roleId: roleIds.staff!, storeId },
        { roleId: roleIds.manager!, storeId: other!.id },
      ],
    });
    const me = await callerFor(await sessionOf(orgId, who)).auth.me();
    expect(me.storePermissions[storeId]).not.toContain('order.approve');
    expect(me.storePermissions[other!.id]).toContain('order.approve');
    expect(me.permissions).toContain('order.approve');
  });
});

