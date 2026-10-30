/**
 * ORD-4 (2026-10-30): a staff member can open any of their batches of the
 * day, and a rejected batch carries its reason in the day's list.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/order-batches.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { getDb, schema as s, withOrgContext } from '@compass/db';
import { logger } from '../infra/log';
import { appRouter } from '../trpc/router';
import { loadSession, type RequestContext, type SessionContext } from '../trpc/context';

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
let fix: { storeId: string; skuId: string; staff: Caller; other: Caller; manager: Caller } | null = null;

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug: `batches-${suffix}`, name: 'Batches', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  const orgId = org!.id;
  const roleIds: Record<string, string> = {};
  for (const slug of ['manager', 'staff']) {
    const def = BUILTIN_ROLES.find((r) => r.slug === slug)!;
    const [role] = await db.insert(s.roles).values({ orgId, slug, name: slug, rank: def.rank, isBuiltIn: true }).returning();
    roleIds[slug] = role!.id;
    for (const key of def.permissions) {
      await db.insert(s.permissions).values({ key, description: key }).onConflictDoNothing();
      await db.insert(s.rolePermissions).values({ roleId: role!.id, permissionKey: key }).onConflictDoNothing();
    }
  }
  const [store] = await db.insert(s.stores).values({ orgId, name: 'Store', code: `B-${suffix.slice(-6)}` }).returning();
  const [sku] = await db.insert(s.skus).values({ orgId, code: `BT-${suffix.slice(-8)}`, names: { en: 'Rice' }, unit: 'kg', step: '1' }).returning();
  let n = 0;
  const member = async (slug: string) => {
    n += 1;
    const [u] = await db.insert(s.users).values({ displayName: `Batches ${n}`, tgUserId: BigInt(`${suffix}${n}`.slice(-12)) }).returning();
    const [m] = await db.insert(s.members).values({ orgId, userId: u!.id, status: 'active' }).returning();
    await db.insert(s.memberStoreAssignments).values({ memberId: m!.id, storeId: store!.id, assignedBy: u!.id });
    await db.insert(s.memberRoleBindings).values({ memberId: m!.id, roleId: roleIds[slug]!, scopeType: 'store', scopeId: store!.id });
    const session = await loadSession(db, u!.id, orgId, m!.id);
    if (!session) throw new Error('session failed to load');
    return appRouter.createCaller(buildCtx(db, session));
  };
  fix = { storeId: store!.id, skuId: sku!.id, staff: await member('staff'), other: await member('staff'), manager: await member('manager') };
});

describe.skipIf(!SHOULD_RUN)('order batches (PG-gated)', () => {
  test('a batch can be opened by id; a rejected one says why; another member gets nothing', async () => {
    const { staff, other, manager, storeId, skuId } = fix!;
    const first = await staff.order.adjustItem({ storeId, skuId, qty: '2' });
    await staff.order.submit({ sessionId: first.sessionId });
    const second = await staff.order.adjustItem({ storeId, skuId, qty: '1' });
    await manager.order.claim({ sessionId: first.sessionId });
    await manager.order.reject({ sessionId: first.sessionId, reason: 'too much' });

    // Default pick is the open draft; the rejected batch is reachable by id.
    expect((await staff.order.todaySession({ storeId }))?.id).toBe(second.sessionId);
    const picked = await staff.order.todaySession({ storeId, sessionId: first.sessionId });
    expect(picked?.status).toBe('rejected');
    const batches = await staff.order.todayBatches({ storeId });
    expect(batches.find((b) => b.id === first.sessionId)?.rejectReason).toBe('too much');
    expect(await other.order.todaySession({ storeId, sessionId: first.sessionId })).toBeNull();
  });
});
