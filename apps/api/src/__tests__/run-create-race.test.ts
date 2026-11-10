/**
 * Review RUNAPI-04 (2026-11-09): two run.create calls at once.
 *
 * The RunPlanned projection inserted market_runs_v with a bare
 * `onConflictDoNothing()`, which also skipped a conflict on the
 * one-live-run-per-organisation index. The loser's row was silently not
 * written, its item insert then failed the foreign key, and the caller got
 * a 500 instead of the run that won. Here the winner is an uncommitted
 * planned run held open in another transaction, so the race is the same
 * every time: run.create waits on the index, the winner commits, and the
 * loser must come back with the winner's run.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/run-create-race.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb, schema as s } from '@compass/db';
import { appRouter } from '../trpc/router';
import { loadSession } from '../trpc/context';
import { SHOULD_RUN } from './helpers/pg';
import { freshTgId } from './helpers/telegram';
import { callerFor } from './helpers/ctx';

const HERE = dirname(fileURLToPath(import.meta.url));
type SeedData = {
  BUILTIN_ROLES: readonly { slug: string; rank: number; permissions: readonly string[] }[];
};
const seedDataPath = resolve(HERE, '../../../../packages/db/src/seed-data.ts');
const { BUILTIN_ROLES } = (await import(seedDataPath)) as SeedData;

type Caller = ReturnType<typeof appRouter.createCaller>;
let fix: { orgId: string; storeId: string; skuId: string; a: Caller; b: Caller } | null = null;

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug: `race-${suffix}`, name: 'Run race', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  const orgId = org!.id;
  const def = BUILTIN_ROLES.find((r) => r.slug === 'super_admin')!;
  const [role] = await db
    .insert(s.roles)
    .values({ orgId, slug: 'super_admin', name: 'super_admin', rank: def.rank, isBuiltIn: true })
    .returning();
  for (const key of def.permissions) {
    await db.insert(s.permissions).values({ key, description: key }).onConflictDoNothing();
    await db
      .insert(s.rolePermissions)
      .values({ roleId: role!.id, permissionKey: key })
      .onConflictDoNothing();
  }
  const [store] = await db
    .insert(s.stores)
    .values({ orgId, name: 'Store', code: `RC-${suffix.slice(-6)}` })
    .returning();
  const [sku] = await db
    .insert(s.skus)
    .values({
      orgId,
      code: `Rice-${suffix.slice(-8)}`,
      names: { en: 'Rice' },
      unit: 'kg',
      step: '1',
    })
    .returning();
  let n = 0;
  const person = async (): Promise<Caller> => {
    n += 1;
    const [u] = await db
      .insert(s.users)
      .values({ displayName: `Race ${n}`, tgUserId: freshTgId() })
      .returning();
    const [m] = await db
      .insert(s.members)
      .values({ orgId, userId: u!.id, status: 'active' })
      .returning();
    await db
      .insert(s.memberStoreAssignments)
      .values({ memberId: m!.id, storeId: store!.id, assignedBy: u!.id });
    await db
      .insert(s.memberRoleBindings)
      .values({ memberId: m!.id, roleId: role!.id, scopeType: 'global' });
    const session = await loadSession(db, u!.id, orgId, m!.id);
    if (!session) throw new Error('session failed to load');
    return callerFor(session);
  };
  fix = { orgId, storeId: store!.id, skuId: sku!.id, a: await person(), b: await person() };
});

describe.skipIf(!SHOULD_RUN)('run.create race (PG-gated)', () => {
  test('the loser of a race for the live run gets the run that won, not a 500', async () => {
    const { orgId, storeId, skuId, a, b } = fix!;
    const draft = await a.order.adjustItem({ storeId, skuId, qty: '2' });
    await a.order.submit({ sessionId: draft.sessionId });
    await b.order.claim({ sessionId: draft.sessionId });
    await b.order.approve({ sessionId: draft.sessionId });

    const db = getDb(undefined, { system: 'maintenance' });
    const winnerId = randomUUID();
    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });
    let inserted!: () => void;
    const held = new Promise<void>((r) => {
      inserted = r;
    });
    // The winner: a planned run, not committed yet.
    const holder = db.transaction(async (tx) => {
      await tx.insert(s.marketRunsV).values({
        id: winnerId,
        orgId,
        runDate: new Date().toISOString().slice(0, 10),
        runIndex: 99,
        status: 'planned',
        lastSeq: 1,
      });
      inserted();
      await released;
    });
    await held;

    const creating = a.run.create({ sessionIds: [draft.sessionId] });
    // Wait until run.create is blocked on the winner's row.
    for (let i = 0; i < 100; i += 1) {
      const rows = (await db.execute(sql`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
      `)) as unknown as Array<{ n: number }>;
      if ((rows[0]?.n ?? 0) > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    release();
    await holder;

    const result = await creating;
    expect(result.reused).toBe(true);
    expect(result.runId).toBe(winnerId);

    await db.delete(s.marketRunsV).where(sql`${s.marketRunsV.id} = ${winnerId}`);
  });
});
