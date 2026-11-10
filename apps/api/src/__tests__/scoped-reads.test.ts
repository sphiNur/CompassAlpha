/**
 * Reads scoped to the stores and permissions they need (2026-10-30
 * operation atlas: HIS-1, HIS-2, APR-4). Before the fix:
 *   - finance and order history used every ASSIGNED store, so a manager
 *     of A who is a cashier in B read B's purchases and submissions;
 *   - the approval queue and someone else's order detail were readable
 *     by staff and buyers of the store.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/scoped-reads.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { getDb, schema as s } from '@compass/db';
import { appRouter } from '../trpc/router';
import { SHOULD_RUN } from './helpers/pg';
import { callerFor } from './helpers/ctx';
import { seedRoles, seedMember, sessionOf } from './helpers/fixtures';

type Caller = ReturnType<typeof appRouter.createCaller>;
interface Fixture {
  storeA: string;
  storeB: string;
  /** Manager in A, cashier in B. */
  mixed: Caller;
  staffA: Caller;
  otherStaffA: Caller;
  submittedSessionId: string;
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
    .values({ slug: `scoped-${suffix}`, name: 'Scoped reads', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  const orgId = org!.id;

  const roleIds = await seedRoles(db, orgId, ['manager', 'cashier', 'staff']);
  const [a] = await db.insert(s.stores).values({ orgId, name: 'Store A', code: `A-${suffix.slice(-6)}` }).returning();
  const [b] = await db.insert(s.stores).values({ orgId, name: 'Store B', code: `B-${suffix.slice(-6)}` }).returning();
  const [sku] = await db
    .insert(s.skus)
    .values({ orgId, code: `SC-${suffix.slice(-8)}`, names: { en: 'Rice' }, unit: 'kg', step: '1' })
    .returning();

  let n = 0;
  const member = async (bindings: Array<[string, string]>) => {
    n += 1;
    const who = await seedMember(db, orgId, {
      name: `Scoped ${n}`,
      stores: bindings.map(([, storeId]) => storeId),
      roles: bindings.map(([slug, storeId]) => ({ roleId: roleIds[slug]!, storeId })),
    });
    return callerFor(await sessionOf(orgId, who));
  };

  const mixed = await member([['manager', a!.id], ['cashier', b!.id]]);
  const staffA = await member([['staff', a!.id]]);
  const otherStaffA = await member([['staff', a!.id]]);

  // A submitted order in A, waiting for approval.
  const draft = await staffA.order.adjustItem({ storeId: a!.id, skuId: sku!.id, qty: '2' });
  await staffA.order.submit({ sessionId: draft.sessionId });

  fix = { storeA: a!.id, storeB: b!.id, mixed, staffA, otherStaffA, submittedSessionId: draft.sessionId };
});

describe.skipIf(!SHOULD_RUN)('reads scoped to permitted stores (PG-gated)', () => {
  const range = { startDate: '2026-01-01', endDate: '2026-12-31' };

  test('HIS-1: finance for a store where the reader is only a cashier is refused', async () => {
    const err = await errorOf(() => fix!.mixed.report.totals({ ...range, storeId: fix!.storeB }));
    expect(err?.code).toBe('FORBIDDEN');
    expect(await errorOf(() => fix!.mixed.report.totals({ ...range, storeId: fix!.storeA }))).toBeNull();
    const lines = await errorOf(() => fix!.mixed.report.purchaseLines({ ...range, storeId: fix!.storeB }));
    expect(lines?.code).toBe('FORBIDDEN');
  });

  test('HIS-2: order history for that store is refused, and unfiltered history stays in A', async () => {
    const err = await errorOf(() => fix!.mixed.admin.submissionHistory({ storeId: fix!.storeB }));
    expect(err?.code).toBe('FORBIDDEN');
    const rows = (await fix!.mixed.admin.submissionHistory({})) as unknown as Array<{ storeId?: string; store_id?: string }>;
    const list = Array.isArray(rows) ? rows : ((rows as { items?: typeof rows }).items ?? []);
    for (const r of list) expect(r.storeId ?? r.store_id).not.toBe(fix!.storeB);
  });

  test('APR-4: staff do not read the approval queue; the store manager does', async () => {
    expect(await fix!.staffA.order.pendingList({})).toHaveLength(0);
    const queue = await fix!.mixed.order.pendingList({});
    expect(queue.map((q: { id: string }) => q.id)).toContain(fix!.submittedSessionId);
  });

  test("APR-4: someone else's order detail is for approvers; one's own stays readable", async () => {
    const err = await errorOf(() => fix!.otherStaffA.order.sessionDetail({ sessionId: fix!.submittedSessionId }));
    expect(err?.code).toBe('FORBIDDEN');
    expect(await errorOf(() => fix!.staffA.order.sessionDetail({ sessionId: fix!.submittedSessionId }))).toBeNull();
    expect(await errorOf(() => fix!.mixed.order.sessionDetail({ sessionId: fix!.submittedSessionId }))).toBeNull();
  });
});
