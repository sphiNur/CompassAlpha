/**
 * Medium findings of the 2026-10-30 operation atlas, server side:
 *   ORD-5  withdrawing a batch while a draft is open answered "edited by
 *          someone else" (the one-draft-per-day index);
 *   ORD-9  a 1,000,000,000 quantity overflowed numeric(12,3) as a 500;
 *   ADM-6  a suspended admin could not be removed or lose the admin role
 *          while one other admin remained;
 *   ADM-7  two grants of one role at once made two bindings (this test
 *          guards the outcome; the race shows over HTTP, not in-process).
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/medium-guards.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { getDb, schema as s, withOrgContext } from '@compass/db';
import { logger } from '../infra/log';
import { appRouter } from '../trpc/router';
import { loadSession, type RequestContext, type SessionContext } from '../trpc/context';
import { and, eq } from 'drizzle-orm';

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
interface Fixture {
  db: ReturnType<typeof getDb>;
  orgId: string;
  storeId: string;
  skuId: string;
  owner: Caller;
  staff: Caller;
  staffUserId: string;
  staffMemberId: string;
  admins: Array<{ memberId: string; bindingId: string }>;
}
let fix: Fixture | null = null;

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
    .values({ slug: `medium-${suffix}`, name: 'Medium guards', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  const orgId = org!.id;
  const roleIds: Record<string, string> = {};
  for (const slug of ['super_admin', 'admin', 'staff', 'purchaser']) {
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
  const [store] = await db.insert(s.stores).values({ orgId, name: 'Store', code: `M-${suffix.slice(-6)}` }).returning();
  const [sku] = await db
    .insert(s.skus)
    .values({ orgId, code: `MG-${suffix.slice(-8)}`, names: { en: 'Rice' }, unit: 'kg', step: '1' })
    .returning();

  let n = 0;
  const member = async (slug: string, scope: 'global' | 'store') => {
    n += 1;
    const [u] = await db
      .insert(s.users)
      .values({ displayName: `Medium ${n}`, tgUserId: BigInt(`${suffix}${n}`.slice(-12)) })
      .returning();
    const [m] = await db.insert(s.members).values({ orgId, userId: u!.id, status: 'active' }).returning();
    await db.insert(s.memberStoreAssignments).values({ memberId: m!.id, storeId: store!.id, assignedBy: u!.id });
    const [b] = await db
      .insert(s.memberRoleBindings)
      .values({ memberId: m!.id, roleId: roleIds[slug]!, scopeType: scope, scopeId: scope === 'store' ? store!.id : null })
      .returning();
    const session = await loadSession(db, u!.id, orgId, m!.id);
    if (!session) throw new Error('session failed to load');
    return { caller: appRouter.createCaller(buildCtx(db, session)), userId: u!.id, memberId: m!.id, bindingId: b!.id };
  };
  const owner = await member('super_admin', 'global');
  const staff = await member('staff', 'store');
  const a1 = await member('admin', 'global');
  const a2 = await member('admin', 'global');
  fix = {
    db,
    orgId,
    storeId: store!.id,
    skuId: sku!.id,
    owner: owner.caller,
    staff: staff.caller,
    staffUserId: staff.userId,
    staffMemberId: staff.memberId,
    admins: [a1, a2],
  };
});

describe.skipIf(!SHOULD_RUN)('medium guards (PG-gated)', () => {
  test('ORD-5: withdrawing a batch while a draft is open says to deal with the draft', async () => {
    const { staff, storeId, skuId } = fix!;
    const first = await staff.order.adjustItem({ storeId, skuId, qty: '2' });
    await staff.order.submit({ sessionId: first.sessionId });
    const second = await staff.order.adjustItem({ storeId, skuId, qty: '1' });
    expect(second.sessionId).not.toBe(first.sessionId);
    const err = await errorOf(() => staff.order.withdraw({ sessionId: first.sessionId }));
    expect(err?.code).toBe('PRECONDITION_FAILED');
    expect(err?.message).toBe('order.errors.withdrawDraftOpen');
  });

  test('ORD-9: an absurd quantity is refused as input, not a 500', async () => {
    const { staff, storeId, skuId } = fix!;
    const err = await errorOf(() => staff.order.adjustItem({ storeId, skuId, qty: '1000000000' }));
    expect(err?.code).toBe('BAD_REQUEST');
  });

  test('ORD-11: a phone whose clock runs ahead cannot open a draft for tomorrow', async () => {
    const { staff, storeId, skuId } = fix!;
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const err = await errorOf(() => staff.order.adjustItem({ storeId, skuId, qty: '1', date: tomorrow }));
    expect(err?.code).toBe('PRECONDITION_FAILED');
    expect(err?.message).toBe('order.errors.deviceDateAhead');
  });

  test('APR-6: approving one\'s own order tells the store\'s other approvers', async () => {
    const { db, orgId, storeId, skuId } = fix!;
    // The owner (super_admin, global) orders and approves it themselves.
    const owner = fix!.owner;
    const draft = await owner.order.adjustItem({ storeId, skuId, qty: '3' });
    await owner.order.submit({ sessionId: draft.sessionId });
    await owner.order.claim({ sessionId: draft.sessionId });
    await owner.order.approve({ sessionId: draft.sessionId });
    const rows = await db
      .select({ template: s.notifications.template })
      .from(s.notifications)
      .where(eq(s.notifications.orgId, orgId));
    expect(rows.some((r) => r.template === 'order.selfApproved')).toBe(true);
  });

  test('ADM-21: unknown keys and past expiries are refused; revoking nothing writes no audit', async () => {
    const { owner, staffMemberId, db, orgId } = fix!;
    const unknown = await errorOf(() =>
      owner.admin.memberPermissionSet({ memberId: staffMemberId, permissionKey: 'no.such.key', effect: 'allow' }),
    );
    expect(unknown?.message).toBe('admin.errors.unknownPermission');
    const past = await errorOf(() =>
      owner.admin.memberPermissionSet({
        memberId: staffMemberId,
        permissionKey: 'order.draft',
        effect: 'deny',
        expiresAt: '2020-01-01T00:00:00.000Z',
      }),
    );
    expect(past?.message).toBe('admin.errors.invalidExpiresAt');
    const before = await db.query.policyDecisions.findMany({ where: (x, o) => o.eq(x.orgId, orgId) });
    await owner.admin.memberPermissionRevoke({ memberId: staffMemberId, permissionKey: 'order.draft' });
    const after = await db.query.policyDecisions.findMany({ where: (x, o) => o.eq(x.orgId, orgId) });
    expect(after.length).toBe(before.length);
  });

  test('ADM-7: five grants of one role at once leave one binding', async () => {
    const { owner, staffUserId, staffMemberId, storeId, db } = fix!;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        owner.admin.grantRole({ userId: staffUserId, roleSlug: 'purchaser', scopeType: 'store', scopeId: storeId }),
      ),
    );
    const rows = await db
      .select({ id: s.memberRoleBindings.id })
      .from(s.memberRoleBindings)
      .innerJoin(s.roles, eq(s.roles.id, s.memberRoleBindings.roleId))
      .where(and(eq(s.memberRoleBindings.memberId, staffMemberId), eq(s.roles.slug, 'purchaser')));
    expect(rows).toHaveLength(1);
  });

  test('ADM-6: a suspended admin can lose the admin role and be removed', async () => {
    const { owner, db, admins } = fix!;
    const [a1, a2] = admins as [Fixture['admins'][0], Fixture['admins'][0]];
    // Leave the owner as the one other active admin-rank member.
    await db.update(s.members).set({ status: 'suspended' }).where(eq(s.members.id, a1.memberId));
    await db.update(s.members).set({ status: 'suspended' }).where(eq(s.members.id, a2.memberId));
    expect(await errorOf(() => owner.admin.revokeRole({ bindingId: a1.bindingId }))).toBeNull();
    expect(await errorOf(() => owner.admin.memberRemove({ memberId: a2.memberId }))).toBeNull();
  });
});
