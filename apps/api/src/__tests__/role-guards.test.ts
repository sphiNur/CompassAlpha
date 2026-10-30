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
let fix: { db: ReturnType<typeof getDb>; storeId: string; admin: Caller; manager: Caller; roleIds: Record<string, string> } | null = null;

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
  await member('super_admin', 'global');
  const admin = await member('admin', 'global');
  const manager = await member('manager', 'store');
  fix = { db, storeId: store!.id, admin, manager, roleIds };
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

  test('ADM-5: a manager cannot make a role at or above their rank the store default', async () => {
    const { manager, storeId } = fix!;
    const err = await errorOf(() => manager.admin.storeUpdate({ storeId, defaultRoleSlug: 'manager' }));
    expect(err?.code).toBe('FORBIDDEN');
    expect(err?.message).toBe('auth.errors.cannotGrantEqualOrHigher');
    expect(await errorOf(() => manager.admin.storeUpdate({ storeId, defaultRoleSlug: 'staff' }))).toBeNull();
  });
});
