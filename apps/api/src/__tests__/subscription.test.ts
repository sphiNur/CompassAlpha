/**
 * Subscription foundation: trial provisioning, plan limits, read-only
 * expiry and platform-admin plan changes.
 *
 * Skipped when DATABASE_URL is unset OR SKIP_PG_TESTS=1.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  getDb,
  provisionOrganization,
  schema as s,
  withOrgContext,
  withSystemContext,
} from '@compass/db';
import { logger } from '../infra/log';
import { appRouter } from '../trpc/router';
import type { RequestContext, SessionContext } from '../trpc/context';
import { assertCanAddStore, readSubscriptionState } from '../services/subscription';

const SHOULD_RUN = !!process.env.DATABASE_URL && process.env.SKIP_PG_TESTS !== '1';

function caller(session: SessionContext | null) {
  const db = getDb();
  const ctx: RequestContext = {
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
      return withOrgContext(db, session?.orgId ?? null, fn);
    },
  };
  return appRouter.createCaller(ctx);
}

describe.skipIf(!SHOULD_RUN)('subscriptions (PG-gated)', () => {
  let orgId = '';
  let memberId = '';
  let userId = '';

  beforeAll(async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    const [user] = await db
      .insert(s.users)
      .values({
        tgUserId: BigInt(7_000_000_000 + Math.floor(Math.random() * 2_000_000_000)),
        displayName: 'Subscription Owner',
        displayNameLocked: true,
      })
      .returning();
    userId = user!.id;
    await db.insert(s.platformAdmins).values({ userId, note: 'subscription test' });
    const created = await withSystemContext(db, 'auth', (tx) =>
      provisionOrganization(tx, {
        name: 'Subscription Test Org',
        slug: `subscription-${Math.random().toString(36).slice(2, 8)}`,
        ownerUserId: userId,
      }),
    );
    orgId = created.orgId;
    memberId = created.ownerMemberId!;
  });

  afterAll(async () => {
    if (!orgId) return;
    const db = getDb(undefined, { system: 'maintenance' });
    await db.delete(s.organizations).where(eq(s.organizations.id, orgId));
    await db.delete(s.users).where(eq(s.users.id, userId));
  });

  const session = (): SessionContext => ({
    userId,
    memberId,
    orgId,
    writeAccess: true,
    orgTimezone: 'UTC',
    permissions: new Set(['users.manage', 'org.admin']),
    roleSlugs: new Set(['admin']),
  });

  test('a new tenant receives a starter trial', async () => {
    const db = getDb();
    const state = await withOrgContext(db, orgId, (tx) => readSubscriptionState(tx, orgId));
    expect(state.planCode).toBe('starter');
    expect(state.status).toBe('trialing');
    expect(state.writeAccess).toBe(true);
    expect(state.limits).toEqual({ stores: 1, members: 10 });
    expect(state.trialEndsAt).toBeTruthy();
  });

  test('the plan store limit is enforced', async () => {
    const db = getDb();
    await withOrgContext(db, orgId, async (tx) => {
      await assertCanAddStore(tx, orgId);
      await tx
        .insert(s.stores)
        .values({ orgId, name: 'First', code: `S-${Date.now()}` })
        .onConflictDoNothing();
    });
    await expect(withOrgContext(db, orgId, (tx) => assertCanAddStore(tx, orgId))).rejects.toThrow(
      'subscription.errors.storeLimit',
    );
  });

  test('platform admin can change plan, suspend and restore access', async () => {
    const suspended = await caller(session()).platform.updateSubscription({
      orgId,
      planCode: 'growth',
      status: 'suspended',
      cancelAtPeriodEnd: false,
    });
    expect(suspended.planCode).toBe('growth');
    expect(suspended.status).toBe('suspended');
    expect(suspended.writeAccess).toBe(false);

    const db = getDb();
    const stored = await withOrgContext(db, orgId, (tx) =>
      tx.query.organizationSubscriptions.findFirst({
        where: (sub, { eq: eq2 }) => eq2(sub.orgId, orgId),
      }),
    );
    expect(stored?.planCode).toBe('growth');

    const active = await caller(session()).platform.updateSubscription({
      orgId,
      planCode: 'pro',
      status: 'active',
      cancelAtPeriodEnd: false,
    });
    expect(active.planCode).toBe('pro');
    expect(active.writeAccess).toBe(true);
  });

  test('a read-only tenant cannot add a store', async () => {
    const db = getDb();
    await withSystemContext(db, 'maintenance', (tx) =>
      tx
        .update(s.organizationSubscriptions)
        .set({ status: 'suspended' })
        .where(eq(s.organizationSubscriptions.orgId, orgId)),
    );
    await expect(withOrgContext(db, orgId, (tx) => assertCanAddStore(tx, orgId))).rejects.toThrow(
      'subscription.errors.readOnly',
    );

    const readOnlySession: SessionContext = { ...session(), writeAccess: false };
    await expect(
      caller(readOnlySession).admin.storeCreate({ name: 'Blocked store' }),
    ).rejects.toThrow('subscription.errors.readOnly');
  });
});
