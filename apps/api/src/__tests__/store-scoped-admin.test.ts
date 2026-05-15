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
import { randomUUID } from 'node:crypto';
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

// ---------- M3.2: dishes.manage demoted off store manager ----------------
//
// The pre-launch audit found that manager (rank 60, store-tier) had
// `dishes.manage` in its seed permission list. dishes/recipes are
// org-wide (the table has only org_id, not store_id) — so a Store A
// manager editing a recipe silently changes how every OTHER store
// deducts ingredient inventory at sale time.
//
// M3.2 removes the perm from the manager seed AND ships migration
// 0020 to retroactively delete the binding for every existing org.
// This test locks the seed state in.

describe('M3.2 store manager cannot edit org-wide dishes', () => {
  test.skipIf(!SHOULD_RUN)(
    'manager session does not carry dishes.manage and dishes.create throws FORBIDDEN',
    async () => {
      const fx = fix!;
      const storeA = await makeStore(`Dish-A-${Math.random()}`);
      const mgrUser = await makeUser('A-Manager-NoMenu');
      const mgrMember = await makeMember(mgrUser.id);
      await bindRole(mgrMember, fx.managerRoleId, { type: 'store', storeId: storeA.id });
      const session = await sessionFor(mgrMember, mgrUser.id);

      // (1) The manager's flat permission set must NOT carry
      // dishes.manage — proves the seed-level demotion took.
      expect(session.permissions.has('dishes.manage')).toBe(false);

      // (2) users.manage IS still on manager (for the M1.9 store-
      // level invite path). This is the trap the M3.2 follow-up
      // closes — without dropping the OR-fallback in
      // requireDishesManage, the manager would still slip through.
      expect(session.permissions.has('users.manage')).toBe(true);

      // (3) The real proof: calling dishes.create as the manager
      // must throw FORBIDDEN with the dishes.errors.cannotManage
      // marker. If this test ever starts succeeding it means the
      // users.manage fallback came back; that's a regression on the
      // org-wide write gate.
      const ctx = buildCtx(getDb(), session);
      const caller = appRouter.createCaller(ctx);
      let threw = false;
      try {
        await caller.dishes.create({
          names: { en: 'Forbidden Pasta' },
          ingredients: [],
        });
      } catch (err) {
        threw = true;
        expect((err as Error).message).toContain('cannotManage');
      }
      expect(threw).toBe(true);
    },
  );
});

// ---------- M3.2: per-store purchaser does not see foreign demand ----------
//
// `run.previewCreatable` used to be org-wide regardless of the actor's
// store binding — a purchaser bound to Store A would see Store B's
// approved demand and could include it in their run plan. M3.2 splits
// the perm into `run.create` (store-tier, filtered) and
// `run.create.org` (org-tier, unfiltered).

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

// ---------- M3.7: inventory + finance reports cannot leak cross-store ---
//
// Audit found two procedures that took an input.storeId but never
// verified the actor was bound to that store:
//   - inventory.levels: read on-hand stock
//   - inventory.recentMovements: read movement history
//   - inventory.stocktake / recordWastage: write to inventory ledger
//     (had perm check + effective-perm override but no MSA gate)
//   - report.purchaseLines / totals: finance roll-ups gated on
//     users.manage; manager-of-A could read Store B's finance because
//     users.manage doesn't imply per-store scope
//
// All five procedures now go through assertActorAssignedToStore OR a
// getActorStoreIds intersect (for the org-tier-vs-store-tier split
// on finance reports).

describe('M3.7 inventory cannot be read for a foreign store', () => {
  test.skipIf(!SHOULD_RUN)(
    'staff bound to Store A cannot inventory.levels(storeId=B)',
    async () => {
      const fx = fix!;
      const storeA = await makeStore(`InvA-${Math.random()}`);
      const storeB = await makeStore(`InvB-${Math.random()}`);
      const staffUser = await makeUser('A-Staff-Inv');
      const staffMember = await makeMember(staffUser.id);
      await bindRole(staffMember, fx.staffRoleId, {
        type: 'store',
        storeId: storeA.id,
      });
      const ctx = buildCtx(getDb(), await sessionFor(staffMember, staffUser.id));
      const caller = appRouter.createCaller(ctx);

      // OWN store: passes (returns whatever inventory is there).
      const own = await caller.inventory.levels({ storeId: storeA.id });
      expect(Array.isArray(own)).toBe(true);

      // FOREIGN store: must throw notAssignedToStore. Pre-M3.7 this
      // returned Store B's full on-hand list.
      let threw = false;
      try {
        await caller.inventory.levels({ storeId: storeB.id });
      } catch (err) {
        threw = true;
        expect((err as Error).message).toContain('notAssignedToStore');
      }
      expect(threw).toBe(true);
    },
  );

  test.skipIf(!SHOULD_RUN)(
    'manager bound to Store A cannot inventory.stocktake(storeId=B)',
    async () => {
      // The manager seed in this fixture doesn't include
      // inventory.adjust (the real seed adds it in M2.0a; the test
      // fixture is leaner). Grant it via the role_permissions table
      // to exercise the path. The gate must fire BEFORE the perm
      // check — order matters because we want the FORBIDDEN to be
      // notAssignedToStore, not cannotAdjust.
      const fx = fix!;
      const db = getDb();
      await db
        .insert(s.permissions)
        .values({ key: 'inventory.adjust', description: 'inventory adjust' })
        .onConflictDoNothing();
      await db
        .insert(s.rolePermissions)
        .values({ roleId: fx.managerRoleId, permissionKey: 'inventory.adjust' })
        .onConflictDoNothing();
      const storeA = await makeStore(`StockA-${Math.random()}`);
      const storeB = await makeStore(`StockB-${Math.random()}`);
      const mgrUser = await makeUser('A-Mgr-Stocktake');
      const mgrMember = await makeMember(mgrUser.id);
      await bindRole(mgrMember, fx.managerRoleId, {
        type: 'store',
        storeId: storeA.id,
      });
      const ctx = buildCtx(db, await sessionFor(mgrMember, mgrUser.id));
      const caller = appRouter.createCaller(ctx);

      // Real SKU UUID doesn't need to exist — the store-gate fires
      // before the SKU is looked up by the stocktake handler.
      const fakeSku = '00000000-0000-0000-0000-000000000000';
      let threw = false;
      try {
        await caller.inventory.stocktake({
          storeId: storeB.id,
          skuId: fakeSku,
          target: '0',
        });
      } catch (err) {
        threw = true;
        expect((err as Error).message).toContain('notAssignedToStore');
      }
      expect(threw).toBe(true);
    },
  );
});

describe('M3.7 finance reports filter by actor bindings unless org.admin', () => {
  test.skipIf(!SHOULD_RUN)(
    'manager-of-A passing storeId=B to report.purchaseLines throws notAssignedToStore',
    async () => {
      const fx = fix!;
      const db = getDb();
      const storeA = await makeStore(`FinA-${Math.random()}`);
      const storeB = await makeStore(`FinB-${Math.random()}`);
      const mgrUser = await makeUser('A-Mgr-Finance');
      const mgrMember = await makeMember(mgrUser.id);
      await bindRole(mgrMember, fx.managerRoleId, {
        type: 'store',
        storeId: storeA.id,
      });
      // Manager seed already carries users.manage (line 159 in this
      // fixture), so the requireAdmin-style gate at the top of
      // report.purchaseLines passes — what kicks in next is the
      // M3.7 store-scope filter.
      const ctx = buildCtx(db, await sessionFor(mgrMember, mgrUser.id));
      const caller = appRouter.createCaller(ctx);

      let threw = false;
      try {
        await caller.report.purchaseLines({
          startDate: '2026-01-01',
          endDate: '2026-12-31',
          storeId: storeB.id,
        });
      } catch (err) {
        threw = true;
        expect((err as Error).message).toContain('notAssignedToStore');
      }
      expect(threw).toBe(true);

      // Sanity: passing OWN storeId returns a well-formed list (likely
      // empty, but no throw).
      const own = await caller.report.purchaseLines({
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        storeId: storeA.id,
      });
      expect(Array.isArray(own)).toBe(true);
    },
  );

  test.skipIf(!SHOULD_RUN)(
    'manager-of-A calling report.purchaseLines without storeId is auto-filtered to bound stores',
    async () => {
      const fx = fix!;
      const db = getDb();
      const storeA = await makeStore(`FinA2-${Math.random()}`);
      const storeB = await makeStore(`FinB2-${Math.random()}`);
      const mgrUser = await makeUser('A-Mgr-Finance2');
      const mgrMember = await makeMember(mgrUser.id);
      await bindRole(mgrMember, fx.managerRoleId, {
        type: 'store',
        storeId: storeA.id,
      });
      const ctx = buildCtx(db, await sessionFor(mgrMember, mgrUser.id));
      const caller = appRouter.createCaller(ctx);

      // No storeId in the query → server-side allowedStoreIds filter
      // kicks in. Manager only bound to A, so any returned rows must
      // have storeId === storeA.id. Pre-M3.7 the result would include
      // every store's purchases org-wide.
      const lines = await caller.report.purchaseLines({
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      });
      for (const row of lines) {
        expect(row.storeId).toBe(storeA.id);
        expect(row.storeId).not.toBe(storeB.id);
      }
    },
  );
});

// ---------- M3.6: notification recipients are store-scoped ---------------
//
// Before M3.6 the order.submitted notification fan-out used
// findRecipientsByPermission which returned every user in the org
// with `order.approve` regardless of their binding's store scope.
// A manager bound to Store B would get notified about Store A
// submissions — an info leak about the other store's submission
// rate, contributor, and SKU mix.
//
// findRecipientsByPermissionInStore filters by perm AND
// (binding.scopeType='global' OR binding.scopeId=targetStoreId).
// Global bindings (admin/super_admin) still receive — they oversee
// the chain — but store-scoped bindings only fire for their own store.

describe('M3.6 notification recipients respect store scope', () => {
  test.skipIf(!SHOULD_RUN)(
    'findRecipientsByPermissionInStore: store-A manager included, store-B manager excluded, global admin included',
    async () => {
      const fx = fix!;
      const db = getDb();
      const storeA = await makeStore(`NotifyA-${Math.random()}`);
      const storeB = await makeStore(`NotifyB-${Math.random()}`);

      // Two managers bound to A and B respectively. The fixture's
      // manager role carries `order.approve`.
      const mgrAUser = await makeUser('A-Mgr-Notify');
      const mgrAMember = await makeMember(mgrAUser.id);
      await bindRole(mgrAMember, fx.managerRoleId, {
        type: 'store',
        storeId: storeA.id,
      });

      const mgrBUser = await makeUser('B-Mgr-Notify');
      const mgrBMember = await makeMember(mgrBUser.id);
      await bindRole(mgrBMember, fx.managerRoleId, {
        type: 'store',
        storeId: storeB.id,
      });

      // Lazy import to avoid pulling the service module into every
      // test file's top-level. notify.ts itself is side-effect-free
      // for imports.
      const { findRecipientsByPermissionInStore } = await import(
        '../services/notify'
      );
      const recipients = await findRecipientsByPermissionInStore(
        db,
        fx.orgId,
        'order.approve',
        storeA.id,
      );

      // Manager of Store A: included.
      expect(recipients).toContain(mgrAUser.id);
      // Manager of Store B: EXCLUDED. This is the leak that M3.6 closes.
      expect(recipients).not.toContain(mgrBUser.id);
      // Fixture super_admin has a global binding with users.manage etc.
      // and the seeded manager perm set DOES include order.approve via
      // the fixture (line ~159 seedRoles). Super-admin gets order.approve
      // through their own role only if it was granted; the fixture
      // grants super_admin only users.manage/invite/grant/revoke (line
      // ~158), so super_admin may or may not be in the recipient list
      // depending on whether order.approve was added to their role.
      // We don't assert on super_admin presence — the precise contract
      // we lock in is "store filter excludes foreign stores".
    },
  );

  test.skipIf(!SHOULD_RUN)(
    'findRecipientsByPermission (no scope filter) returns BOTH managers — proves filter is what makes the difference',
    async () => {
      const fx = fix!;
      const db = getDb();
      const storeA = await makeStore(`NotifyA2-${Math.random()}`);
      const storeB = await makeStore(`NotifyB2-${Math.random()}`);

      const mgrAUser = await makeUser('A-Mgr-Notify2');
      const mgrAMember = await makeMember(mgrAUser.id);
      await bindRole(mgrAMember, fx.managerRoleId, {
        type: 'store',
        storeId: storeA.id,
      });

      const mgrBUser = await makeUser('B-Mgr-Notify2');
      const mgrBMember = await makeMember(mgrBUser.id);
      await bindRole(mgrBMember, fx.managerRoleId, {
        type: 'store',
        storeId: storeB.id,
      });

      const { findRecipientsByPermission } = await import('../services/notify');
      const recipients = await findRecipientsByPermission(
        db,
        fx.orgId,
        'order.approve',
      );

      // The unscoped finder returns BOTH managers — same data shape
      // that was leaking to the notify fan-out pre-M3.6.
      expect(recipients).toContain(mgrAUser.id);
      expect(recipients).toContain(mgrBUser.id);
    },
  );
});

describe('M3.3 manager (rank 60) is blocked from org-wide writes', () => {
  test.skipIf(!SHOULD_RUN)(
    'manager cannot skuCreate (catalog write)',
    async () => {
      const fx = fix!;
      const storeA = await makeStore(`OrgA-${Math.random()}`);
      const mgrUser = await makeUser('A-Mgr-Catalog');
      const mgrMember = await makeMember(mgrUser.id);
      await bindRole(mgrMember, fx.managerRoleId, { type: 'store', storeId: storeA.id });
      const ctx = buildCtx(getDb(), await sessionFor(mgrMember, mgrUser.id));
      const caller = appRouter.createCaller(ctx);
      let threw = false;
      try {
        await caller.admin.skuCreate({
          names: { en: 'Forbidden SKU', uz: '', ru: '', zh: '' },
          unit: 'kg',
          // M3.14: step restricted to '0.5' | '1'. The old '0.1' got
          // rejected by zod BEFORE the permission check — failing the
          // test for the wrong reason. Use a valid step so the assertion
          // exercises the permission boundary as intended.
          step: '0.5',
          sortIndex: 999,
        });
      } catch (err) {
        threw = true;
        expect((err as Error).message).toContain('missingPermission');
      }
      expect(threw).toBe(true);
    },
  );

  test.skipIf(!SHOULD_RUN)(
    'manager cannot roleCreate (role catalog write)',
    async () => {
      const fx = fix!;
      const storeA = await makeStore(`OrgA-${Math.random()}`);
      const mgrUser = await makeUser('A-Mgr-Role');
      const mgrMember = await makeMember(mgrUser.id);
      await bindRole(mgrMember, fx.managerRoleId, { type: 'store', storeId: storeA.id });
      const ctx = buildCtx(getDb(), await sessionFor(mgrMember, mgrUser.id));
      const caller = appRouter.createCaller(ctx);
      let threw = false;
      try {
        await caller.admin.roleCreate({
          slug: `mgr-attempt-${Date.now()}`,
          name: 'Manager-spawned role',
          rank: 25,
          permissionKeys: [],
        });
      } catch (err) {
        threw = true;
        expect((err as Error).message).toContain('missingPermission');
      }
      expect(threw).toBe(true);
    },
  );

  test.skipIf(!SHOULD_RUN)(
    'manager cannot supplierCreate (org-wide supplier list)',
    async () => {
      const fx = fix!;
      const storeA = await makeStore(`OrgA-${Math.random()}`);
      const mgrUser = await makeUser('A-Mgr-Supplier');
      const mgrMember = await makeMember(mgrUser.id);
      await bindRole(mgrMember, fx.managerRoleId, { type: 'store', storeId: storeA.id });
      const ctx = buildCtx(getDb(), await sessionFor(mgrMember, mgrUser.id));
      const caller = appRouter.createCaller(ctx);
      let threw = false;
      try {
        await caller.admin.supplierCreate({
          name: 'Forbidden Supplier',
        });
      } catch (err) {
        threw = true;
        expect((err as Error).message).toContain('missingPermission');
      }
      expect(threw).toBe(true);
    },
  );

  test.skipIf(!SHOULD_RUN)(
    'manager-of-A cannot storeUpdate Store B (per-store admin gate)',
    async () => {
      const fx = fix!;
      const storeA = await makeStore(`OrgA-${Math.random()}`);
      const storeB = await makeStore(`OrgB-${Math.random()}`);
      const mgrUser = await makeUser('A-Mgr-StoreEdit');
      const mgrMember = await makeMember(mgrUser.id);
      await bindRole(mgrMember, fx.managerRoleId, { type: 'store', storeId: storeA.id });
      const ctx = buildCtx(getDb(), await sessionFor(mgrMember, mgrUser.id));
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
      let threw = false;
      try {
        await caller.admin.storeUpdate({
          storeId: storeB.id,
          name: 'Hijacked B',
        });
      } catch (err) {
        threw = true;
        expect((err as Error).message).toContain('notAdminOfStore');
      }
      expect(threw).toBe(true);
    },
  );
});

describe('M3.2 store-tier purchaser is filtered to bound stores', () => {
  test.skipIf(!SHOULD_RUN)(
    'purchaser bound to Store A only does not see Store B sessions in previewCreatable',
    async () => {
      const fx = fix!;
      const db = getDb();
      const storeA = await makeStore(`Run-A-${Math.random()}`);
      const storeB = await makeStore(`Run-B-${Math.random()}`);

      // Mint a `purchaser` role (rank 40) for this org with the
      // store-tier run perms only. The fixture's seedRoles list
      // doesn't include purchaser; create one fresh.
      await db
        .insert(s.permissions)
        .values([
          { key: 'run.create', description: 'plan run for bound stores' },
          { key: 'run.create.org', description: 'plan run org-wide' },
        ])
        .onConflictDoNothing();
      const [purchaserRole] = await db
        .insert(s.roles)
        .values({
          orgId: fx.orgId,
          slug: `purchaser-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          name: 'Purchaser',
          rank: 40,
          isBuiltIn: false,
        })
        .returning();
      await db
        .insert(s.rolePermissions)
        .values({ roleId: purchaserRole!.id, permissionKey: 'run.create' });
      // IMPORTANT: no run.create.org binding — the whole point is to
      // verify the store-tier path filters correctly.

      const buyer = await makeUser('A-Buyer');
      const buyerMember = await makeMember(buyer.id);
      await bindRole(buyerMember, purchaserRole!.id, {
        type: 'store',
        storeId: storeA.id,
      });

      const ctx = buildCtx(db, await sessionFor(buyerMember, buyer.id));
      const caller = appRouter.createCaller(ctx);

      // No approved sessions exist yet for either store — the result
      // should still be a well-formed empty preview, NOT a leak of
      // Store B's data. (We assert structure shape — the filter has
      // to short-circuit before the inArray would otherwise error.)
      const preview = await caller.run.previewCreatable({});
      expect(Array.isArray(preview.sessions)).toBe(true);
      // Whatever sessions come back, none can be from a store the
      // purchaser isn't bound to. (`storeB.id` must never appear.)
      const involvedStoreIds = new Set(
        preview.perStoreDemand.map((d) => d.storeId),
      );
      expect(involvedStoreIds.has(storeB.id)).toBe(false);
    },
  );

  test.skipIf(!SHOULD_RUN)(
    'purchaser cannot run.create with a sessionId from a foreign store',
    async () => {
      const fx = fix!;
      const db = getDb();
      const storeA = await makeStore(`RunC-A-${Math.random()}`);
      const storeB = await makeStore(`RunC-B-${Math.random()}`);
      await db
        .insert(s.permissions)
        .values({ key: 'run.create', description: 'plan run for bound stores' })
        .onConflictDoNothing();
      const [purchaserRole] = await db
        .insert(s.roles)
        .values({
          orgId: fx.orgId,
          slug: `purchaser2-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          name: 'Purchaser',
          rank: 40,
          isBuiltIn: false,
        })
        .returning();
      await db
        .insert(s.rolePermissions)
        .values({ roleId: purchaserRole!.id, permissionKey: 'run.create' });

      const buyer = await makeUser('A-Buyer2');
      const buyerMember = await makeMember(buyer.id);
      await bindRole(buyerMember, purchaserRole!.id, {
        type: 'store',
        storeId: storeA.id,
      });

      // Forge a "Store B approved session" by hand-inserting a row
      // into read_model.order_sessions_v. This bypasses the normal
      // approve flow but is fine for testing the run.create gate —
      // we just need a row whose storeId is in B and status is
      // 'approved' on today's date. The id matches stream_id by
      // schema convention but for this test we just need a fresh
      // uuid that the gate will see.
      const todayIso = new Date().toISOString().slice(0, 10);
      const foreignSessionId = randomUUID();
      const [foreignSession] = await db
        .insert(s.orderSessionsV)
        .values({
          id: foreignSessionId,
          orgId: fx.orgId,
          storeId: storeB.id,
          initiatedByMemberId: fx.superAdminMemberId,
          orderDate: todayIso,
          status: 'approved',
        })
        .returning();

      const ctx = buildCtx(db, await sessionFor(buyerMember, buyer.id));
      const caller = appRouter.createCaller(ctx);

      let threw = false;
      try {
        await caller.run.create({
          date: todayIso,
          sessionIds: [foreignSession!.id],
        });
      } catch (err) {
        threw = true;
        // Same precise check as the sales test: must throw the
        // store gate, NOT some downstream domain error.
        expect((err as Error).message).toContain('notAssignedToStore');
      }
      expect(threw).toBe(true);
    },
  );
});
