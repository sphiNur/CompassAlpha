/**
 * Store-scoped administration: who may invite, grant, revoke, suspend,
 * rename or move a member, and in which stores (M1.1 to M1.2B and the
 * audits since; each describe names its finding). With
 * store-scope-reads.test.ts and run-history-scope.test.ts, split out of
 * store-scoped-admin.test.ts (review TEST2-04, 2026-11).
 *
 * The smokes that ship with deploy.ts run as one org-wide admin in one
 * store, so they never reach these gates. Each is a write-side gate or a
 * denormalized index that's one careless edit away from regression.
 * Smoke catches "the page doesn't blank-screen"; these tests catch "is
 * the gate still locked?"
 *
 * Skipped when DATABASE_URL is unset or SKIP_PG_TESTS=1.
 */
import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { getDb, schema as s } from '@compass/db';
import { appRouter } from '../trpc/router';
import {
  effectivePermissionsForStore,
  getActorStoreIds,
} from '../services/storeScope';
import { SHOULD_RUN } from './helpers/pg';
import { freshTgId } from './helpers/telegram';
import { testContext, callerFor } from './helpers/ctx';
import { codeOf, errorOf, pgErrorOf } from './helpers/errors';
import { scopeOrgSuite } from './helpers/scopeOrg';

const {
  fixture,
  makeStore,
  makeUser,
  makeMember,
  bindRole,
  sessionFor,
  makeSuperAdmin,
} = scopeOrgSuite('Admin Scope Tests');

// ---------- P0: store managers never become organization-wide ----------

describe('P0 store-manager scope', () => {
  test.skipIf(!SHOULD_RUN)(
    'manager of Store A receives only Store A and cannot read Store B orders',
    async () => {
      const fx = fixture();
      const db = getDb(undefined, { system: 'maintenance' });
      const storeA = await makeStore(`ScopeA-${Math.random()}`);
      const storeB = await makeStore(`ScopeB-${Math.random()}`);
      const managerUser = await makeUser('A-Manager-Scope');
      const managerMember = await makeMember(managerUser.id);
      await bindRole(managerMember, fx.managerRoleId, {
        type: 'store',
        storeId: storeA.id,
      });
      const session = await sessionFor(managerMember, managerUser.id);
      const caller = callerFor(session);

      // This is the regression condition: store managers intentionally
      // have users.manage, but that is not organization-wide authority.
      expect(session.permissions.has('users.manage')).toBe(true);
      expect(session.permissions.has('org.admin')).toBe(false);

      const me = await caller.auth.me();
      expect(me.stores.map((store) => store.id)).toEqual([storeA.id]);
      expect(await getActorStoreIds(db, managerMember, session.permissions)).toEqual([storeA.id]);

      // The narrowed manager scope must not regress real org-admin access.
      const orgAdminMe = await appRouter.createCaller(fx.superAdminCtx).auth.me();
      expect(orgAdminMe.stores.map((store) => store.id)).toContain(storeA.id);
      expect(orgAdminMe.stores.map((store) => store.id)).toContain(storeB.id);

      await expect(caller.order.todaySession({ storeId: storeB.id })).rejects.toThrow(
        'notAssignedToStore',
      );
    },
  );

  test.skipIf(!SHOULD_RUN)(
    'manager permissions in Store A do not bleed into a staff binding in Store B',
    async () => {
      const fx = fixture();
      const db = getDb(undefined, { system: 'maintenance' });
      const storeA = await makeStore(`RoleA-${Math.random()}`);
      const storeB = await makeStore(`RoleB-${Math.random()}`);
      const user = await makeUser('Manager-A-Staff-B');
      const memberId = await makeMember(user.id);
      await bindRole(memberId, fx.managerRoleId, { type: 'store', storeId: storeA.id });
      await bindRole(memberId, fx.staffRoleId, { type: 'store', storeId: storeB.id });
      const session = await sessionFor(memberId, user.id);

      // The flat session is intentionally broad for frontend affordances;
      // server-side authorization must resolve role bindings per store.
      expect(session.permissions.has('order.approve')).toBe(true);
      const atStoreA = await effectivePermissionsForStore(
        db,
        memberId,
        storeA.id,
        session.permissions,
      );
      const atStoreB = await effectivePermissionsForStore(
        db,
        memberId,
        storeB.id,
        session.permissions,
      );

      expect(atStoreA.has('order.approve')).toBe(true);
      expect(atStoreA.has('users.manage')).toBe(true);
      expect(atStoreB.has('order.approve')).toBe(false);
      expect(atStoreB.has('users.manage')).toBe(false);
      expect(atStoreB.has('order.draft')).toBe(true);
    },
  );

  test.skipIf(!SHOULD_RUN)(
    'legacy store-scoped organization grants remain store-scoped',
    async () => {
      const fx = fixture();
      const db = getDb(undefined, { system: 'maintenance' });
      const storeA = await makeStore(`LegacyA-${Math.random()}`);
      const storeB = await makeStore(`LegacyB-${Math.random()}`);

      // Simulate historical malformed data: an org-tier role was bound to
      // one store. Neither the HTTP session nor auth.me may turn that into
      // all-store authority.
      const adminUser = await makeUser('Legacy Scoped Admin');
      const adminMember = await makeMember(adminUser.id);
      await bindRole(adminMember, fx.adminRoleId, { type: 'store', storeId: storeA.id });
      const adminSession = await sessionFor(adminMember, adminUser.id);
      expect(adminSession.permissions.has('org.admin')).toBe(false);
      expect(await getActorStoreIds(db, adminMember, new Set(['org.admin']))).toEqual([storeA.id]);
      const adminMe = await callerFor(adminSession).auth.me();
      expect(adminMe.permissions).not.toContain('org.admin');
      expect(adminMe.stores.map((store) => store.id)).toEqual([storeA.id]);

      // A malformed scoped super-admin must not satisfy legacy destructive
      // maintenance gates that still inspect roleSlugs.
      const superUser = await makeUser('Legacy Scoped Super');
      const superMember = await makeMember(superUser.id);
      await bindRole(superMember, fx.superAdminRoleId, { type: 'store', storeId: storeA.id });
      const superSession = await sessionFor(superMember, superUser.id);
      expect(superSession.permissions.has('org.admin')).toBe(false);
      expect(superSession.roleSlugs.has('super_admin')).toBe(false);

      // Simulate a malformed pre-fix store override as well. The resolver
      // must ignore it even if a caller presents a forged flat permission.
      const staffUser = await makeUser('Legacy Scoped Override');
      const staffMember = await makeMember(staffUser.id);
      await bindRole(staffMember, fx.staffRoleId, { type: 'store', storeId: storeA.id });
      await db.insert(s.memberPermissionOverrides).values({
        memberId: staffMember,
        permissionKey: 'org.admin',
        effect: 'allow',
        scopeType: 'store',
        scopeId: storeA.id,
        grantedBy: fx.superAdminUserId,
      });
      const staffSession = await sessionFor(staffMember, staffUser.id);
      expect(staffSession.permissions.has('org.admin')).toBe(false);
      expect(await getActorStoreIds(db, staffMember, new Set(['org.admin']))).toEqual([storeA.id]);
      const effective = await effectivePermissionsForStore(
        db,
        staffMember,
        storeA.id,
        new Set(['org.admin']),
      );
      expect(effective.has('org.admin')).toBe(false);
      const staffMe = await callerFor(staffSession).auth.me();
      expect(staffMe.permissions).not.toContain('org.admin');
      expect(staffMe.stores.map((store) => store.id)).toEqual([storeA.id]);

      // Keep Store B referenced so the setup proves this is a multi-store
      // organization rather than a vacuous single-store assertion.
      expect(storeB.id).not.toBe(storeA.id);
    },
  );

  test.skipIf(!SHOULD_RUN)(
    'rejects new store-scoped organization roles and overrides',
    async () => {
      const fx = fixture();
      const storeA = await makeStore(`RejectA-${Math.random()}`);
      const targetUser = await makeUser('Override Target');
      const targetMember = await makeMember(targetUser.id);
      await bindRole(targetMember, fx.staffRoleId, { type: 'store', storeId: storeA.id });

      // An actual org administrator cannot attach an organization-tier role
      // to a store. This closes the write path for future malformed rows.
      const orgCaller = appRouter.createCaller(fx.superAdminCtx);
      await expect(
        orgCaller.admin.grantRole({
          userId: targetUser.id,
          roleSlug: 'admin',
          scopeType: 'store',
          scopeId: storeA.id,
        }),
      ).rejects.toThrow('orgAdminMustBeGlobal');

      // A store manager cannot create the reserved org.admin override in
      // their store, even for a lower-ranked staff member.
      const managerUser = await makeUser('Scoped Override Manager');
      const managerMember = await makeMember(managerUser.id);
      await bindRole(managerMember, fx.managerRoleId, { type: 'store', storeId: storeA.id });
      const managerCaller = callerFor(await sessionFor(managerMember, managerUser.id));
      await expect(
        managerCaller.admin.memberPermissionSet({
          memberId: targetMember,
          permissionKey: 'org.admin',
          effect: 'allow',
          scopeType: 'store',
          scopeId: storeA.id,
        }),
      ).rejects.toThrow('orgAdminMustBeGlobal');

      // Review CONF-04 (2026-11-09): dishes.manage covers every store's
      // menu, so not even an organisation admin can grant it for one store.
      await expect(
        orgCaller.admin.memberPermissionSet({
          memberId: targetMember,
          permissionKey: 'dishes.manage',
          effect: 'allow',
          scopeType: 'store',
          scopeId: storeA.id,
        }),
      ).rejects.toThrow('orgAdminMustBeGlobal');
    },
  );
});

// ---------- C2: store-scoped admin can only act on their stores ----------

describe('C2 store-scoped admin gates', () => {
  test.skipIf(!SHOULD_RUN)('manager-of-A cannot invite a member into Store B', async () => {
    const fx = fixture();
    const storeA = await makeStore(`A-${Math.random()}`);
    const storeB = await makeStore(`B-${Math.random()}`);
    // make a "store-A admin" — manager scoped to A only.
    const mgrUser = await makeUser('A-Manager');
    const mgrMember = await makeMember(mgrUser.id);
    await bindRole(mgrMember, fx.managerRoleId, { type: 'store', storeId: storeA.id });
    const ctx = testContext(await sessionFor(mgrMember, mgrUser.id));
    const caller = appRouter.createCaller(ctx);
    // Try to invite into Store B → must be FORBIDDEN.
    const targetTg = String(freshTgId());
    await expect(
      caller.admin.memberInviteByTgId({
        tgUserId: targetTg,
        storeIds: [storeB.id],
      }),
    ).rejects.toThrow('notAdminOfStore');
  });

  test.skipIf(!SHOULD_RUN)('manager-of-A cannot grant a role scoped to Store B', async () => {
    const fx = fixture();
    const storeA = await makeStore(`A-${Math.random()}`);
    const storeB = await makeStore(`B-${Math.random()}`);
    const mgrUser = await makeUser('A-Manager');
    const mgrMember = await makeMember(mgrUser.id);
    await bindRole(mgrMember, fx.managerRoleId, { type: 'store', storeId: storeA.id });
    const targetUser = await makeUser('Target');
    await makeMember(targetUser.id);
    const ctx = testContext(await sessionFor(mgrMember, mgrUser.id));
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.admin.grantRole({
        userId: targetUser.id,
        roleSlug: 'staff',
        scopeType: 'store',
        scopeId: storeB.id,
      }),
    ).rejects.toThrow('notAdminOfStore');
  });

  test.skipIf(!SHOULD_RUN)('store-scoped admin cannot invite an org-tier role', async () => {
    const fx = fixture();
    const storeA = await makeStore(`A-${Math.random()}`);
    // A store the manager does not run. The invite counts an admin of every
    // active store as the org's admin, and run alone this suite's org may
    // have no other store yet.
    await makeStore(`B-${Math.random()}`);
    const mgrUser = await makeUser('A-Manager');
    const mgrMember = await makeMember(mgrUser.id);
    await bindRole(mgrMember, fx.managerRoleId, { type: 'store', storeId: storeA.id });
    const ctx = testContext(await sessionFor(mgrMember, mgrUser.id));
    const caller = appRouter.createCaller(ctx);
    // The admin role is org-tier: only an admin of every store may invite
    // into it. (Were storeA the only store, the grant check would refuse
    // next: a store manager holds no global org.admin.)
    expect(
      await errorOf(() =>
        caller.admin.memberInviteByTgId({
          tgUserId: String(freshTgId()),
          roleSlug: 'admin',
          storeIds: [storeA.id],
        }),
      ),
    ).toMatchObject({
      code: 'FORBIDDEN',
      message: 'admin.errors.cannotInviteOrgAdminAsStoreAdmin',
    });
  });
});

// ---------- C1: per-store rank gate --------------------------------------

describe('C1 per-store rank gate', () => {
  test.skipIf(!SHOULD_RUN)(
    'manager-of-A cannot grant a manager-rank role into A (rank tie refused)',
    async () => {
      const fx = fixture();
      const storeA = await makeStore(`A-${Math.random()}`);
      const mgrUser = await makeUser('A-Manager');
      const mgrMember = await makeMember(mgrUser.id);
      await bindRole(mgrMember, fx.managerRoleId, { type: 'store', storeId: storeA.id });
      // The manager role carries users.manage, which lets its holder into
      // grantRole; the rank gate is what must refuse.

      const targetUser = await makeUser('Target');
      await makeMember(targetUser.id);
      const ctx = testContext(await sessionFor(mgrMember, mgrUser.id));
      const caller = appRouter.createCaller(ctx);
      await expect(
        caller.admin.grantRole({
          userId: targetUser.id,
          roleSlug: 'manager', // rank 60, the granter's own
          scopeType: 'store',
          scopeId: storeA.id,
        }),
      ).rejects.toThrow(/cannotGrantEqualOrHigher/);
    },
  );
});

// ---------- D1: memberDetachFromStore atomicity --------------------------

describe('D1 memberDetachFromStore', () => {
  test.skipIf(!SHOULD_RUN)(
    'detach removes MSA + store-scoped bindings + overrides for the target store; preserves OTHER store',
    async () => {
      const fx = fixture();
      const db = getDb(undefined, { system: 'maintenance' });
      const storeA = await makeStore(`A-${Math.random()}`);
      const storeB = await makeStore(`B-${Math.random()}`);
      // Target user belongs to BOTH stores (manager in A, staff in B)
      const targetUser = await makeUser('Multi-Store');
      const targetMember = await makeMember(targetUser.id);
      // Assign both stores via MSA + role bindings.
      await db
        .insert(s.memberStoreAssignments)
        .values({ memberId: targetMember, storeId: storeA.id });
      await db
        .insert(s.memberStoreAssignments)
        .values({ memberId: targetMember, storeId: storeB.id });
      await bindRole(targetMember, fx.managerRoleId, { type: 'store', storeId: storeA.id });
      await bindRole(targetMember, fx.staffRoleId, { type: 'store', storeId: storeB.id });
      // Add a per-store override on Store A so we can prove it gets nuked.
      await db.insert(s.memberPermissionOverrides).values({
        memberId: targetMember,
        permissionKey: 'order.draft',
        effect: 'deny',
        scopeType: 'store',
        scopeId: storeA.id,
      });

      const caller = appRouter.createCaller(fx.superAdminCtx);
      const result = await caller.admin.memberDetachFromStore({
        memberId: targetMember,
        storeId: storeA.id,
      });
      expect(result.ok).toBe(true);
      expect(result.revokedBindings).toBeGreaterThanOrEqual(1);
      expect(result.revokedOverrides).toBeGreaterThanOrEqual(1);

      // Store A: nothing should remain.
      const aMsa = await db
        .select()
        .from(s.memberStoreAssignments)
        .where(
          and(
            eq(s.memberStoreAssignments.memberId, targetMember),
            eq(s.memberStoreAssignments.storeId, storeA.id),
          ),
        );
      expect(aMsa.length).toBe(0);
      const aBinds = await db
        .select()
        .from(s.memberRoleBindings)
        .where(
          and(
            eq(s.memberRoleBindings.memberId, targetMember),
            eq(s.memberRoleBindings.scopeId, storeA.id),
          ),
        );
      expect(aBinds.length).toBe(0);
      const aOver = await db
        .select()
        .from(s.memberPermissionOverrides)
        .where(
          and(
            eq(s.memberPermissionOverrides.memberId, targetMember),
            eq(s.memberPermissionOverrides.scopeId, storeA.id),
          ),
        );
      expect(aOver.length).toBe(0);

      // Store B: untouched.
      const bMsa = await db
        .select()
        .from(s.memberStoreAssignments)
        .where(
          and(
            eq(s.memberStoreAssignments.memberId, targetMember),
            eq(s.memberStoreAssignments.storeId, storeB.id),
          ),
        );
      expect(bMsa.length).toBe(1);
      const bBinds = await db
        .select()
        .from(s.memberRoleBindings)
        .where(
          and(
            eq(s.memberRoleBindings.memberId, targetMember),
            eq(s.memberRoleBindings.scopeId, storeB.id),
          ),
        );
      expect(bBinds.length).toBe(1);
    },
  );
});

// ---------- D2: memberTransferStore --------------------------------------

describe('D2 memberTransferStore', () => {
  test.skipIf(!SHOULD_RUN)(
    'transfer (mirrorRoles=true) moves MSA + mirrors role bindings into target',
    async () => {
      const fx = fixture();
      const storeA = await makeStore(`A-${Math.random()}`);
      const storeB = await makeStore(`B-${Math.random()}`);
      const targetUser = await makeUser('Transferee');
      const targetMember = await makeMember(targetUser.id);
      const db = getDb(undefined, { system: 'maintenance' });
      await db
        .insert(s.memberStoreAssignments)
        .values({ memberId: targetMember, storeId: storeA.id });
      await bindRole(targetMember, fx.staffRoleId, { type: 'store', storeId: storeA.id });

      const caller = appRouter.createCaller(fx.superAdminCtx);
      const result = await caller.admin.memberTransferStore({
        memberId: targetMember,
        fromStoreId: storeA.id,
        toStoreId: storeB.id,
        mirrorRoles: true,
      });
      expect(result.ok).toBe(true);
      expect(result.mirrored).toBe(1);
      expect(result.revokedBindings).toBe(1);

      // Source side gone.
      const aMsa = await db
        .select()
        .from(s.memberStoreAssignments)
        .where(
          and(
            eq(s.memberStoreAssignments.memberId, targetMember),
            eq(s.memberStoreAssignments.storeId, storeA.id),
          ),
        );
      expect(aMsa.length).toBe(0);

      // Target side has the staff binding.
      const bBinds = await db
        .select({
          scopeType: s.memberRoleBindings.scopeType,
          scopeId: s.memberRoleBindings.scopeId,
        })
        .from(s.memberRoleBindings)
        .where(
          and(
            eq(s.memberRoleBindings.memberId, targetMember),
            eq(s.memberRoleBindings.scopeId, storeB.id),
          ),
        );
      expect(bBinds.length).toBe(1);
      expect(bBinds[0]!.scopeType).toBe('store');

      // 2026-10-21: the audit row is scoped to the destination store, and
      // the source store's audit view still lists it (from-side match).
      const auditRows = await db
        .select({ scopeStoreId: s.policyDecisions.scopeStoreId })
        .from(s.policyDecisions)
        .where(
          and(
            eq(s.policyDecisions.action, 'admin.memberTransferStore'),
            eq(s.policyDecisions.resourceId, targetMember),
          ),
        );
      expect(auditRows.map((r) => r.scopeStoreId)).toEqual([storeB.id]);
      const fromSide = await caller.admin.adminAuditList({ storeId: storeA.id, limit: 50 });
      expect(
        fromSide.some(
          (r) => r.action === 'admin.memberTransferStore' && r.resourceId === targetMember,
        ),
      ).toBe(true);
    },
  );

  test.skipIf(!SHOULD_RUN)('transfer same-store BAD_REQUEST', async () => {
    const fx = fixture();
    const storeA = await makeStore(`A-${Math.random()}`);
    const targetUser = await makeUser('Self-Transfer');
    const targetMember = await makeMember(targetUser.id);
    const caller = appRouter.createCaller(fx.superAdminCtx);
    await expect(
      caller.admin.memberTransferStore({
        memberId: targetMember,
        fromStoreId: storeA.id,
        toStoreId: storeA.id,
        mirrorRoles: true,
      }),
    ).rejects.toThrow('transferSameStore');
  });
});

// ---------- D3: per-store default role fall-through ----------------------

describe('D3 per-store default role', () => {
  test.skipIf(!SHOULD_RUN)('invite without roleSlug picks up the store default', async () => {
    const fx = fixture();
    const storeA = await makeStore(`A-${Math.random()}`);
    // Set storeA's default to "staff".
    const caller = appRouter.createCaller(fx.superAdminCtx);
    await caller.admin.storeUpdate({
      storeId: storeA.id,
      defaultRoleSlug: 'staff',
    });
    // Invite a new user with no roleSlug into storeA.
    const tgUserId = String(freshTgId());
    const result = await caller.admin.memberInviteByTgId({
      tgUserId,
      storeIds: [storeA.id],
    });
    // The new member should end up with a store-scoped binding for
    // "staff" in storeA — that's the fall-through.
    const db = getDb(undefined, { system: 'maintenance' });
    const binds = await db
      .select({ roleSlug: s.roles.slug, scopeId: s.memberRoleBindings.scopeId })
      .from(s.memberRoleBindings)
      .innerJoin(s.roles, eq(s.roles.id, s.memberRoleBindings.roleId))
      .where(eq(s.memberRoleBindings.memberId, result.memberId));
    expect(binds.length).toBeGreaterThanOrEqual(1);
    expect(binds.some((b) => b.roleSlug === 'staff' && b.scopeId === storeA.id)).toBe(true);
  });

  test.skipIf(!SHOULD_RUN)('admin-tier role rejected as default', async () => {
    const fx = fixture();
    const storeA = await makeStore(`A-${Math.random()}`);
    const caller = appRouter.createCaller(fx.superAdminCtx);
    await expect(
      caller.admin.storeUpdate({
        storeId: storeA.id,
        defaultRoleSlug: 'admin',
      }),
    ).rejects.toThrow('defaultRoleMustBeStoreTier');
  });
});

// ---------- D4: storeCloneRoles ------------------------------------------

describe('D4 storeCloneRoles', () => {
  test.skipIf(!SHOULD_RUN)(
    'D7 / RE-ADM-2: without members only the default role is copied; with members the bindings, idempotent on re-run',
    async () => {
      const fx = fixture();
      const db = getDb(undefined, { system: 'maintenance' });
      const storeA = await makeStore(`A-${Math.random()}`);
      const storeB = await makeStore(`B-${Math.random()}`);
      const u1 = await makeUser('Staff1');
      const m1 = await makeMember(u1.id);
      const u2 = await makeUser('Staff2');
      const m2 = await makeMember(u2.id);
      await bindRole(m1, fx.staffRoleId, { type: 'store', storeId: storeA.id });
      await bindRole(m2, fx.managerRoleId, { type: 'store', storeId: storeA.id });
      const caller = appRouter.createCaller(fx.superAdminCtx);
      await caller.admin.storeUpdate({ storeId: storeA.id, defaultRoleSlug: 'staff' });

      const structure = await caller.admin.storeCloneRoles({
        sourceStoreId: storeA.id,
        targetStoreId: storeB.id,
        includeMembers: false,
      });
      expect(structure.cloned).toBe(0);
      expect(structure.defaultRoleCopied).toBe(true);
      const bindingsInB = await db
        .select({ id: s.memberRoleBindings.id })
        .from(s.memberRoleBindings)
        .where(eq(s.memberRoleBindings.scopeId, storeB.id));
      expect(bindingsInB.length).toBe(0);
      const [b] = await db.select().from(s.stores).where(eq(s.stores.id, storeB.id));
      expect(b!.defaultRoleId).toBe(fx.staffRoleId);

      const first = await caller.admin.storeCloneRoles({
        sourceStoreId: storeA.id,
        targetStoreId: storeB.id,
        includeMembers: true,
      });
      expect(first.cloned).toBe(2);
      expect(first.skippedExisting).toBe(0);
      // Re-run: should be all skipped.
      const second = await caller.admin.storeCloneRoles({
        sourceStoreId: storeA.id,
        targetStoreId: storeB.id,
        includeMembers: true,
      });
      expect(second.cloned).toBe(0);
      expect(second.skippedExisting).toBe(2);
    },
  );
});

// ---------- D8: granting passes on only keys the actor holds -------------

describe('D8 / RE-ADM-10 grant checks keys, not only rank', () => {
  async function orgAdmin(): Promise<ReturnType<typeof appRouter.createCaller>> {
    const fx = fixture();
    const u = await makeUser('Org Admin D8');
    const m = await makeMember(u.id);
    await bindRole(m, fx.adminRoleId, { type: 'global' });
    return callerFor(await sessionFor(m, u.id));
  }
  async function dangerRole(): Promise<{ id: string; slug: string }> {
    const fx = fixture();
    const db = getDb(undefined, { system: 'maintenance' });
    const slug = `danger-${Math.random().toString(36).slice(2, 8)}`;
    // Rank 70 is below admin (80), so the rank gate alone let an admin grant it.
    const [role] = await db
      .insert(s.roles)
      .values({ orgId: fx.orgId, slug, name: 'Danger', rank: 70 })
      .returning();
    // Admin holds neither key. Super Admin holds run.amend but not
    // attendance.clock, which is switched on per member and is in no
    // built-in role.
    await db.insert(s.rolePermissions).values(
      ['run.amend', 'attendance.clock'].map((permissionKey) => ({
        roleId: role!.id,
        permissionKey,
      })),
    );
    return { id: role!.id, slug };
  }

  test.skipIf(!SHOULD_RUN)('an admin cannot grant a role holding a key they lack', async () => {
    const admin = await orgAdmin();
    const store = await makeStore(`D8-${Math.random()}`);
    const target = await makeUser('D8 target');
    await makeMember(target.id);
    const danger = await dangerRole();
    const err = await errorOf(() =>
      admin.admin.grantRole({
        userId: target.id,
        roleSlug: danger.slug,
        scopeType: 'store',
        scopeId: store.id,
      }),
    );
    expect(err?.message).toBe('auth.errors.cannotGrantMissingPermission');
    // A role whose keys the admin holds still goes through.
    const db = getDb(undefined, { system: 'maintenance' });
    const viewerSlug = `viewer-${Math.random().toString(36).slice(2, 8)}`;
    const [viewer] = await db
      .insert(s.roles)
      .values({ orgId: fixture().orgId, slug: viewerSlug, name: 'Viewer', rank: 10 })
      .returning();
    await db.insert(s.rolePermissions).values({ roleId: viewer!.id, permissionKey: 'prices.view' });
    const ok = await admin.admin.grantRole({
      userId: target.id,
      roleSlug: viewerSlug,
      scopeType: 'store',
      scopeId: store.id,
    });
    expect(ok.granted).toBe(true);
    // Nor can it be a store's default role, given to every newcomer.
    const defaultErr = await errorOf(() =>
      admin.admin.storeUpdate({ storeId: store.id, defaultRoleSlug: danger.slug }),
    );
    expect(defaultErr?.message).toBe('auth.errors.cannotGrantMissingPermission');
  });

  test.skipIf(!SHOULD_RUN)(
    'a built-in role keeps the rank rule alone: a manager can still grant purchaser',
    async () => {
      const fx = fixture();
      const store = await makeStore(`D8b-${Math.random()}`);
      const mu = await makeUser('D8 manager');
      const mm = await makeMember(mu.id);
      await bindRole(mm, fx.managerRoleId, { type: 'store', storeId: store.id });
      const session = await sessionFor(mm, mu.id);
      // The purchaser's run keys are ones a manager does not hold.
      expect(session.permissions.has('run.purchase')).toBe(false);
      const manager = callerFor(session);
      const target = await makeUser('D8 buyer');
      await makeMember(target.id);
      const res = await manager.admin.grantRole({
        userId: target.id,
        roleSlug: 'purchaser',
        scopeType: 'store',
        scopeId: store.id,
      });
      expect(res.granted).toBe(true);
    },
  );

  test.skipIf(!SHOULD_RUN)('the super admin is not limited to their own keys', async () => {
    const fx = fixture();
    const caller = appRouter.createCaller(fx.superAdminCtx);
    const store = await makeStore(`D8s-${Math.random()}`);
    const target = await makeUser('D8 target 2');
    await makeMember(target.id);
    const danger = await dangerRole();
    // Super Admin lacks attendance.clock; exempt anyway.
    expect(fx.superAdminCtx.session?.permissions.has('attendance.clock')).toBe(false);
    const res = await caller.admin.grantRole({
      userId: target.id,
      roleSlug: danger.slug,
      scopeType: 'store',
      scopeId: store.id,
    });
    expect(res.granted).toBe(true);
  });

  test.skipIf(!SHOULD_RUN)('an invite with such a role is refused too', async () => {
    const admin = await orgAdmin();
    const store = await makeStore(`D8i-${Math.random()}`);
    const danger = await dangerRole();
    const err = await errorOf(() =>
      admin.admin.memberInviteByTgId({
        tgUserId: String(freshTgId()),
        roleSlug: danger.slug,
        storeIds: [store.id],
      }),
    );
    expect(err?.message).toBe('auth.errors.cannotGrantMissingPermission');
  });
});

// ---------- RE-ADM-1: one binding per member, role and scope ---------------

describe('RE-ADM-1 role bindings are unique', () => {
  test.skipIf(!SHOULD_RUN)('concurrent invites of the same member write one binding', async () => {
    const fx = fixture();
    const db = getDb(undefined, { system: 'maintenance' });
    const caller = appRouter.createCaller(fx.superAdminCtx);
    const store = await makeStore(`U-${Math.random()}`);
    const u = await makeUser('Invited twice');
    const m = await makeMember(u.id);
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        caller.admin.memberInviteByTgId({
          tgUserId: u.tgUserId.toString(),
          roleSlug: 'staff',
          storeIds: [store.id],
        }),
      ),
    );
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const rows = await db
      .select({ id: s.memberRoleBindings.id })
      .from(s.memberRoleBindings)
      .where(
        and(
          eq(s.memberRoleBindings.memberId, m),
          eq(s.memberRoleBindings.roleId, fx.staffRoleId),
          eq(s.memberRoleBindings.scopeId, store.id),
        ),
      );
    expect(rows.length).toBe(1);
    // A grant of the same binding answers "already there", not an error.
    const again = await caller.admin.grantRole({
      userId: u.id,
      roleSlug: 'staff',
      scopeType: 'store',
      scopeId: store.id,
    });
    expect(again.granted).toBe(false);
    expect(again.bindingId).toBe(rows[0]!.id);
    // The index refuses a raw duplicate, global ones included (NULL scope).
    const duplicate = await pgErrorOf(() =>
      db.insert(s.memberRoleBindings).values({
        memberId: m,
        roleId: fx.staffRoleId,
        scopeType: 'store',
        scopeId: store.id,
      }),
    );
    expect(duplicate).toMatchObject({ code: '23505', constraint: 'mrb_binding_unique' });
    await bindRole(m, fx.managerRoleId, { type: 'global' });
    expect(await pgErrorOf(() => bindRole(m, fx.managerRoleId, { type: 'global' }))).toMatchObject({
      code: '23505',
      constraint: 'mrb_binding_unique',
    });
  });
});

// ---------- R2-ADM-2: archived stores ------------------------------------

describe('R2-ADM-2 bindings in an archived store can be removed', () => {
  test.skipIf(!SHOULD_RUN)('revoke and detach work after the store is archived', async () => {
    const fx = fixture();
    const db = getDb(undefined, { system: 'maintenance' });
    const caller = appRouter.createCaller(fx.superAdminCtx);
    const keep = await makeStore(`Keep-${Math.random()}`);
    const gone = await makeStore(`Gone-${Math.random()}`);
    const u = await makeUser('Leftover');
    const m = await makeMember(u.id);
    await bindRole(m, fx.staffRoleId, { type: 'store', storeId: keep.id });
    await bindRole(m, fx.staffRoleId, { type: 'store', storeId: gone.id });
    await bindRole(m, fx.managerRoleId, { type: 'store', storeId: gone.id });
    await caller.admin.storeDelete({ storeId: gone.id });
    const [staffInGone] = await db
      .select({ id: s.memberRoleBindings.id })
      .from(s.memberRoleBindings)
      .where(
        and(
          eq(s.memberRoleBindings.memberId, m),
          eq(s.memberRoleBindings.roleId, fx.staffRoleId),
          eq(s.memberRoleBindings.scopeId, gone.id),
        ),
      );
    expect((await caller.admin.revokeRole({ bindingId: staffInGone!.id })).revoked).toBe(true);
    const detached = await caller.admin.memberDetachFromStore({ memberId: m, storeId: gone.id });
    expect(detached.revokedBindings).toBe(1);
    const left = await db
      .select({ scopeId: s.memberRoleBindings.scopeId })
      .from(s.memberRoleBindings)
      .where(eq(s.memberRoleBindings.memberId, m));
    expect(left.map((r) => r.scopeId)).toEqual([keep.id]);
  });
});

// ---------- R2-ADM-3: audit keeps names of deleted things ------------------

describe('R2-ADM-3 audit rows keep the names they were written with', () => {
  test.skipIf(!SHOULD_RUN)('a deleted role is still named in its audit rows', async () => {
    const fx = fixture();
    const caller = appRouter.createCaller(fx.superAdminCtx);
    const slug = `gone-${Math.random().toString(36).slice(2, 8)}`;
    const { id } = await caller.admin.roleCreate({ slug, name: 'Vanishing role', rank: 10 });
    await caller.admin.roleUpdate({ roleId: id, name: 'Vanishing role 2' });
    await caller.admin.roleDelete({ roleId: id });
    const rows = (await caller.admin.adminAuditList({ limit: 50 })).filter(
      (r) => r.resourceId === id,
    );
    const byAction = new Map(rows.map((r) => [r.action, r.labels.roleName]));
    expect(byAction.get('admin.role.update')).toBe('Vanishing role 2');
    expect(byAction.get('admin.role.delete')).toBe('Vanishing role 2');
  });
});

// ---------- B1: roleDetail.assignees -------------------------------------

describe('B1 roleDetail assignees', () => {
  test.skipIf(!SHOULD_RUN)(
    'returns assignees with scope_type + storeName for store-scoped bindings',
    async () => {
      const fx = fixture();
      const storeA = await makeStore(`A-${Math.random()}`);
      const u = await makeUser('B1-User');
      const m = await makeMember(u.id);
      await bindRole(m, fx.staffRoleId, { type: 'store', storeId: storeA.id });

      const caller = appRouter.createCaller(fx.superAdminCtx);
      const detail = await caller.admin.roleDetail({ roleSlug: 'staff' });
      const ours = detail.assignees.find((a) => a.memberId === m);
      expect(ours).toBeDefined();
      expect(ours!.scopeType).toBe('store');
      expect(ours!.scopeId).toBe(storeA.id);
      expect(ours!.storeName).toBe(storeA.name);
    },
  );
});

// ---------- B2: admin audit per-store filter -----------------------------

describe('B2 adminAuditList', () => {
  test.skipIf(!SHOULD_RUN)(
    'derives scope_store_id from store-scoped action input + storeId filter narrows',
    async () => {
      const fx = fixture();
      const storeA = await makeStore(`A-${Math.random()}`);
      const storeB = await makeStore(`B-${Math.random()}`);

      // Take any action that auditAdmin captures with a store id —
      // storeUpdate is the cleanest (resourceType='store').
      const caller = appRouter.createCaller(fx.superAdminCtx);
      await caller.admin.storeUpdate({ storeId: storeA.id, name: storeA.name + '-edit1' });
      await caller.admin.storeUpdate({ storeId: storeB.id, name: storeB.name + '-edit1' });

      const filtered = await caller.admin.adminAuditList({ limit: 50, storeId: storeA.id });
      // All returned rows must scope to storeA.
      for (const r of filtered) {
        expect(r.scopeStoreId).toBe(storeA.id);
      }
      // We must have caught at least the edit we just made.
      expect(filtered.some((r) => r.action === 'admin.store.update')).toBe(true);

      // Without the filter we should also see storeB's edit.
      const all = await caller.admin.adminAuditList({ limit: 50 });
      expect(all.some((r) => r.scopeStoreId === storeA.id)).toBe(true);
      expect(all.some((r) => r.scopeStoreId === storeB.id)).toBe(true);
    },
  );
});

// ---------- M3.3: org.admin marker replaces users.manage for org writes -
//
// `requireAdmin` checks users.manage, which manager (rank 60) also holds
// since M1.9. That overload meant a manager could create SKUs,
// suppliers, categories, roles, even delete stores — every org-wide
// catalog mutation gated only on users.manage was reachable. M3.3
// introduces a dedicated `org.admin` permission held only by
// admin + super_admin and migrates 17 mutations to it.
//
// Tests pick one mutation per family (catalog SKU, role catalog, store
// catalog, member-remove). If any of these regress to allow manager,
// the underlying gate at that line broke.

describe('M3.3 manager (rank 60) is blocked from org-wide writes', () => {
  test.skipIf(!SHOULD_RUN)('manager cannot skuCreate (catalog write)', async () => {
    const fx = fixture();
    const storeA = await makeStore(`OrgA-${Math.random()}`);
    const mgrUser = await makeUser('A-Mgr-Catalog');
    const mgrMember = await makeMember(mgrUser.id);
    await bindRole(mgrMember, fx.managerRoleId, { type: 'store', storeId: storeA.id });
    const ctx = testContext(await sessionFor(mgrMember, mgrUser.id));
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.admin.skuCreate({
        names: {
          en: 'Forbidden SKU',
          uz: 'Forbidden SKU',
          ru: 'Forbidden SKU',
          zh: 'Forbidden SKU',
        },
        unit: 'kg',
        // M3.14: step restricted to '0.5' | '1'. The old '0.1' got
        // rejected by zod BEFORE the permission check — failing the
        // test for the wrong reason. Use a valid step so the assertion
        // exercises the permission boundary as intended.
        step: '0.5',
        sortIndex: 999,
      }),
    ).rejects.toThrow('missingPermission');
  });

  test.skipIf(!SHOULD_RUN)('manager cannot roleCreate (role catalog write)', async () => {
    const fx = fixture();
    const storeA = await makeStore(`OrgA-${Math.random()}`);
    const mgrUser = await makeUser('A-Mgr-Role');
    const mgrMember = await makeMember(mgrUser.id);
    await bindRole(mgrMember, fx.managerRoleId, { type: 'store', storeId: storeA.id });
    const ctx = testContext(await sessionFor(mgrMember, mgrUser.id));
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.admin.roleCreate({
        slug: `mgr-attempt-${Date.now()}`,
        name: 'Manager-spawned role',
        rank: 25,
        permissionKeys: [],
      }),
    ).rejects.toThrow('missingPermission');
  });

  test.skipIf(!SHOULD_RUN)('manager cannot supplierCreate (org-wide supplier list)', async () => {
    const fx = fixture();
    const storeA = await makeStore(`OrgA-${Math.random()}`);
    const mgrUser = await makeUser('A-Mgr-Supplier');
    const mgrMember = await makeMember(mgrUser.id);
    await bindRole(mgrMember, fx.managerRoleId, { type: 'store', storeId: storeA.id });
    const ctx = testContext(await sessionFor(mgrMember, mgrUser.id));
    const caller = appRouter.createCaller(ctx);
    await expect(
      caller.admin.supplierCreate({
        name: 'Forbidden Supplier',
      }),
    ).rejects.toThrow('missingPermission');
  });

  test.skipIf(!SHOULD_RUN)(
    'manager-of-A cannot storeUpdate Store B (per-store admin gate)',
    async () => {
      const fx = fixture();
      const storeA = await makeStore(`OrgA-${Math.random()}`);
      const storeB = await makeStore(`OrgB-${Math.random()}`);
      const mgrUser = await makeUser('A-Mgr-StoreEdit');
      const mgrMember = await makeMember(mgrUser.id);
      await bindRole(mgrMember, fx.managerRoleId, { type: 'store', storeId: storeA.id });
      const ctx = testContext(await sessionFor(mgrMember, mgrUser.id));
      const caller = appRouter.createCaller(ctx);

      // Editing OWN store (A) should succeed.
      const own = await caller.admin.storeUpdate({
        storeId: storeA.id,
        name: `Renamed A ${Date.now()}`,
      });
      expect(own.ok).toBe(true);

      // Editing FOREIGN store (B) must throw notAdminOfStore — the C2
      // gate added in M3.3 catches this; pre-M3.3 a manager-of-A could
      // rename Store B since storeUpdate had no per-store check.
      await expect(
        caller.admin.storeUpdate({
          storeId: storeB.id,
          name: 'Hijacked B',
        }),
      ).rejects.toThrow('notAdminOfStore');
    },
  );
});

describe('memberSetStatus is rank- and store-gated', () => {
  async function storeManager(storeId: string) {
    const user = await makeUser('Status-Manager');
    const memberId = await makeMember(user.id);
    await bindRole(memberId, fixture().managerRoleId, { type: 'store', storeId });
    return callerFor(await sessionFor(memberId, user.id));
  }

  async function staffIn(storeIds: string[], roleId = fixture().staffRoleId): Promise<string> {
    const user = await makeUser('Status-Target');
    const memberId = await makeMember(user.id);
    for (const storeId of storeIds) await bindRole(memberId, roleId, { type: 'store', storeId });
    return memberId;
  }

  async function statusOf(memberId: string): Promise<string | undefined> {
    const row = await getDb(undefined, { system: 'maintenance' }).query.members.findFirst({
      where: (m, { eq: eq2 }) => eq2(m.id, memberId),
    });
    return row?.status;
  }

  async function expectForbidden(run: () => Promise<unknown>, memberId: string): Promise<void> {
    expect(await codeOf(run)).toBe('FORBIDDEN');
    expect(await statusOf(memberId)).toBe('active');
  }

  test.skipIf(!SHOULD_RUN)('store manager cannot suspend a super admin', async () => {
    const storeA = await makeStore(`A-${Math.random()}`);
    const caller = await storeManager(storeA.id);
    const target = (await makeSuperAdmin('Status-Super-Admin')).memberId;
    await expectForbidden(
      () => caller.admin.memberSetStatus({ memberId: target, status: 'suspended' }),
      target,
    );
  });

  test.skipIf(!SHOULD_RUN)('store manager cannot suspend staff of another store', async () => {
    const storeA = await makeStore(`A-${Math.random()}`);
    const storeB = await makeStore(`B-${Math.random()}`);
    const caller = await storeManager(storeA.id);
    const target = await staffIn([storeB.id]);
    await expectForbidden(
      () => caller.admin.memberSetStatus({ memberId: target, status: 'suspended' }),
      target,
    );
  });

  test.skipIf(!SHOULD_RUN)(
    'store manager cannot suspend staff who also belong to a store they do not manage',
    async () => {
      const storeA = await makeStore(`A-${Math.random()}`);
      const storeB = await makeStore(`B-${Math.random()}`);
      const caller = await storeManager(storeA.id);
      const target = await staffIn([storeA.id, storeB.id]);
      await expectForbidden(
        () => caller.admin.memberSetStatus({ memberId: target, status: 'suspended' }),
        target,
      );
    },
  );

  test.skipIf(!SHOULD_RUN)('store manager cannot suspend a peer manager', async () => {
    const storeA = await makeStore(`A-${Math.random()}`);
    const caller = await storeManager(storeA.id);
    const target = await staffIn([storeA.id], fixture().managerRoleId);
    await expectForbidden(
      () => caller.admin.memberSetStatus({ memberId: target, status: 'suspended' }),
      target,
    );
  });

  test.skipIf(!SHOULD_RUN)('store manager cannot suspend a member with no store', async () => {
    const storeA = await makeStore(`A-${Math.random()}`);
    const caller = await storeManager(storeA.id);
    const target = await staffIn([]);
    await expectForbidden(
      () => caller.admin.memberSetStatus({ memberId: target, status: 'suspended' }),
      target,
    );
  });

  test.skipIf(!SHOULD_RUN)(
    'store manager can suspend and reactivate lower-ranked staff of their own store, audited',
    async () => {
      const storeA = await makeStore(`A-${Math.random()}`);
      const caller = await storeManager(storeA.id);
      const target = await staffIn([storeA.id]);
      await caller.admin.memberSetStatus({ memberId: target, status: 'suspended' });
      expect(await statusOf(target)).toBe('suspended');
      await caller.admin.memberSetStatus({ memberId: target, status: 'active' });
      expect(await statusOf(target)).toBe('active');
      const audit = await getDb(undefined, { system: 'maintenance' })
        .select({ inputs: s.policyDecisions.inputs })
        .from(s.policyDecisions)
        .where(
          and(
            eq(s.policyDecisions.action, 'admin.member.setStatus'),
            eq(s.policyDecisions.resourceId, target),
          ),
        );
      expect(audit.length).toBe(2);
    },
  );

  test.skipIf(!SHOULD_RUN)('org admin cannot suspend an equal or higher rank', async () => {
    const adminUser = await makeUser('Status-Admin');
    const adminMember = await makeMember(adminUser.id);
    await bindRole(adminMember, fixture().adminRoleId, { type: 'global' });
    const caller = callerFor(await sessionFor(adminMember, adminUser.id));
    const peerUser = await makeUser('Status-Peer-Admin');
    const peer = await makeMember(peerUser.id);
    await bindRole(peer, fixture().adminRoleId, { type: 'global' });
    const superAdmin = await makeSuperAdmin('Status-Higher-Super-Admin');

    for (const target of [superAdmin.memberId, peer]) {
      await expectForbidden(
        () => caller.admin.memberSetStatus({ memberId: target, status: 'suspended' }),
        target,
      );
    }

    const storeA = await makeStore(`A-${Math.random()}`);
    const manager = await staffIn([storeA.id], fixture().managerRoleId);
    await caller.admin.memberSetStatus({ memberId: manager, status: 'suspended' });
    expect(await statusOf(manager)).toBe('suspended');
  });
});

describe('memberPermissionSet cannot mint authority the actor lacks', () => {
  async function callerWith(
    roleId: string,
    scope: { type: 'global' } | { type: 'store'; storeId: string },
  ) {
    const user = await makeUser('Override-Actor');
    const memberId = await makeMember(user.id);
    await bindRole(memberId, roleId, scope);
    return callerFor(await sessionFor(memberId, user.id));
  }

  async function staffTarget(storeId: string): Promise<string> {
    const user = await makeUser('Override-Target');
    const memberId = await makeMember(user.id);
    await bindRole(memberId, fixture().staffRoleId, { type: 'store', storeId });
    return memberId;
  }

  test.skipIf(!SHOULD_RUN)(
    'store manager can allow a key they hold but not one they lack',
    async () => {
      const storeA = await makeStore(`A-${Math.random()}`);
      const manager = await callerWith(fixture().managerRoleId, { type: 'store', storeId: storeA.id });
      const target = await staffTarget(storeA.id);
      const base = {
        memberId: target,
        effect: 'allow' as const,
        scopeType: 'store' as const,
        scopeId: storeA.id,
      };
      expect(
        await codeOf(() =>
          manager.admin.memberPermissionSet({ ...base, permissionKey: 'run.amend' }),
        ),
      ).toBe('FORBIDDEN');
      expect(
        await codeOf(() =>
          manager.admin.memberPermissionSet({ ...base, permissionKey: 'order.approve' }),
        ),
      ).toBeNull();
      // Deny only removes authority, so the rank gate alone covers it.
      expect(
        await codeOf(() =>
          manager.admin.memberPermissionSet({
            ...base,
            effect: 'deny',
            permissionKey: 'run.amend',
          }),
        ),
      ).toBeNull();
    },
  );

  test.skipIf(!SHOULD_RUN)(
    'admin cannot hand out org.admin or a super-admin-only key; super admin can',
    async () => {
      const storeA = await makeStore(`A-${Math.random()}`);
      const admin = await callerWith(fixture().adminRoleId, { type: 'global' });
      const target = await staffTarget(storeA.id);
      const base = { memberId: target, effect: 'allow' as const, scopeType: 'global' as const };
      for (const permissionKey of ['org.admin', 'run.amend']) {
        expect(
          await codeOf(() => admin.admin.memberPermissionSet({ ...base, permissionKey })),
        ).toBe('FORBIDDEN');
      }
      expect(
        await codeOf(() =>
          admin.admin.memberPermissionSet({ ...base, permissionKey: 'prices.view' }),
        ),
      ).toBeNull();
      const superAdmin = appRouter.createCaller(fixture().superAdminCtx);
      for (const permissionKey of ['org.admin', 'run.amend']) {
        expect(
          await codeOf(() => superAdmin.admin.memberPermissionSet({ ...base, permissionKey })),
        ).toBeNull();
      }
    },
  );
});

describe('expired role bindings carry no admin authority', () => {
  test.skipIf(!SHOULD_RUN)(
    'a lapsed admin binding neither outranks nor administers anyone',
    async () => {
      const db = getDb(undefined, { system: 'maintenance' });
      const storeA = await makeStore(`A-${Math.random()}`);
      const user = await makeUser('Lapsed-Admin');
      const memberId = await makeMember(user.id);
      await bindRole(memberId, fixture().managerRoleId, { type: 'store', storeId: storeA.id });
      await db.insert(s.memberRoleBindings).values({
        memberId,
        roleId: fixture().adminRoleId,
        scopeType: 'global',
        expiresAt: new Date(Date.now() - 60_000),
      });
      const caller = callerFor(await sessionFor(memberId, user.id));

      // Rank: still only a manager, so a peer manager is out of reach.
      const peerUser = await makeUser('Peer-Manager');
      const peer = await makeMember(peerUser.id);
      await bindRole(peer, fixture().managerRoleId, { type: 'store', storeId: storeA.id });
      const [peerBinding] = await db
        .select({ id: s.memberRoleBindings.id })
        .from(s.memberRoleBindings)
        .where(eq(s.memberRoleBindings.memberId, peer));
      expect(await codeOf(() => caller.admin.revokeRole({ bindingId: peerBinding!.id }))).toBe(
        'FORBIDDEN',
      );

      // Scope: the lapsed global binding does not open other stores.
      const storeB = await makeStore(`B-${Math.random()}`);
      await expect(
        caller.admin.memberInviteByTgId({
          tgUserId: String(freshTgId()),
          storeIds: [storeB.id],
        }),
      ).rejects.toThrow('notAdminOfStore');
    },
  );
});

describe('role binding scope is constrained by the database', () => {
  test.skipIf(!SHOULD_RUN)('rejects a scope the permission checks would ignore', async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    const store = await makeStore(`Scope-${Math.random()}`);
    const user = await makeUser('Scope-Check');
    const memberId = await makeMember(user.id);
    const bind = async (scopeType: string, scopeId: string | null): Promise<void> => {
      await db
        .insert(s.memberRoleBindings)
        .values({ memberId, roleId: fixture().staffRoleId, scopeType, scopeId });
    };

    /**
     * The scope check constraint must reject the row (23514, a
     * check_violation). drizzle wraps the driver's error and moves the
     * Postgres detail onto `cause`; pgErrorOf finds it there.
     */
    const expectScopeRejected = async (p: Promise<void>): Promise<void> => {
      expect(await pgErrorOf(() => p)).toMatchObject({
        code: '23514',
        constraint: 'mrb_scope_check',
      });
    };

    // 'org' is not a scope: the session would list its permissions while
    // every scoped check skipped it.
    await expectScopeRejected(bind('org', fixture().orgId));
    await expectScopeRejected(bind('global', store.id));
    await expectScopeRejected(bind('store', null));

    await bind('global', null);
    await bind('store', store.id);
  });
});

// ---------- 2026-10-21 audit: CA-07, CA-08, A-11, CA-39 ----------------

describe('2026-10-21 audit admin gates', () => {
  const maintenance = () => getDb(undefined, { system: 'maintenance' });

  async function managerOf(storeId: string) {
    const user = await makeUser('Audit-Manager');
    const memberId = await makeMember(user.id);
    await bindRole(memberId, fixture().managerRoleId, { type: 'store', storeId });
    await maintenance()
      .insert(s.memberStoreAssignments)
      .values({ memberId, storeId })
      .onConflictDoNothing();
    const caller = callerFor(await sessionFor(memberId, user.id));
    return { caller, memberId, userId: user.id };
  }

  async function memberIn(storeIds: string[], roleId = fixture().staffRoleId) {
    const user = await makeUser('Audit-Target');
    const memberId = await makeMember(user.id);
    for (const storeId of storeIds) {
      await bindRole(memberId, roleId, { type: 'store', storeId });
      await maintenance()
        .insert(s.memberStoreAssignments)
        .values({ memberId, storeId })
        .onConflictDoNothing();
    }
    return { memberId, userId: user.id };
  }

  async function nameOf(userId: string): Promise<string | undefined> {
    const row = await maintenance().query.users.findFirst({
      where: (u, { eq: eq2 }) => eq2(u.id, userId),
    });
    return row?.displayName;
  }

  async function auditActions(resourceId: string): Promise<string[]> {
    const rows = await maintenance().query.policyDecisions.findMany({
      where: (pd, { and: and2, eq: eq2 }) =>
        and2(eq2(pd.orgId, fixture().orgId), eq2(pd.resourceId, resourceId)),
    });
    return rows.map((r) => r.action);
  }

  test.skipIf(!SHOULD_RUN)('CA-07 store manager cannot rename a super admin', async () => {
    const store = await makeStore(`Ren-${Math.random()}`);
    const { caller } = await managerOf(store.id);
    const target = await makeSuperAdmin('Rename-Super-Admin');
    expect(
      await codeOf(() =>
        caller.admin.memberSetDisplayName({
          memberId: target.memberId,
          displayName: 'Hijacked',
        }),
      ),
    ).toBe('FORBIDDEN');
    expect(await nameOf(target.userId)).toBe('Rename-Super-Admin');
  });

  test.skipIf(!SHOULD_RUN)('CA-07 store manager cannot rename staff of another store', async () => {
    const storeA = await makeStore(`RenA-${Math.random()}`);
    const storeB = await makeStore(`RenB-${Math.random()}`);
    const { caller } = await managerOf(storeA.id);
    const target = await memberIn([storeB.id]);
    expect(
      await codeOf(() =>
        caller.admin.memberSetDisplayName({ memberId: target.memberId, displayName: 'X' }),
      ),
    ).toBe('FORBIDDEN');
  });

  test.skipIf(!SHOULD_RUN)(
    'CA-07 store manager renames own staff; org admin renames anyone; both audited',
    async () => {
      const store = await makeStore(`RenOk-${Math.random()}`);
      const { caller } = await managerOf(store.id);
      const target = await memberIn([store.id]);
      await caller.admin.memberSetDisplayName({
        memberId: target.memberId,
        displayName: 'Renamed By Manager',
      });
      expect(await nameOf(target.userId)).toBe('Renamed By Manager');
      const admin = appRouter.createCaller(fixture().superAdminCtx);
      await admin.admin.memberSetDisplayName({
        memberId: target.memberId,
        displayName: 'Renamed By Admin',
      });
      expect(await nameOf(target.userId)).toBe('Renamed By Admin');
      const actions = await auditActions(target.memberId);
      expect(actions.filter((a) => a === 'admin.member.setDisplayName').length).toBe(2);
    },
  );

  test.skipIf(!SHOULD_RUN)('CA-08 store manager cannot pause their store', async () => {
    const store = await makeStore(`Pause-${Math.random()}`);
    const { caller } = await managerOf(store.id);
    expect(
      await codeOf(() => caller.admin.storeUpdate({ storeId: store.id, isActive: false })),
    ).toBe('FORBIDDEN');
    const row = await maintenance().query.stores.findFirst({
      where: (st, { eq: eq2 }) => eq2(st.id, store.id),
    });
    expect(row?.isActive).toBe(true);
    // A plain rename is still allowed for the store's manager.
    await caller.admin.storeUpdate({ storeId: store.id, name: `${store.name}-m` });
  });

  test.skipIf(!SHOULD_RUN)('CA-08 org admin can reactivate a paused / archived store', async () => {
    const store = await makeStore(`Restore-${Math.random()}`);
    const admin = appRouter.createCaller(fixture().superAdminCtx);
    await admin.admin.storeDelete({ storeId: store.id });
    await admin.admin.storeUpdate({ storeId: store.id, isActive: true });
    const row = await maintenance().query.stores.findFirst({
      where: (st, { eq: eq2 }) => eq2(st.id, store.id),
    });
    expect(row?.isActive).toBe(true);
    expect(row?.deletedAt).toBeNull();
  });

  test.skipIf(!SHOULD_RUN)('A-11 manager cannot unassign a peer manager', async () => {
    const storeA = await makeStore(`UnA-${Math.random()}`);
    const storeB = await makeStore(`UnB-${Math.random()}`);
    const { caller } = await managerOf(storeA.id);
    const peer = await memberIn([storeA.id, storeB.id], fixture().managerRoleId);
    expect(
      await codeOf(() =>
        caller.admin.memberUnassignStore({ memberId: peer.memberId, storeId: storeA.id }),
      ),
    ).toBe('FORBIDDEN');
    const still = await maintenance().query.memberStoreAssignments.findFirst({
      where: (msa, { and: and2, eq: eq2 }) =>
        and2(eq2(msa.memberId, peer.memberId), eq2(msa.storeId, storeA.id)),
    });
    expect(still).toBeTruthy();
  });

  test.skipIf(!SHOULD_RUN)('CA-39 grant / revoke / assign / unassign are audited', async () => {
    const storeA = await makeStore(`AudA-${Math.random()}`);
    const storeB = await makeStore(`AudB-${Math.random()}`);
    const target = await memberIn([storeA.id]);
    const admin = appRouter.createCaller(fixture().superAdminCtx);
    const { bindingId } = await admin.admin.grantRole({
      userId: target.userId,
      roleSlug: 'staff',
      scopeType: 'store',
      scopeId: storeB.id,
    });
    await admin.admin.revokeRole({ bindingId });
    await admin.admin.memberAssignStore({ memberId: target.memberId, storeId: storeB.id });
    await admin.admin.memberUnassignStore({ memberId: target.memberId, storeId: storeB.id });
    const memberActions = await auditActions(target.memberId);
    expect(memberActions).toContain('admin.role.grant');
    expect(memberActions).toContain('admin.memberAssignStore');
    expect(memberActions).toContain('admin.memberUnassignStore');
    expect(await auditActions(bindingId)).toContain('admin.role.revoke');
  });

  test.skipIf(!SHOULD_RUN)('A-23 grantRole refuses a past expiresAt', async () => {
    const store = await makeStore(`Exp-${Math.random()}`);
    const target = await memberIn([store.id]);
    const admin = appRouter.createCaller(fixture().superAdminCtx);
    expect(
      await codeOf(() =>
        admin.admin.grantRole({
          userId: target.userId,
          roleSlug: 'manager',
          scopeType: 'store',
          scopeId: store.id,
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        }),
      ),
    ).toBe('BAD_REQUEST');
  });

  test.skipIf(!SHOULD_RUN)('CA-40 duplicate category slug is a CONFLICT', async () => {
    const admin = appRouter.createCaller(fixture().superAdminCtx);
    const slug = `dup-${Math.random().toString(36).slice(2, 8)}`;
    const names = { uz: 'a', ru: 'a', en: 'a', zh: 'a' };
    await admin.admin.categoryCreate({ slug, names });
    expect(await errorOf(() => admin.admin.categoryCreate({ slug, names }))).toMatchObject({
      code: 'CONFLICT',
      message: 'admin.errors.slugTaken',
    });
  });
});
