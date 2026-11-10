/**
 * Reminders: a missed clock-in reminds the person, then the managers.
 * attendance-reminder-scan.test.ts checks that one bad shift does not stop
 * the scan.
 *
 * Each test gets a workspace of its own (helpers/attendance.ts). Split out
 * of attendance.test.ts by theme (review TEST1-17, 2026-11).
 *
 * Skipped when DATABASE_URL is unset or SKIP_PG_TESTS=1.
 */
import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { getDb, schema as s } from '@compass/db';
import { todayInTz } from '@compass/domain';
import { scanAttendanceReminders } from '../services/attendanceReminders';
import { SHOULD_RUN } from './helpers/pg';
import { attendanceSuite, fixture, TZ } from './helpers/attendance';

attendanceSuite();

describe.skipIf(!SHOULD_RUN)('attendance reminders', () => {
  test('missed clock-in reminds the person, then the managers, once each', async () => {
    const f = fixture();
    const db = getDb(undefined, { system: 'maintenance' });
    await f.manager.attendance.memberSet({
      storeId: f.storeId,
      memberId: f.staffId,
      enabled: true,
    });
    const now = new Date();
    // A shift that began 40 minutes ago, and no clock-in.
    await db.insert(s.attendanceShifts).values({
      orgId: f.orgId,
      storeId: f.storeId,
      memberId: f.staffId,
      shiftDate: todayInTz(TZ, now),
      startsAt: new Date(now.getTime() - 40 * 60_000),
      endsAt: new Date(now.getTime() + 4 * 3600_000),
    });
    await scanAttendanceReminders(db, now);
    await scanAttendanceReminders(db, now);
    const rows = await db
      .select({
        to: s.notifications.recipientUserId,
        template: s.notifications.template,
        title: s.notifications.title,
      })
      .from(s.notifications)
      .where(and(eq(s.notifications.orgId, f.orgId), eq(s.notifications.channel, 'bot')));
    expect(rows.filter((r) => r.template === 'attendance.remindIn').map((r) => r.to)).toEqual([
      f.staffUserId,
    ]);
    expect(rows.filter((r) => r.template === 'attendance.absent').map((r) => r.to)).toEqual([
      f.managerUserId,
    ]);
    expect(rows.find((r) => r.template === 'attendance.absent')!.title).toBe('Not clocked in');
  });
});
