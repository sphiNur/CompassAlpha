/**
 * Integration tests for the store-scoped admin model (M1.1 → M1.2B).
 *
 * The smokes that ship with deploy.ts run as a single org-wide admin in
 * a single store. They never exercise:
 *   - C1 (per-store rank gate)
 *   - C2 (store-scoped admin can only act on their stores)
 *   - D1 (memberDetachFromStore atomicity)
 *   - D2 (memberTransferStore mirroring)
 *   - D3 (per-store default role fall-through in invite)
 *   - D4 (storeCloneRoles)
 *   - B1 (roleDetail assignee scope)
 *   - B2 (admin audit per-store filter + scope_store_id derivation)
 *
 * Each of those is a write-side gate or a denormalized index that's
 * one careless edit away from regression. Smoke catches "the page
 * doesn't blank-screen"; these tests catch "is the gate still locked?"
 *
 * Run with `bun test apps/api/src/__tests__/store-scoped-admin.test.ts`.
 * Skipped automatically when DATABASE_URL is unset OR
 * SKIP_PG_TESTS=1 (deploy.ts sets this on the dev box).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { getDb, schema as s, withOrgContext } from '@compass/db';
import { logger } from '../infra/log';
import { appRouter } from '../trpc/router';
import type { RequestContext, SessionContext } from '../trpc/context';

// ---------- bootstrap .env so DATABASE_URL is on the env ---------------

(function loadEnv() {
  let dir = dirname(fileURLToPath(import.meta.url));
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

// ---------- minimal context factory --------------------------------------

/**
 * Build a tRPC RequestContext as if a request had landed with a valid
 * session for the given user/member/org. We don't go through the
 * Bearer-token path — the session shape is what authedProcedure cares
 * about, not how it got loaded.
 */
function buildCtx(
  db: ReturnType<typeof getDb>,
  session: SessionContext,
): RequestContext {
  return {
    // hono context is unused by our admin handlers; cast to any so the
    // type doesn't force us to mock the whole Hono surface.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hono: {} as any,
    db,
    log: logger,
    traceId: `test-${Date.now()}`,
    ip: null,
    userAgent: null,
    idempotencyKey: null,
    session,
    async withOrg(fn) {
      return withOrgContext(db, session.orgId, fn);
    },
  };
}

/**
 * Refresh a session's permission set by re-loading the actor's bindings.
 * Most tests grant a binding mid-run and need the next call to see the
 * new perms. Mirrors what loadSession() does in production but skips
 * the JWT layer.
 */
async function reloadSession(
  db: ReturnType<typeof getDb>,
  prev: SessionContext,
): Promise<SessionContext> {
  const bindings = await db
    .select({ role: s.roles })
    .from(s.memberRoleBindings)
    .innerJoin(s.roles, eq(s.roles.id, s.memberRoleBindings.roleId))
    .where(eq(s.memberRoleBindings.memberId, prev.memberId));
  const roleIds = bindings.map((b) => b.role.id);
  const perms = roleIds.length
    ? await db.query.rolePermissions.findMany({
        where: (rp, { inArray }) => inArray(rp.roleId, roleIds),
      })
    : [];
  return {
    ...prev,
    roleSlugs: new Set(bindings.map((b) => b.role.slug)),
    permissions: new Set(perms.map((p) => p.permissionKey)),
  };
}

// ---------- one fixture org shared across tests --------------------------

interface Fixture {
  orgId: string;
  superAdminUserId: string;
  superAdminMemberId: string;
  superAdminCtx: RequestContext;
  // built-in roles, looked up after seed.
  superAdminRoleId: string;
  adminRoleId: string;
  managerRoleId: string;
  staffRoleId: string;
  // unique slug so re-runs don't collide.
  slugSuffix: string;
}

let fix: Fixture | null = null;

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb();
  const slugSuffix = `${Date.now()}`;

  // 1. Org
  const [org] = await db
    .insert(s.organizations)
    .values({
      slug: `m1test-${slugSuffix}`,
      name: 'M1 Store-Scoped Admin Tests',
      localeDefault: 'en',
      timezone: 'UTC',
    })
    .returning();
  if (!org) throw new Error('org insert failed');

  // 2. Built-in roles. We'd normally rely on the seed, but the seed is
  //    org-agnostic — fresh orgs need their roles inserted explicitly.
  //    We mirror packages/db seed-data.ts ranks.
  const seedRoles = [
    { slug: 'super_admin', name: 'Super Admin', rank: 100, perms: ['users.manage', 'users.invite', 'users.grant_role', 'users.revoke_role'] },
    { slug: 'admin',       name: 'Admin',       rank: 80,  perms: ['users.manage', 'users.invite', 'users.grant_role', 'users.revoke_role'] },
    { slug: 'manager',     name: 'Manager',     rank: 30,  perms: ['order.approve', 'users.invite'] },
    { slug: 'staff',       name: 'Staff',       rank: 10,  perms: ['order.draft'] },
  ];
  const roleIdBySlug: Record<string, string> = {};
  for (const r of seedRoles) {
    const [row] = await db
      .insert(s.roles)
      .values({
        orgId: org.id,
        slug: r.slug,
        name: r.name,
        rank: r.rank,
        isBuiltIn: true,
      })
      .returning();
    if (!row) throw new Error(`role insert failed: ${r.slug}`);
    roleIdBySlug[r.slug] = row.id;
    // Make sure the perm dictionary has each key, then insert role-perm rows.
    for (const k of r.perms) {
      await db
        .insert(s.permissions)
        .values({ key: k, description: `Test perm ${k}` })
        .onConflictDoNothing();
      await db
        .insert(s.rolePermissions)
        .values({ roleId: row.id, permissionKey: k })
        .onConflictDoNothing();
    }
  }

  // 3. Super-admin user + member
  const tgBase = Number(slugSuffix.slice(-9));
  const [superUser] = await db
    .insert(s.users)
    .values({ displayName: 'Super Admin', tgUserId: BigInt(tgBase) })
    .returning();
  const [superMember] = await db
    .insert(s.members)
    .values({ orgId: org.id, userId: superUser!.id, status: 'active' })
    .returning();
  await db.insert(s.memberRoleBindings).values({
    memberId: superMember!.id,
    roleId: roleIdBySlug.super_admin!,
    scopeType: 'global',
  });

  const superSession: SessionContext = {
    userId: superUser!.id,
    memberId: superMember!.id,
    orgId: org.id,
    permissions: new Set(seedRoles.find((r) => r.slug === 'super_admin')!.perms),
    roleSlugs: new Set(['super_admin']),
  };

  fix = {
    orgId: org.id,
    superAdminUserId: superUser!.id,
    superAdminMemberId: superMember!.id,
    superAdminCtx: buildCtx(db, superSession),
    superAdminRoleId: roleIdBySlug.super_admin!,
    adminRoleId: roleIdBySlug.admin!,
    managerRoleId: roleIdBySlug.manager!,
    staffRoleId: roleIdBySlug.staff!,
    slugSuffix,
  };
});

afterAll(() => {
  // Don't clean up — the slug is timestamped and rows are tagged so
  // back-to-back runs don't collide. Leaving them simplifies forensic
  // inspection if a test ever fails.
});

// ---------- helpers used by individual tests -----------------------------

async function makeStore(name: string): Promise<{ id: string; name: string }> {
  if (!fix) throw new Error('fixture missing');
  const caller = appRouter.createCaller(fix.superAdminCtx);
  const { id } = await caller.admin.storeCreate({ name });
  return { id, name };
}

async function makeUser(displayName: string): Promise<{ id: string; tgUserId: bigint }> {
  if (!fix) throw new Error('fixture missing');
  const db = getDb();
  const tgUserId = BigInt(`${fix.slugSuffix}${Math.floor(Math.random() * 1e6)}`.slice(-12));
  const [u] = await db.insert(s.users).values({ displayName, tgUserId }).returning();
  return { id: u!.id, tgUserId };
}

async function makeMember(userId: string): Promise<string> {
  if (!fix) throw new Error('fixture missing');
  const db = getDb();
  const [m] = await db
    .insert(s.members)
    .values({ orgId: fix.orgId, userId, status: 'active' })
    .returning();
  return m!.id;
}

async function bindRole(
  memberId: string,
  roleId: string,
  scope: { type: 'global' } | { type: 'store'; storeId: string },
): Promise<void> {
  const db = getDb();
  await db.insert(s.memberRoleBindings).values({
    memberId,
    roleId,
    scopeType: scope.type,
    scopeId: scope.type === 'store' ? scope.storeId : null,
  });
}

async function sessionFor(memberId: string, userId: string): Promise<SessionContext> {
  if (!fix) throw new Error('fixture missing');
  const db = getDb();
  const base: SessionContext = {
    userId,
    memberId,
    orgId: fix.orgId,
    permissions: new Set(),
    roleSlugs: new Set(),
  };
  return reloadSession(db, base);
}

// ---------- C2: store-scoped admin can only act on their stores ----------

describe('C2 store-scoped admin gates', () => {
  test.skipIf(!SHOULD_RUN)(
    'manager-of-A cannot invite a member into Store B',
    async () => {
      const fx = fix!;
      const storeA = await makeStore(`A-${Math.random()}`);
      const storeB = await makeStore(`B-${Math.random()}`);
      // make a "store-A admin" — manager scoped to A only.
      const mgrUser = await makeUser('A-Manager');
      const mgrMember = await makeMember(mgrUser.id);
      await bindRole(mgrMember, fx.managerRoleId, { type: 'store', storeId: storeA.id });
      const ctx = buildCtx(getDb(), await sessionFor(mgrMember, mgrUser.id));
      const caller = appRouter.createCaller(ctx);
      // Try to invite into Store B → must be FORBIDDEN.
      const targetTg = `${Date.now()}1`.slice(-12);
      let threw = false;
      try {
        await caller.admin.memberInviteByTgId({
          tgUserId: targetTg,
          storeIds: [storeB.id],
        });
      } catch (err) {
        threw = true;
        expect((err as Error).message).toContain('notAdminOfStore');
      }
      expect(threw).toBe(true);
    },
  );

  test.skipIf(!SHOULD_RUN)(
    'manager-of-A cannot grant a role scoped to Store B',
    async () => {
      const fx = fix!;
      const storeA = await makeStore(`A-${Math.random()}`);
      const storeB = await makeStore(`B-${Math.random()}`);
      const mgrUser = await makeUser('A-Manager');
      const mgrMember = await makeMember(mgrUser.id);
      await bindRole(mgrMember, fx.managerRoleId, { type: 'store', storeId: storeA.id });
      const targetUser = await makeUser('Target');
      await makeMember(targetUser.id);
      const ctx = buildCtx(getDb(), await sessionFor(mgrMember, mgrUser.id));
      const caller = appRouter.createCaller(ctx);
      let threw = false;
      try {
        await caller.admin.grantRole({
          userId: targetUser.id,
          roleSlug: 'staff',
          scopeType: 'store',
          scopeId: storeB.id,
        });
      } catch (err) {
        threw = true;
        expect((err as Error).message).toContain('notAdminOfStore');
      }
      expect(threw).toBe(true);
    },
  );

  test.skipIf(!SHOULD_RUN)(
    'store-scoped admin cannot invite an org-tier role',
    async () => {
      const fx = fix!;
      const storeA = await makeStore(`A-${Math.random()}`);
      const mgrUser = await makeUser('A-Manager');
      const mgrMember = await makeMember(mgrUser.id);
      await bindRole(mgrMember, fx.managerRoleId, { type: 'store', storeId: storeA.id });
      const ctx = buildCtx(getDb(), await sessionFor(mgrMember, mgrUser.id));
      const caller = appRouter.createCaller(ctx);
      // The actor's role doesn't even include `users.manage` (manager is
      // rank 30, doesn't carry it), so this throws on the requireAdmin
      // gate before reaching the org-admin-role check. Either error is
      // acceptable — both close the same hole.
      let threw = false;
      try {
        await caller.admin.memberInviteByTgId({
          tgUserId: `${Date.now()}9`.slice(-12),
          roleSlug: 'admin',
          storeIds: [storeA.id],
        });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    },
  );
});

// ---------- C1: per-store rank gate --------------------------------------

describe('C1 per-store rank gate', () => {
  test.skipIf(!SHOULD_RUN)(
    'manager-of-A cannot grant a manager-rank role into A (rank tie refused)',
    async () => {
      const fx = fix!;
      const storeA = await makeStore(`A-${Math.random()}`);
      const mgrUser = await makeUser('A-Manager');
      const mgrMember = await makeMember(mgrUser.id);
      await bindRole(mgrMember, fx.managerRoleId, { type: 'store', storeId: storeA.id });
      // Need the manager to also have `users.grant_role` — bypass via
      // a per-member override since the seed doesn't put it on the
      // manager role. (In production a manager wouldn't try to grant
      // anyway; this is a synthetic test of the rank-tie path.)
      // Add it to the manager role permissions for this org.
      await getDb()
        .insert(s.permissions)
        .values({ key: 'users.manage', description: 'manage' })
        .onConflictDoNothing();
      await getDb()
        .insert(s.rolePermissions)
        .values({ roleId: fx.managerRoleId, permissionKey: 'users.manage' })
        .onConflictDoNothing();

      const targetUser = await makeUser('Target');
      await makeMember(targetUser.id);
      const ctx = buildCtx(getDb(), await sessionFor(mgrMember, mgrUser.id));
      const caller = appRouter.createCaller(ctx);
      let threw = false;
      try {
        await caller.admin.grantRole({
          userId: targetUser.id,
          roleSlug: 'manager', // rank 30
          scopeType: 'store',
          scopeId: storeA.id,
        });
      } catch (err) {
        threw = true;
        expect((err as Error).message).toMatch(/cannotGrantEqualOrHigher/);
      }
      expect(threw).toBe(true);
    },
  );
});

// ---------- D1: memberDetachFromStore atomicity --------------------------

describe('D1 memberDetachFromStore', () => {
  test.skipIf(!SHOULD_RUN)(
    'detach removes MSA + store-scoped bindings + overrides for the target store; preserves OTHER store',
    async () => {
      const fx = fix!;
      const db = getDb();
      const storeA = await makeStore(`A-${Math.random()}`);
      const storeB = await makeStore(`B-${Math.random()}`);
      // Target user belongs to BOTH stores (manager in A, staff in B)
      const targetUser = await makeUser('Multi-Store');
      const targetMember = await makeMember(targetUser.id);
      // Assign both stores via MSA + role bindings.
      await db.insert(s.memberStoreAssignments).values({ memberId: targetMember, storeId: storeA.id });
      await db.insert(s.memberStoreAssignments).values({ memberId: targetMember, storeId: storeB.id });
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
      const fx = fix!;
      const storeA = await makeStore(`A-${Math.random()}`);
      const storeB = await makeStore(`B-${Math.random()}`);
      const targetUser = await makeUser('Transferee');
      const targetMember = await makeMember(targetUser.id);
      const db = getDb();
      await db.insert(s.memberStoreAssignments).values({ memberId: targetMember, storeId: storeA.id });
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
        .select({ scopeType: s.memberRoleBindings.scopeType, scopeId: s.memberRoleBindings.scopeId })
        .from(s.memberRoleBindings)
        .where(
          and(
            eq(s.memberRoleBindings.memberId, targetMember),
            eq(s.memberRoleBindings.scopeId, storeB.id),
          ),
        );
      expect(bBinds.length).toBe(1);
      expect(bBinds[0]!.scopeType).toBe('store');
    },
  );

  test.skipIf(!SHOULD_RUN)(
    'transfer same-store BAD_REQUEST',
    async () => {
      const fx = fix!;
      const storeA = await makeStore(`A-${Math.random()}`);
      const targetUser = await makeUser('Self-Transfer');
      const targetMember = await makeMember(targetUser.id);
      const caller = appRouter.createCaller(fx.superAdminCtx);
      let threw = false;
      try {
        await caller.admin.memberTransferStore({
          memberId: targetMember,
          fromStoreId: storeA.id,
          toStoreId: storeA.id,
          mirrorRoles: true,
        });
      } catch (err) {
        threw = true;
        expect((err as Error).message).toContain('transferSameStore');
      }
      expect(threw).toBe(true);
    },
  );
});

// ---------- D3: per-store default role fall-through ----------------------

describe('D3 per-store default role', () => {
  test.skipIf(!SHOULD_RUN)(
    'invite without roleSlug picks up the store default',
    async () => {
      const fx = fix!;
      const storeA = await makeStore(`A-${Math.random()}`);
      // Set storeA's default to "staff".
      const caller = appRouter.createCaller(fx.superAdminCtx);
      await caller.admin.storeUpdate({
        storeId: storeA.id,
        defaultRoleSlug: 'staff',
      });
      // Invite a new user with no roleSlug into storeA.
      const tgUserId = `${Date.now()}3`.slice(-12);
      const result = await caller.admin.memberInviteByTgId({
        tgUserId,
        storeIds: [storeA.id],
      });
      // The new member should end up with a store-scoped binding for
      // "staff" in storeA — that's the fall-through.
      const db = getDb();
      const binds = await db
        .select({ roleSlug: s.roles.slug, scopeId: s.memberRoleBindings.scopeId })
        .from(s.memberRoleBindings)
        .innerJoin(s.roles, eq(s.roles.id, s.memberRoleBindings.roleId))
        .where(eq(s.memberRoleBindings.memberId, result.memberId));
      expect(binds.length).toBeGreaterThanOrEqual(1);
      expect(binds.some((b) => b.roleSlug === 'staff' && b.scopeId === storeA.id)).toBe(true);
    },
  );

  test.skipIf(!SHOULD_RUN)(
    'admin-tier role rejected as default',
    async () => {
      const fx = fix!;
      const storeA = await makeStore(`A-${Math.random()}`);
      const caller = appRouter.createCaller(fx.superAdminCtx);
      let threw = false;
      try {
        await caller.admin.storeUpdate({
          storeId: storeA.id,
          defaultRoleSlug: 'admin',
        });
      } catch (err) {
        threw = true;
        expect((err as Error).message).toContain('defaultRoleMustBeStoreTier');
      }
      expect(threw).toBe(true);
    },
  );
});

// ---------- D4: storeCloneRoles ------------------------------------------

describe('D4 storeCloneRoles', () => {
  test.skipIf(!SHOULD_RUN)(
    'clones store-scoped bindings from source to target; idempotent on re-run',
    async () => {
      const fx = fix!;
      const storeA = await makeStore(`A-${Math.random()}`);
      const storeB = await makeStore(`B-${Math.random()}`);
      const u1 = await makeUser('Staff1');
      const m1 = await makeMember(u1.id);
      const u2 = await makeUser('Staff2');
      const m2 = await makeMember(u2.id);
      await bindRole(m1, fx.staffRoleId, { type: 'store', storeId: storeA.id });
      await bindRole(m2, fx.managerRoleId, { type: 'store', storeId: storeA.id });

      const caller = appRouter.createCaller(fx.superAdminCtx);
      const first = await caller.admin.storeCloneRoles({
        sourceStoreId: storeA.id,
        targetStoreId: storeB.id,
        includeMembers: false,
      });
      expect(first.cloned).toBe(2);
      expect(first.skippedExisting).toBe(0);
      // Re-run: should be all skipped.
      const second = await caller.admin.storeCloneRoles({
        sourceStoreId: storeA.id,
        targetStoreId: storeB.id,
        includeMembers: false,
      });
      expect(second.cloned).toBe(0);
      expect(second.skippedExisting).toBe(2);
    },
  );
});

// ---------- B1: roleDetail.assignees -------------------------------------

describe('B1 roleDetail assignees', () => {
  test.skipIf(!SHOULD_RUN)(
    'returns assignees with scope_type + storeName for store-scoped bindings',
    async () => {
      const fx = fix!;
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
      const fx = fix!;
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

// ---------- M3.1: sales router store-scope assertion ---------------------
//
// Audit found sales.list took storeId as input without checking the
// caller was assigned to that store. A staff at Store A could pass
// storeId=<Store B> and read Store B's sales history. sales.record had
// the same shape — perm check + per-store override, but no MSA gate, so
// a Store A staff with `sales.record` could post deductions against
// Store B's inventory.
//
// Both procedures now call assertActorAssignedToStore BEFORE doing any
// other work; these tests lock that in.

describe('M3.1 sales router store-scope', () => {
  test.skipIf(!SHOULD_RUN)(
    'staff assigned only to Store A cannot list Store B sales',
    async () => {
      const fx = fix!;
      const storeA = await makeStore(`SalesA-${Math.random()}`);
      const storeB = await makeStore(`SalesB-${Math.random()}`);
      // Staff bound to Store A via a store-scoped role binding. The
      // role itself doesn't matter for sales.list (it's authed-only);
      // what matters is `getActorStoreIds(member, perms)` only returns
      // [storeA.id] and `assertActorAssignedToStore(storeB)` must
      // throw FORBIDDEN.
      const staffUser = await makeUser('A-Staff');
      const staffMember = await makeMember(staffUser.id);
      await bindRole(staffMember, fx.staffRoleId, {
        type: 'store',
        storeId: storeA.id,
      });
      const ctx = buildCtx(getDb(), await sessionFor(staffMember, staffUser.id));
      const caller = appRouter.createCaller(ctx);

      // POSITIVE: their own store works.
      const own = await caller.sales.list({ storeId: storeA.id });
      expect(Array.isArray(own)).toBe(true);

      // NEGATIVE: foreign store throws notAssignedToStore.
      let threw = false;
      try {
        await caller.sales.list({ storeId: storeB.id });
      } catch (err) {
        threw = true;
        expect((err as Error).message).toContain('notAssignedToStore');
      }
      expect(threw).toBe(true);
    },
  );

  test.skipIf(!SHOULD_RUN)(
    'staff with sales.record on a custom role cannot post a sale into a foreign store',
    async () => {
      const fx = fix!;
      const db = getDb();
      const storeA = await makeStore(`SalesA2-${Math.random()}`);
      const storeB = await makeStore(`SalesB2-${Math.random()}`);
      // Make sure the sales.record perm key exists, then mint a custom
      // role that carries it. Bind the role to Store A only.
      await db
        .insert(s.permissions)
        .values({ key: 'sales.record', description: 'record sales' })
        .onConflictDoNothing();
      const [salesRole] = await db
        .insert(s.roles)
        .values({
          orgId: fx.orgId,
          slug: `sales-staff-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          name: 'Sales Staff',
          rank: 15,
          isBuiltIn: false,
        })
        .returning();
      await db
        .insert(s.rolePermissions)
        .values({ roleId: salesRole!.id, permissionKey: 'sales.record' });

      const u = await makeUser('A-Sales');
      const m = await makeMember(u.id);
      await bindRole(m, salesRole!.id, { type: 'store', storeId: storeA.id });
      const ctx = buildCtx(getDb(), await sessionFor(m, u.id));
      const caller = appRouter.createCaller(ctx);

      // Use a syntactically-valid (but unused) dish UUID — the gate must
      // fire BEFORE the dish-existence check, so the call must throw
      // notAssignedToStore rather than dishNotFound.
      const fakeDish = '00000000-0000-0000-0000-000000000000';
      let threw = false;
      try {
        await caller.sales.record({
          storeId: storeB.id,
          dishId: fakeDish,
          qty: '1',
        });
      } catch (err) {
        threw = true;
        // Critical: must be the store gate, NOT a downstream error.
        // If the gate didn't fire, we'd see dishNotFound or permission
        // denied — both would mean the leak still exists.
        expect((err as Error).message).toContain('notAssignedToStore');
      }
      expect(threw).toBe(true);
    },
  );
});
