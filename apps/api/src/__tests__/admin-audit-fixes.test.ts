/**
 * Regression tests for the 2026-10-21 audit fixes in the admin / platform
 * routers (CA-18, CA-28, CA-39, CA-40, A-23).
 *
 * The first block is pure (no database). The second is PG-gated and
 * skipped when DATABASE_URL is unset OR SKIP_PG_TESTS=1; each of its
 * tests provisions a starter-plan tenant of its own (1 store, 10 members).
 */
import { describe, expect, test } from 'bun:test';
import { TRPCError } from '@trpc/server';
import { PgDialect } from 'drizzle-orm/pg-core';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema as s } from '@compass/db';
import { GrantRoleInputSchema } from '@compass/contracts';
import {
  inviteWithinScope,
  outboxOfOrg,
  outboxOfStreams,
  runMovements,
  runTouchesStores,
  withUniqueKey,
} from '../trpc/routers/admin';
import { inviterCoversInvite } from '../services/adminAuthority';
import { SHOULD_RUN } from './helpers/pg';
import { callerFor, gateCaller } from './helpers/ctx';
import { seedMember } from './helpers/fixtures';
import { tenantSuite } from './helpers/tenants';
import { codeOf, errorOf } from './helpers/errors';

const ORG = '00000000-0000-4000-8000-000000000003';
const RUN = '00000000-0000-4000-8000-0000000000aa';
const SESSION = '00000000-0000-4000-8000-0000000000bb';

describe('grantRole.expiresAt contract (A-23)', () => {
  const base = { userId: ORG, roleSlug: 'staff', scopeType: 'store' as const, scopeId: ORG };

  test('rejects a non-ISO string', () => {
    expect(GrantRoleInputSchema.safeParse({ ...base, expiresAt: 'tomorrow' }).success).toBe(false);
  });

  test('rejects an instant in the past', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(GrantRoleInputSchema.safeParse({ ...base, expiresAt: past }).success).toBe(false);
  });

  test('accepts a future ISO datetime and omission', () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(GrantRoleInputSchema.safeParse({ ...base, expiresAt: future }).success).toBe(true);
    expect(GrantRoleInputSchema.safeParse(base).success).toBe(true);
  });

  test('the router answers BAD_REQUEST before touching the database', async () => {
    const caller = gateCaller({
      userId: '00000000-0000-4000-8000-000000000001',
      memberId: '00000000-0000-4000-8000-000000000002',
      orgId: ORG,
      orgTimezone: 'UTC',
      permissions: new Set(['users.manage', 'org.admin']),
      roleSlugs: new Set(),
    });
    const grant = () => caller.admin.grantRole({ ...base, expiresAt: 'not-a-date' });
    expect(await codeOf(grant)).toBe('BAD_REQUEST');
  });
});

describe('withUniqueKey (CA-40)', () => {
  test('maps a wrapped 23505 to a CONFLICT with the given key', async () => {
    const driverError = Object.assign(new Error('duplicate key'), { code: '23505' });
    const wrapped = Object.assign(new Error('insert into ...'), { cause: driverError });
    let caught: unknown;
    try {
      await withUniqueKey(Promise.reject(wrapped), 'admin.errors.slugTaken');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe('CONFLICT');
    expect((caught as TRPCError).message).toBe('admin.errors.slugTaken');
  });

  test('rethrows other errors untouched and passes values through', async () => {
    const other = Object.assign(new Error('fk'), { code: '23503' });
    await expect(withUniqueKey(Promise.reject(other), 'admin.errors.codeTaken')).rejects.toBe(
      other,
    );
    expect(await withUniqueKey(Promise.resolve(42), 'admin.errors.codeTaken')).toBe(42);
  });
});

describe('purge predicates (CA-28)', () => {
  const dialect = new PgDialect();
  const render = (q: Parameters<PgDialect['sqlToQuery']>[0]) => dialect.sqlToQuery(q);

  test('org outbox match includes notification rows keyed by payload orgId', () => {
    const q = render(outboxOfOrg(ORG));
    expect(q.sql).toContain("aggregate = 'notification'");
    expect(q.sql).toContain("payload->>'orgId'");
    expect(q.params).toEqual([ORG, ORG]);
  });

  test('stream outbox match covers payload.extra sessionId / runId', () => {
    const q = render(outboxOfStreams(ORG, [RUN, SESSION]));
    expect(q.sql).toContain("payload->'extra'->>'sessionId'");
    expect(q.sql).toContain("payload->'extra'->>'runId'");
    expect(q.params).toContain(RUN);
    expect(q.params).toContain(SESSION);
  });

  test('run movements predicate is org + run scoped', () => {
    const q = render(runMovements(ORG, [RUN]));
    expect(q.sql).toContain("source_type IN ('run', 'run_amend')");
    expect(q.params).toEqual([ORG, RUN]);
  });

  test('empty id lists match nothing', () => {
    expect(render(outboxOfStreams(ORG, [])).sql).toBe('false');
    expect(render(runMovements(ORG, [])).sql).toBe('false');
  });
});

describe('admin read scope + invite reach (CA-17, CA-19)', () => {
  const A = '00000000-0000-4000-8000-00000000000a';
  const B = '00000000-0000-4000-8000-00000000000b';

  test('org admins see every invite; store admins only invites inside their stores', () => {
    expect(inviteWithinScope([A, B], null)).toBe(true);
    expect(inviteWithinScope([], null)).toBe(true);
    expect(inviteWithinScope([A], new Set([A]))).toBe(true);
    expect(inviteWithinScope([A, B], new Set([A]))).toBe(false);
    // A store-less invite is an org-tier (admin) invite.
    expect(inviteWithinScope([], new Set([A, B]))).toBe(false);
  });

  test('an inviter must still be active, hold users.manage and cover the stores', () => {
    const base = {
      active: true,
      hasUsersManage: true,
      isGlobalAdmin: false,
      adminStoreIds: new Set([A]),
    };
    expect(inviterCoversInvite(base, [A])).toBe(true);
    expect(inviterCoversInvite(null, [A])).toBe(false);
    expect(inviterCoversInvite({ ...base, active: false }, [A])).toBe(false);
    expect(inviterCoversInvite({ ...base, hasUsersManage: false }, [A])).toBe(false);
    expect(inviterCoversInvite(base, [A, B])).toBe(false);
    expect(inviterCoversInvite(base, [])).toBe(false);
    expect(inviterCoversInvite({ ...base, isGlobalAdmin: true }, [])).toBe(true);
    expect(inviterCoversInvite({ ...base, isGlobalAdmin: true, active: false }, [])).toBe(false);
  });

  test('run-touches-stores predicate checks attached orders and per-store splits', () => {
    const dialect = new PgDialect();
    const q = dialect.sqlToQuery(runTouchesStores(sql`r.id`, [A, B]));
    expect(q.sql).toContain('read_model.order_sessions_v');
    expect(q.sql).toContain('read_model.run_item_stores_v');
    expect(q.params).toEqual([A, B, A, B]);
    expect(dialect.sqlToQuery(runTouchesStores(sql`r.id`, [])).sql).toBe('false');
  });
});

// ---------- PG-gated: limits + platform subscription ----------------------

/** The message of what `run` threw; undefined if it succeeded. */
async function errorMessage(run: () => Promise<unknown>): Promise<string | undefined> {
  return (await errorOf(run))?.message;
}

describe.skipIf(!SHOULD_RUN)('plan limits and platform subscription (PG-gated)', () => {
  const { newTenant, track } = tenantSuite('Audit Fix Test Org');

  test('reactivating a paused store respects the store limit', async () => {
    const { orgId, session } = await newTenant();
    const db = getDb(undefined, { system: 'maintenance' });
    await db.insert(s.stores).values({ orgId, name: 'Active', code: `A-${Date.now()}` });
    const [paused] = await db
      .insert(s.stores)
      .values({ orgId, name: 'Paused', code: `P-${Date.now()}`, isActive: false })
      .returning();
    expect(
      await errorMessage(() =>
        callerFor(session).admin.storeUpdate({ storeId: paused!.id, isActive: true }),
      ),
    ).toBe('subscription.errors.storeLimit');
    // A non-isActive edit of the paused store is now reachable for an org admin.
    await callerFor(session).admin.storeUpdate({ storeId: paused!.id, name: 'Paused (renamed)' });
  });

  test('reactivating a suspended member respects the member limit', async () => {
    const { orgId, session } = await newTenant();
    const db = getDb(undefined, { system: 'maintenance' });
    const addMember = async (status: 'active' | 'suspended'): Promise<string> => {
      const who = await seedMember(db, orgId, { name: `Seat ${status}`, status });
      track(who.userId);
      return who.memberId;
    };
    // Owner + 9 = 10 active members: the starter plan is full.
    for (let i = 0; i < 9; i += 1) await addMember('active');
    const suspended = await addMember('suspended');
    expect(
      await errorMessage(() =>
        callerFor(session).admin.memberSetStatus({ memberId: suspended, status: 'active' }),
      ),
    ).toBe('subscription.errors.memberLimit');
  });

  test('updateSubscription keeps fields it was not given', async () => {
    const { orgId, session } = await newTenant();
    const db = getDb(undefined, { system: 'maintenance' });
    const periodStart = new Date('2026-01-01T00:00:00.000Z');
    await db
      .update(s.organizationSubscriptions)
      .set({ note: 'keep me', currentPeriodStart: periodStart, cancelAtPeriodEnd: true })
      .where(eq(s.organizationSubscriptions.orgId, orgId));

    await callerFor(session).platform.updateSubscription({
      orgId,
      planCode: 'growth',
      status: 'active',
    });
    const row = await db.query.organizationSubscriptions.findFirst({
      where: (sub, { eq: eq2 }) => eq2(sub.orgId, orgId),
    });
    expect(row?.planCode).toBe('growth');
    expect(row?.note).toBe('keep me');
    expect(row?.currentPeriodStart?.toISOString()).toBe(periodStart.toISOString());
    expect(row?.cancelAtPeriodEnd).toBe(true);

    // Explicit null still clears.
    await callerFor(session).platform.updateSubscription({
      orgId,
      planCode: 'growth',
      status: 'active',
      note: null,
    });
    const cleared = await db.query.organizationSubscriptions.findFirst({
      where: (sub, { eq: eq2 }) => eq2(sub.orgId, orgId),
    });
    expect(cleared?.note).toBeNull();

    const audit = await db.query.policyDecisions.findMany({
      where: (pd, { and: and2, eq: eq2 }) =>
        and2(eq2(pd.orgId, orgId), eq2(pd.action, 'platform.subscription.update')),
    });
    expect(audit.length).toBe(2);
  });

  test('RE-AUTH-3: a subscription date in year 0000 or a loose "2026-1-5" is refused', async () => {
    const { orgId, session } = await newTenant();
    const base = { orgId, planCode: 'growth', status: 'active' as const };
    for (const bad of ['0000-01-01', '2026-1-5', '2026-02-30', 'tomorrow', '2026-10-31T10:00']) {
      expect(
        await errorMessage(() =>
          callerFor(session).platform.updateSubscription({ ...base, currentPeriodEnd: bad }),
        ),
      ).toBe('platform.errors.invalidDate');
    }
    await callerFor(session).platform.updateSubscription({
      ...base,
      currentPeriodEnd: '2026-12-31T10:00:00.000Z',
    });
  });

  test("ADM1-32: a bare day is a day of the workspace's calendar", async () => {
    const { orgId, session } = await newTenant();
    const db = getDb(undefined, { system: 'maintenance' });
    await db
      .update(s.organizations)
      .set({ timezone: 'Asia/Tashkent' })
      .where(eq(s.organizations.id, orgId));
    const listed = await callerFor(session).platform.organizations();
    expect(listed.find((o) => o.orgId === orgId)?.timezone).toBe('Asia/Tashkent');

    await callerFor(session).platform.updateSubscription({
      orgId,
      planCode: 'growth',
      status: 'active',
      currentPeriodStart: '2026-12-01',
      currentPeriodEnd: '2026-12-31',
      graceEndsAt: '2027-01-07',
    });
    const row = await db.query.organizationSubscriptions.findFirst({
      where: (sub, { eq: eq2 }) => eq2(sub.orgId, orgId),
    });
    // Tashkent is UTC+5: a start is its midnight, an end the last instant.
    expect(row?.currentPeriodStart?.toISOString()).toBe('2026-11-30T19:00:00.000Z');
    expect(row?.currentPeriodEnd?.toISOString()).toBe('2026-12-31T18:59:59.999Z');
    expect(row?.graceEndsAt?.toISOString()).toBe('2027-01-07T18:59:59.999Z');
  });
});
