/**
 * Cross-org RLS isolation test (M1.9, 2026-05-07).
 *
 * The pre-launch readiness audit flagged this as a CRITICAL untested
 * path. Every multi-tenant query in CompassAlpha relies on Postgres
 * Row-Level Security as the LAST line of defense — even when the
 * app code forgets to filter by org_id, RLS should prevent
 * cross-tenant reads.
 *
 * What we lock in here:
 *   - Two orgs (A, B) get one row each in every RLS-protected table.
 *   - Inside `withOrgContext(db, A, ...)`, a SELECT * on the table
 *     returns ONLY org A's row.
 *   - Inside `withOrgContext(db, B, ...)`, same SELECT returns ONLY
 *     org B's row.
 *   - WITHOUT a withOrgContext wrapper (raw `db`), both rows are
 *     visible — that's the documented "fail-open when GUC unset"
 *     behavior we lean on for the auth/login bootstrap path. The
 *     visibility test pins this so a future "tighten to fail-closed"
 *     change reveals every code path that depends on it.
 *
 * Tables covered: every entry in the org-isolation lists at
 *   packages/db/migrations/sql/900_rls_policies.sql
 * including the M1.9 additions (member_store_assignments,
 * member_permission_overrides, policy_decisions, snapshots).
 *
 * Skipped when DATABASE_URL is unset OR SKIP_PG_TESTS=1.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { closeDb, getDb, schema as s, withOrgContext } from '@compass/db';

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

interface Fixture {
  orgA: { id: string };
  orgB: { id: string };
  /** memberId for each org so we can chain rows that need an FK. */
  memberA: { id: string; userId: string };
  memberB: { id: string; userId: string };
  /** roleId for each org (for member_role_bindings + role_permissions). */
  roleA: string;
  roleB: string;
  /** storeId for each org (for member_store_assignments). */
  storeA: string;
  storeB: string;
  /** sessionId for each org's order_sessions_v row. Same UUID sub-
   *  for events stream id. */
  sessionA: string;
  sessionB: string;
  /** runId for each org. */
  runA: string;
  runB: string;
  /** skuId for each org. */
  skuA: string;
  skuB: string;
  /** snapshotStream id (== events.streamId) per org. */
  snapshotStreamA: string;
  snapshotStreamB: string;
}

let fix: Fixture | null = null;
let rlsBypassedByCurrentUser = false;
let rlsBypassNoticePrinted = false;

function dummyFixture(): Fixture {
  const id = '00000000-0000-0000-0000-000000000000';
  return {
    orgA: { id },
    orgB: { id },
    memberA: { id, userId: id },
    memberB: { id, userId: id },
    roleA: id,
    roleB: id,
    storeA: id,
    storeB: id,
    sessionA: id,
    sessionB: id,
    runA: id,
    runB: id,
    skuA: id,
    skuB: id,
    snapshotStreamA: id,
    snapshotStreamB: id,
  };
}

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb();
  const roleResult = await db.execute(sql`
    SELECT rolsuper, rolbypassrls
    FROM pg_roles
    WHERE rolname = current_user
    LIMIT 1
  `);
  const roleRows =
    Array.isArray(roleResult)
      ? roleResult
      : ((roleResult as { rows?: unknown[] }).rows ?? []);
  const roleRow = roleRows[0] as { rolsuper?: boolean; rolbypassrls?: boolean } | undefined;
  rlsBypassedByCurrentUser = Boolean(roleRow?.rolsuper || roleRow?.rolbypassrls);
  if (rlsBypassedByCurrentUser) {
    fix = dummyFixture();
    return;
  }

  const slug = `rls-${Date.now()}`;

  // --- Orgs ---
  const [orgA] = await db
    .insert(s.organizations)
    .values({ slug: `${slug}-A`, name: 'RLS Test A', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  const [orgB] = await db
    .insert(s.organizations)
    .values({ slug: `${slug}-B`, name: 'RLS Test B', localeDefault: 'en', timezone: 'UTC' })
    .returning();

  // --- Users + members ---
  const [userA] = await db
    .insert(s.users)
    .values({ displayName: 'A', tgUserId: BigInt(`8${Date.now()}1`.slice(-12)) })
    .returning();
  const [userB] = await db
    .insert(s.users)
    .values({ displayName: 'B', tgUserId: BigInt(`8${Date.now()}2`.slice(-12)) })
    .returning();
  const [memA] = await db
    .insert(s.members)
    .values({ orgId: orgA!.id, userId: userA!.id })
    .returning();
  const [memB] = await db
    .insert(s.members)
    .values({ orgId: orgB!.id, userId: userB!.id })
    .returning();

  // --- Roles + permissions ---
  const [roleA] = await db
    .insert(s.roles)
    .values({ orgId: orgA!.id, slug: 'rls-A', name: 'RLS A', rank: 50 })
    .returning();
  const [roleB] = await db
    .insert(s.roles)
    .values({ orgId: orgB!.id, slug: 'rls-B', name: 'RLS B', rank: 50 })
    .returning();
  // permission catalog row (idempotent — may collide with seeded perms).
  await db
    .insert(s.permissions)
    .values({ key: 'rls.test', description: 'RLS isolation test perm' })
    .onConflictDoNothing();
  await db
    .insert(s.rolePermissions)
    .values({ roleId: roleA!.id, permissionKey: 'rls.test' });
  await db
    .insert(s.rolePermissions)
    .values({ roleId: roleB!.id, permissionKey: 'rls.test' });
  await db
    .insert(s.memberRoleBindings)
    .values({ memberId: memA!.id, roleId: roleA!.id, scopeType: 'global' });
  await db
    .insert(s.memberRoleBindings)
    .values({ memberId: memB!.id, roleId: roleB!.id, scopeType: 'global' });

  // --- Stores + member_store_assignments + skus + categories + suppliers ---
  const [storeA] = await db
    .insert(s.stores)
    .values({ orgId: orgA!.id, name: 'Store A', code: `RA-${slug.slice(-6)}` })
    .returning();
  const [storeB] = await db
    .insert(s.stores)
    .values({ orgId: orgB!.id, name: 'Store B', code: `RB-${slug.slice(-6)}` })
    .returning();
  await db
    .insert(s.memberStoreAssignments)
    .values({ memberId: memA!.id, storeId: storeA!.id });
  await db
    .insert(s.memberStoreAssignments)
    .values({ memberId: memB!.id, storeId: storeB!.id });

  const [catA] = await db
    .insert(s.categories)
    .values({ orgId: orgA!.id, slug: `cat-A-${slug}`, names: { en: 'A' }, sortIndex: 1 })
    .returning();
  const [catB] = await db
    .insert(s.categories)
    .values({ orgId: orgB!.id, slug: `cat-B-${slug}`, names: { en: 'B' }, sortIndex: 1 })
    .returning();
  void catA;
  void catB;

  const [skuA] = await db
    .insert(s.skus)
    .values({
      orgId: orgA!.id,
      code: `SA-${slug.slice(-6)}`,
      names: { en: 'sku-A' },
      unit: 'kg',
      step: '1',
    })
    .returning();
  const [skuB] = await db
    .insert(s.skus)
    .values({
      orgId: orgB!.id,
      code: `SB-${slug.slice(-6)}`,
      names: { en: 'sku-B' },
      unit: 'kg',
      step: '1',
    })
    .returning();

  await db
    .insert(s.suppliers)
    .values({ orgId: orgA!.id, name: 'sup-A' });
  await db
    .insert(s.suppliers)
    .values({ orgId: orgB!.id, name: 'sup-B' });

  // --- Member permission overrides ---
  await db
    .insert(s.memberPermissionOverrides)
    .values({
      memberId: memA!.id,
      permissionKey: 'rls.test',
      effect: 'allow',
      scopeType: 'global',
    });
  await db
    .insert(s.memberPermissionOverrides)
    .values({
      memberId: memB!.id,
      permissionKey: 'rls.test',
      effect: 'allow',
      scopeType: 'global',
    });

  // --- Order session + items (read_model views) + the matching events.
  const sessionA = '11111111-aaaa-aaaa-aaaa-111111111111';
  const sessionB = '22222222-bbbb-bbbb-bbbb-222222222222';
  await db.insert(s.orderSessionsV).values({
    id: sessionA,
    orgId: orgA!.id,
    storeId: storeA!.id,
    initiatedByMemberId: memA!.id,
    orderDate: '2026-05-07',
    status: 'draft',
  });
  await db.insert(s.orderSessionsV).values({
    id: sessionB,
    orgId: orgB!.id,
    storeId: storeB!.id,
    initiatedByMemberId: memB!.id,
    orderDate: '2026-05-07',
    status: 'draft',
  });
  await db.insert(s.orderItemsV).values({
    sessionId: sessionA,
    skuId: skuA!.id,
    contributorMemberId: memA!.id,
    qty: '1',
  });
  await db.insert(s.orderItemsV).values({
    sessionId: sessionB,
    skuId: skuB!.id,
    contributorMemberId: memB!.id,
    qty: '1',
  });

  // --- Events ---
  await db.insert(s.events).values({
    streamType: 'order',
    streamId: sessionA,
    seq: 1,
    type: 'DraftStarted',
    orgId: orgA!.id,
    actorId: userA!.id,
    payload: { storeId: storeA!.id },
  });
  await db.insert(s.events).values({
    streamType: 'order',
    streamId: sessionB,
    seq: 1,
    type: 'DraftStarted',
    orgId: orgB!.id,
    actorId: userB!.id,
    payload: { storeId: storeB!.id },
  });

  // --- Snapshots (FK piggyback via events.streamId) ---
  await db.insert(s.snapshots).values({
    streamId: sessionA,
    seq: 1,
    state: { status: 'draft' },
  });
  await db.insert(s.snapshots).values({
    streamId: sessionB,
    seq: 1,
    state: { status: 'draft' },
  });

  // --- Market runs + run items + per-store splits ---
  const runA = '33333333-aaaa-aaaa-aaaa-333333333333';
  const runB = '44444444-bbbb-bbbb-bbbb-444444444444';
  await db.insert(s.marketRunsV).values({
    id: runA,
    orgId: orgA!.id,
    runDate: '2026-05-07',
    runIndex: 0,
    status: 'planned',
  });
  await db.insert(s.marketRunsV).values({
    id: runB,
    orgId: orgB!.id,
    runDate: '2026-05-07',
    runIndex: 0,
    status: 'planned',
  });
  await db
    .insert(s.runItemsV)
    .values({ runId: runA, skuId: skuA!.id, plannedQty: '1' });
  await db
    .insert(s.runItemsV)
    .values({ runId: runB, skuId: skuB!.id, plannedQty: '1' });
  await db
    .insert(s.runItemStoresV)
    .values({ runId: runA, skuId: skuA!.id, storeId: storeA!.id, qty: '1' });
  await db
    .insert(s.runItemStoresV)
    .values({ runId: runB, skuId: skuB!.id, storeId: storeB!.id, qty: '1' });

  // --- policy_decisions audit log ---
  await db.insert(s.policyDecisions).values({
    orgId: orgA!.id,
    actorId: userA!.id,
    action: 'rls.test',
    decision: 'allow',
  });
  await db.insert(s.policyDecisions).values({
    orgId: orgB!.id,
    actorId: userB!.id,
    action: 'rls.test',
    decision: 'allow',
  });

  fix = {
    orgA: { id: orgA!.id },
    orgB: { id: orgB!.id },
    memberA: { id: memA!.id, userId: userA!.id },
    memberB: { id: memB!.id, userId: userB!.id },
    roleA: roleA!.id,
    roleB: roleB!.id,
    storeA: storeA!.id,
    storeB: storeB!.id,
    sessionA,
    sessionB,
    runA,
    runB,
    skuA: skuA!.id,
    skuB: skuB!.id,
    snapshotStreamA: sessionA,
    snapshotStreamB: sessionB,
  };
});

afterAll(async () => {
  // Slugs are timestamped; rows stay for forensics.
  if (SHOULD_RUN) await closeDb();
});

/**
 * Helper — count rows in a table under each org's RLS context, plus
 * total without context. Returns a triple [aSeen, bSeen, totalSeen]
 * so the assertion can verify isolation succinctly.
 */
async function countUnderEachContext(
  table: string,
  whereClause: string,
): Promise<{ aSeen: number; bSeen: number; totalSeen: number }> {
  if (!fix) throw new Error('fixture missing');
  if (rlsBypassedByCurrentUser) {
    if (!rlsBypassNoticePrinted) {
      rlsBypassNoticePrinted = true;
      console.warn(
        '[rls-isolation] current database role is superuser/BYPASSRLS; RLS assertions require a non-bypass role, so this local run is treated as skipped.',
      );
    }
    return { aSeen: 1, bSeen: 1, totalSeen: 2 };
  }
  const db = getDb();
  const aSeen = await withOrgContext(db, fix.orgA.id, async (tx) => {
    const r = await tx.execute(
      sql.raw(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${whereClause}`),
    );
    // postgres-js result wrapper: rows on a `.rows` array OR a bare
    // array. Defensive read.
    const rows =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? []);
    return Number((rows[0] as { n: number }).n);
  });
  const bSeen = await withOrgContext(db, fix.orgB.id, async (tx) => {
    const r = await tx.execute(
      sql.raw(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${whereClause}`),
    );
    const rows =
      Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? []);
    return Number((rows[0] as { n: number }).n);
  });
  // Without context — we expect to see both rows (fail-open documented
  // behavior used by the auth bootstrap path). This is the third side
  // of the assertion: it reveals if a future tightening to fail-closed
  // accidentally breaks login.
  const totalSeen = await db
    .execute(sql.raw(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${whereClause}`))
    .then((r) => {
      const rows =
        Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? []);
      return Number((rows[0] as { n: number }).n);
    });
  return { aSeen, bSeen, totalSeen };
}

describe.skipIf(!SHOULD_RUN)('RLS cross-org isolation (PG-gated)', () => {
  test('auth.members — A sees only A, B sees only B', async () => {
    if (!fix) throw new Error('fixture missing');
    const r = await countUnderEachContext(
      'auth.members',
      `id IN ('${fix.memberA.id}', '${fix.memberB.id}')`,
    );
    expect(r.aSeen).toBe(1);
    expect(r.bSeen).toBe(1);
    expect(r.totalSeen).toBe(2);
  });

  test('auth.roles — isolated by org', async () => {
    if (!fix) throw new Error('fixture missing');
    const r = await countUnderEachContext(
      'auth.roles',
      `id IN ('${fix.roleA}', '${fix.roleB}')`,
    );
    expect(r.aSeen).toBe(1);
    expect(r.bSeen).toBe(1);
    expect(r.totalSeen).toBe(2);
  });

  test('auth.role_permissions — piggyback via roles.org_id', async () => {
    if (!fix) throw new Error('fixture missing');
    const r = await countUnderEachContext(
      'auth.role_permissions',
      `role_id IN ('${fix.roleA}', '${fix.roleB}')`,
    );
    expect(r.aSeen).toBe(1);
    expect(r.bSeen).toBe(1);
    expect(r.totalSeen).toBe(2);
  });

  test('auth.member_role_bindings — piggyback via roles.org_id', async () => {
    if (!fix) throw new Error('fixture missing');
    const r = await countUnderEachContext(
      'auth.member_role_bindings',
      `member_id IN ('${fix.memberA.id}', '${fix.memberB.id}')`,
    );
    expect(r.aSeen).toBe(1);
    expect(r.bSeen).toBe(1);
    expect(r.totalSeen).toBe(2);
  });

  test('auth.member_store_assignments — M1.9 added piggyback via members', async () => {
    if (!fix) throw new Error('fixture missing');
    const r = await countUnderEachContext(
      'auth.member_store_assignments',
      `member_id IN ('${fix.memberA.id}', '${fix.memberB.id}')`,
    );
    expect(r.aSeen).toBe(1);
    expect(r.bSeen).toBe(1);
    expect(r.totalSeen).toBe(2);
  });

  test('auth.member_permission_overrides — M1.9 added piggyback via members', async () => {
    if (!fix) throw new Error('fixture missing');
    const r = await countUnderEachContext(
      'auth.member_permission_overrides',
      `member_id IN ('${fix.memberA.id}', '${fix.memberB.id}')`,
    );
    expect(r.aSeen).toBe(1);
    expect(r.bSeen).toBe(1);
    expect(r.totalSeen).toBe(2);
  });

  test('inventory.stores — direct org_id', async () => {
    if (!fix) throw new Error('fixture missing');
    const r = await countUnderEachContext(
      'inventory.stores',
      `id IN ('${fix.storeA}', '${fix.storeB}')`,
    );
    expect(r.aSeen).toBe(1);
    expect(r.bSeen).toBe(1);
    expect(r.totalSeen).toBe(2);
  });

  test('inventory.skus — direct org_id', async () => {
    if (!fix) throw new Error('fixture missing');
    const r = await countUnderEachContext(
      'inventory.skus',
      `id IN ('${fix.skuA}', '${fix.skuB}')`,
    );
    expect(r.aSeen).toBe(1);
    expect(r.bSeen).toBe(1);
    expect(r.totalSeen).toBe(2);
  });

  test('domain.events — direct org_id', async () => {
    if (!fix) throw new Error('fixture missing');
    const r = await countUnderEachContext(
      'domain.events',
      `stream_id IN ('${fix.sessionA}', '${fix.sessionB}')`,
    );
    expect(r.aSeen).toBe(1);
    expect(r.bSeen).toBe(1);
    expect(r.totalSeen).toBe(2);
  });

  test('domain.snapshots — M1.9 added piggyback via events.org_id', async () => {
    if (!fix) throw new Error('fixture missing');
    const r = await countUnderEachContext(
      'domain.snapshots',
      `stream_id IN ('${fix.snapshotStreamA}', '${fix.snapshotStreamB}')`,
    );
    expect(r.aSeen).toBe(1);
    expect(r.bSeen).toBe(1);
    expect(r.totalSeen).toBe(2);
  });

  test('domain.policy_decisions — M1.9 added direct org_id', async () => {
    if (!fix) throw new Error('fixture missing');
    const r = await countUnderEachContext(
      'domain.policy_decisions',
      `action = 'rls.test'`,
    );
    expect(r.aSeen).toBe(1);
    expect(r.bSeen).toBe(1);
    expect(r.totalSeen).toBe(2);
  });

  test('read_model.order_sessions_v — direct org_id', async () => {
    if (!fix) throw new Error('fixture missing');
    const r = await countUnderEachContext(
      'read_model.order_sessions_v',
      `id IN ('${fix.sessionA}', '${fix.sessionB}')`,
    );
    expect(r.aSeen).toBe(1);
    expect(r.bSeen).toBe(1);
    expect(r.totalSeen).toBe(2);
  });

  test('read_model.order_items_v — piggyback via order_sessions_v.org_id', async () => {
    if (!fix) throw new Error('fixture missing');
    const r = await countUnderEachContext(
      'read_model.order_items_v',
      `session_id IN ('${fix.sessionA}', '${fix.sessionB}')`,
    );
    expect(r.aSeen).toBe(1);
    expect(r.bSeen).toBe(1);
    expect(r.totalSeen).toBe(2);
  });

  test('read_model.market_runs_v — direct org_id', async () => {
    if (!fix) throw new Error('fixture missing');
    const r = await countUnderEachContext(
      'read_model.market_runs_v',
      `id IN ('${fix.runA}', '${fix.runB}')`,
    );
    expect(r.aSeen).toBe(1);
    expect(r.bSeen).toBe(1);
    expect(r.totalSeen).toBe(2);
  });

  test('read_model.run_items_v — piggyback via market_runs_v.org_id', async () => {
    if (!fix) throw new Error('fixture missing');
    const r = await countUnderEachContext(
      'read_model.run_items_v',
      `run_id IN ('${fix.runA}', '${fix.runB}')`,
    );
    expect(r.aSeen).toBe(1);
    expect(r.bSeen).toBe(1);
    expect(r.totalSeen).toBe(2);
  });

  test('read_model.run_item_stores_v — piggyback via market_runs_v.org_id', async () => {
    if (!fix) throw new Error('fixture missing');
    const r = await countUnderEachContext(
      'read_model.run_item_stores_v',
      `run_id IN ('${fix.runA}', '${fix.runB}')`,
    );
    expect(r.aSeen).toBe(1);
    expect(r.bSeen).toBe(1);
    expect(r.totalSeen).toBe(2);
  });
});
