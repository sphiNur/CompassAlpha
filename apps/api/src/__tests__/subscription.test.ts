/**
 * Subscription foundation: trial provisioning, plan limits, read-only
 * expiry and platform-admin plan changes.
 *
 * Review TEST2-11 (2026-11-09): "read-only expiry" was listed here but
 * only a suspended status was tested. The trial's end, its grace period
 * and a paid period's end are now covered: through the database, and at
 * the exact moment in computeWriteAccess.
 *
 * The PG half is skipped when DATABASE_URL is unset OR SKIP_PG_TESTS=1.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  DEFAULT_GRACE_DAYS,
  DEFAULT_TRIAL_DAYS,
  getDb,
  provisionOrganization,
  schema as s,
  withOrgContext,
  withSystemContext,
} from '@compass/db';
import type { SessionContext } from '../trpc/context';
import {
  assertCanAddStore,
  computeWriteAccess,
  readSubscriptionState,
} from '../services/subscription';
import { SHOULD_RUN } from './helpers/pg';
import { freshTgId } from './helpers/telegram';
import { callerFor } from './helpers/ctx';

const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!SHOULD_RUN)('subscriptions (PG-gated)', () => {
  let userId = '';
  const orgIds: string[] = [];

  beforeAll(async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    const [user] = await db
      .insert(s.users)
      .values({
        tgUserId: freshTgId(),
        displayName: 'Subscription Owner',
        displayNameLocked: true,
      })
      .returning();
    userId = user!.id;
    await db.insert(s.platformAdmins).values({ userId, note: 'subscription test' });
  });

  afterAll(async () => {
    if (!userId) return;
    const db = getDb(undefined, { system: 'maintenance' });
    for (const id of orgIds) await db.delete(s.organizations).where(eq(s.organizations.id, id));
    await db.delete(s.users).where(eq(s.users.id, userId));
  });

  /**
   * A tenant of the test's own, as sign-up makes one, owned by the platform
   * admin (review TEST2-09). The tests change its plan and status, and
   * used to share one, so each depended on what the one before had left.
   */
  async function newTenant(): Promise<{ orgId: string; session: SessionContext }> {
    const db = getDb(undefined, { system: 'maintenance' });
    const created = await withSystemContext(db, 'auth', (tx) =>
      provisionOrganization(tx, {
        name: 'Subscription Test Org',
        slug: `subscription-${Math.random().toString(36).slice(2, 8)}`,
        ownerUserId: userId,
      }),
    );
    orgIds.push(created.orgId);
    return {
      orgId: created.orgId,
      session: {
        userId,
        memberId: created.ownerMemberId!,
        orgId: created.orgId,
        writeAccess: true,
        orgTimezone: 'UTC',
        permissions: new Set(['users.manage', 'org.admin']),
        roleSlugs: new Set(['admin']),
      },
    };
  }

  test('a new tenant receives a starter trial', async () => {
    const { orgId } = await newTenant();
    const db = getDb();
    const state = await withOrgContext(db, orgId, (tx) => readSubscriptionState(tx, orgId));
    expect(state.planCode).toBe('starter');
    expect(state.status).toBe('trialing');
    expect(state.writeAccess).toBe(true);
    expect(state.limits).toEqual({ stores: 1, members: 10 });
    // The trial runs DEFAULT_TRIAL_DAYS from now, and its grace period
    // DEFAULT_GRACE_DAYS after that.
    const trialEnds = Date.parse(state.trialEndsAt!);
    expect(Math.abs(trialEnds - (Date.now() + DEFAULT_TRIAL_DAYS * DAY))).toBeLessThan(60_000);
    expect(Date.parse(state.graceEndsAt!) - trialEnds).toBe(DEFAULT_GRACE_DAYS * DAY);
  });

  test('the plan store limit is enforced', async () => {
    const { orgId } = await newTenant();
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
    const { orgId, session } = await newTenant();
    const suspended = await callerFor(session).platform.updateSubscription({
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

    const active = await callerFor(session).platform.updateSubscription({
      orgId,
      planCode: 'pro',
      status: 'active',
      cancelAtPeriodEnd: false,
    });
    expect(active.planCode).toBe('pro');
    expect(active.writeAccess).toBe(true);
  });

  test('a read-only tenant cannot add a store', async () => {
    const { orgId, session } = await newTenant();
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

    const readOnlySession: SessionContext = { ...session, writeAccess: false };
    await expect(
      callerFor(readOnlySession).admin.storeCreate({ name: 'Blocked store' }),
    ).rejects.toThrow('subscription.errors.readOnly');
  });

  test('a trial that has ended turns read-only once its grace runs out', async () => {
    const { orgId } = await newTenant();
    const db = getDb();
    const now = Date.now();
    const setTrial = (trialEndsAt: Date, graceEndsAt: Date | null) =>
      withSystemContext(db, 'maintenance', (tx) =>
        tx
          .update(s.organizationSubscriptions)
          .set({ status: 'trialing', trialEndsAt, graceEndsAt })
          .where(eq(s.organizationSubscriptions.orgId, orgId)),
      );
    const writeAccess = async () =>
      (await withOrgContext(db, orgId, (tx) => readSubscriptionState(tx, orgId))).writeAccess;

    // Ended yesterday, in grace until tomorrow: still writable.
    await setTrial(new Date(now - DAY), new Date(now + DAY));
    expect(await writeAccess()).toBe(true);

    // The grace ran out a second ago: read-only, and nothing can be added.
    await setTrial(new Date(now - 8 * DAY), new Date(now - 1000));
    expect(await writeAccess()).toBe(false);
    await expect(withOrgContext(db, orgId, (tx) => assertCanAddStore(tx, orgId))).rejects.toThrow(
      'subscription.errors.readOnly',
    );

    // Without a grace period, the trial's own end decides.
    await setTrial(new Date(now - 1000), null);
    expect(await writeAccess()).toBe(false);
    await setTrial(new Date(now + 60_000), null);
    expect(await writeAccess()).toBe(true);
  });
});

describe('write access at the moment a date passes', () => {
  const now = Date.parse('2026-11-09T12:00:00Z');
  const at = (ms: number) => new Date(now + ms);

  test('a trial is writable up to, not including, its end', () => {
    expect(computeWriteAccess('trialing', at(1), null, null, now)).toBe(true);
    expect(computeWriteAccess('trialing', at(0), null, null, now)).toBe(false);
    expect(computeWriteAccess('trialing', at(-1), null, null, now)).toBe(false);
    expect(computeWriteAccess('trialing', null, null, null, now)).toBe(true);
  });

  test('a grace period keeps any status but suspended and canceled writable, to its end', () => {
    for (const status of ['trialing', 'active', 'past_due']) {
      expect([status, computeWriteAccess(status, at(-DAY), at(-DAY), at(1), now)]).toEqual([
        status,
        true,
      ]);
      expect([status, computeWriteAccess(status, at(-DAY), at(-DAY), at(0), now)]).toEqual([
        status,
        false,
      ]);
    }
  });

  test('a paid period ends the same way', () => {
    expect(computeWriteAccess('active', null, at(1), null, now)).toBe(true);
    expect(computeWriteAccess('active', null, at(0), null, now)).toBe(false);
    expect(computeWriteAccess('active', null, null, null, now)).toBe(true);
  });

  test('suspended and canceled are read-only whatever the dates', () => {
    for (const status of ['suspended', 'canceled']) {
      expect([status, computeWriteAccess(status, at(DAY), at(DAY), at(DAY), now)]).toEqual([
        status,
        false,
      ]);
    }
  });
});
