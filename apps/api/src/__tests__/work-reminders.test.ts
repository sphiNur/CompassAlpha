/**
 * Bot reminders for waiting work (UI overhaul E2, 2026-11-15): orders an
 * hour without review, and no daily close by 22:00 store time.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/work-reminders.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb, schema as s } from '@compass/db';
import { scanMissingCloseReminders, scanPendingReviewReminders } from '../services/workReminders';
import { SHOULD_RUN } from './helpers/pg';
import { freshTgId } from './helpers/telegram';
import { cleanUpAfterAll, noteOrg, noteUser } from './helpers/cleanup';

cleanUpAfterAll();

type Db = ReturnType<typeof getDb>;

/** An organisation in UTC with one store and one member holding `key` there. */
async function storeWithHolder(db: Db, key: 'order.approve' | 'settlement.record') {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug: `work-${suffix}`, name: 'Work', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  noteOrg(org!.id);
  const [store] = await db
    .insert(s.stores)
    .values({ orgId: org!.id, name: 'Store', code: `WR-${suffix.slice(-8)}` })
    .returning();
  const [user] = await db
    .insert(s.users)
    .values({ displayName: 'Holder', tgUserId: freshTgId() })
    .returning();
  noteUser(user!.id);
  const [member] = await db
    .insert(s.members)
    .values({ orgId: org!.id, userId: user!.id, status: 'active' })
    .returning();
  await db.insert(s.permissions).values({ key, description: key }).onConflictDoNothing();
  await db.insert(s.memberPermissionOverrides).values({
    memberId: member!.id,
    permissionKey: key,
    effect: 'allow',
    scopeType: 'global',
  });
  return { orgId: org!.id, storeId: store!.id, userId: user!.id };
}

async function botMessages(db: Db, orgId: string, template: string) {
  return db
    .select({ to: s.notifications.recipientUserId })
    .from(s.notifications)
    .where(
      and(
        eq(s.notifications.orgId, orgId),
        eq(s.notifications.template, template),
        eq(s.notifications.channel, 'bot'),
      ),
    );
}

describe.skipIf(!SHOULD_RUN)('work reminders', () => {
  test('orders an hour without review remind the reviewers once', async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    const now = new Date();
    const at = await storeWithHolder(db, 'order.approve');
    const session = (minutesAgo: number, status = 'submitted') => ({
      id: randomUUID(),
      orgId: at.orgId,
      storeId: at.storeId,
      orderDate: now.toISOString().slice(0, 10),
      status,
      submittedAt: new Date(now.getTime() - minutesAgo * 60_000),
    });
    // Too fresh, and already reviewed: neither counts on its own.
    await db.insert(s.orderSessionsV).values([session(20), session(120, 'approved')]);
    await scanPendingReviewReminders(db, now);
    expect(await botMessages(db, at.orgId, 'order.reviewWaiting')).toEqual([]);

    await db.insert(s.orderSessionsV).values([session(90), session(75)]);
    await scanPendingReviewReminders(db, now);
    await scanPendingReviewReminders(db, now);
    expect((await botMessages(db, at.orgId, 'order.reviewWaiting')).map((r) => r.to)).toEqual([
      at.userId,
    ]);
  });

  test('no close by 22:00 reminds the recorders, only in stores that do closes', async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    const doesCloses = await storeWithHolder(db, 'settlement.record');
    const neverCloses = await storeWithHolder(db, 'settlement.record');
    const evening = new Date('2026-11-14T22:30:00Z');
    await db.insert(s.storeDailySettlements).values({
      orgId: doesCloses.orgId,
      storeId: doesCloses.storeId,
      settlementDate: '2026-11-12',
    });

    await scanMissingCloseReminders(db, new Date('2026-11-14T21:00:00Z'));
    expect(await botMessages(db, doesCloses.orgId, 'settlement.closeMissing')).toEqual([]);

    await scanMissingCloseReminders(db, evening);
    await scanMissingCloseReminders(db, evening);
    expect(
      (await botMessages(db, doesCloses.orgId, 'settlement.closeMissing')).map((r) => r.to),
    ).toEqual([doesCloses.userId]);
    expect(await botMessages(db, neverCloses.orgId, 'settlement.closeMissing')).toEqual([]);

    // Filed the next day: no reminder that evening.
    await db.insert(s.storeDailySettlements).values({
      orgId: doesCloses.orgId,
      storeId: doesCloses.storeId,
      settlementDate: '2026-11-15',
    });
    await scanMissingCloseReminders(db, new Date('2026-11-15T22:30:00Z'));
    expect(await botMessages(db, doesCloses.orgId, 'settlement.closeMissing')).toHaveLength(1);
  });
});
