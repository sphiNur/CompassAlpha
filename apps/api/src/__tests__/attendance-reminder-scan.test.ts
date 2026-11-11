/**
 * One bad shift does not silence everyone else's reminders (COREAPI-13,
 * 2026-11-09). The scan walks the shifts of every organisation in one
 * loop; a row that threw (here: an organisation saved with a time zone
 * that does not exist, as rows from before input validation can be)
 * ended the scan, so no one later in the list was reminded.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/attendance-reminder-scan.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { getDb, schema as s } from '@compass/db';
import { scanAttendanceReminders } from '../services/attendanceReminders';
import { SHOULD_RUN } from './helpers/pg';
import { freshTgId } from './helpers/telegram';
import { cleanUpAfterAll, noteOrg, noteUser } from './helpers/cleanup';

cleanUpAfterAll();

type Db = ReturnType<typeof getDb>;

/**
 * A Telegram id no other test file hands out: theirs stay below 10^12
 * (a time-based id cut to 12 digits collided with one of them in CI).
 */
/** An organisation with one member whose shift began 40 minutes ago. */
async function lateShift(db: Db, timezone: string, now: Date) {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug: `remind-${suffix}`, name: 'Remind', localeDefault: 'en', timezone })
    .returning();
  noteOrg(org!.id);
  const [store] = await db
    .insert(s.stores)
    .values({ orgId: org!.id, name: 'Store', code: `RM-${suffix.slice(-8)}` })
    .returning();
  const [user] = await db
    .insert(s.users)
    .values({ displayName: 'Late', tgUserId: freshTgId() })
    .returning();
  noteUser(user!.id);
  const [member] = await db
    .insert(s.members)
    .values({ orgId: org!.id, userId: user!.id, status: 'active' })
    .returning();
  await db
    .insert(s.permissions)
    .values({ key: 'attendance.clock', description: 'attendance.clock' })
    .onConflictDoNothing();
  await db.insert(s.memberPermissionOverrides).values({
    memberId: member!.id,
    permissionKey: 'attendance.clock',
    effect: 'allow',
    scopeType: 'global',
  });
  const [shift] = await db
    .insert(s.attendanceShifts)
    .values({
      orgId: org!.id,
      storeId: store!.id,
      memberId: member!.id,
      shiftDate: now.toISOString().slice(0, 10),
      startsAt: new Date(now.getTime() - 40 * 60_000),
      endsAt: new Date(now.getTime() + 4 * 3600_000),
    })
    .returning();
  return { orgId: org!.id, userId: user!.id, shiftId: shift!.id };
}

describe.skipIf(!SHOULD_RUN)('attendance reminder scan', () => {
  test('a shift that fails is reported and the others are still reminded', async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    const now = new Date();
    const broken = await lateShift(db, 'Mars/Olympus_Mons', now);
    const fine = await lateShift(db, 'Asia/Tashkent', now);
    const failed: string[] = [];
    try {
      await scanAttendanceReminders(db, now, { onShiftError: (shiftId) => failed.push(shiftId) });
    } finally {
      // Other files scan the same database.
      await db.delete(s.attendanceShifts).where(eq(s.attendanceShifts.id, broken.shiftId));
    }
    expect(failed).toContain(broken.shiftId);
    expect(failed).not.toContain(fine.shiftId);
    const reminded = await db
      .select({ to: s.notifications.recipientUserId })
      .from(s.notifications)
      .where(
        and(
          eq(s.notifications.orgId, fine.orgId),
          eq(s.notifications.template, 'attendance.remindIn'),
          eq(s.notifications.channel, 'bot'),
        ),
      );
    expect(reminded.map((r) => r.to)).toEqual([fine.userId]);
  });
});
