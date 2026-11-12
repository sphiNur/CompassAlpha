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
import {
  attendanceSuite,
  fixture,
  botRecipients,
  expectError,
  switchOn,
  TZ,
} from './helpers/attendance';

attendanceSuite();

describe.skipIf(!SHOULD_RUN)('attendance reminders', () => {
  test('missed clock-in reminds the person, then the managers, once each', async () => {
    const f = fixture();
    const db = getDb(undefined, { system: 'maintenance' });
    await switchOn(f.staffId);
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
    expect(await botRecipients('attendance.remindIn')).toEqual([f.staffUserId]);
    expect(await botRecipients('attendance.absent')).toEqual([f.managerUserId]);
    const [absent] = await db
      .select({ title: s.notifications.title })
      .from(s.notifications)
      .where(
        and(eq(s.notifications.orgId, f.orgId), eq(s.notifications.template, 'attendance.absent')),
      );
    expect(absent!.title).toBe('Not clocked in');
  });

  test("reminded by the punch's own rule: a role at the store counts, a deny there wins (ATT-14)", async () => {
    const f = fixture();
    const db = getDb(undefined, { system: 'maintenance' });
    // Ali is switched on for the organisation, but denied at this store.
    await switchOn(f.staffId);
    await db.insert(s.memberPermissionOverrides).values({
      memberId: f.staffId,
      permissionKey: 'attendance.clock',
      effect: 'deny',
      scopeType: 'store',
      scopeId: f.storeId,
    });
    // Bob is not switched on: he clocks through a role he has at this store.
    const [clocker] = await db
      .insert(s.roles)
      .values({ orgId: f.orgId, slug: `att-clocker-${f.orgId}`, name: 'Clocker', rank: 10 })
      .returning();
    await db
      .insert(s.rolePermissions)
      .values({ roleId: clocker!.id, permissionKey: 'attendance.clock' });
    await db.insert(s.memberRoleBindings).values({
      memberId: f.colleagueId,
      roleId: clocker!.id,
      scopeType: 'store',
      scopeId: f.storeId,
    });
    // What the punch says of each.
    await expectError(
      f.staff().attendance.livenessChallenge({ storeId: f.storeId, force: true }),
      'attendance.errors.notEnabled',
    );
    await f.colleague().attendance.livenessChallenge({ storeId: f.storeId, force: true });
    // Each had a shift that began 40 minutes ago, and neither clocked in.
    const now = new Date();
    const shiftOf = new Map<string, string>();
    for (const memberId of [f.staffId, f.colleagueId]) {
      const [shift] = await db
        .insert(s.attendanceShifts)
        .values({
          orgId: f.orgId,
          storeId: f.storeId,
          memberId,
          shiftDate: todayInTz(TZ, now),
          startsAt: new Date(now.getTime() - 40 * 60_000),
          endsAt: new Date(now.getTime() + 4 * 3600_000),
        })
        .returning({ id: s.attendanceShifts.id });
      shiftOf.set(memberId, shift!.id);
    }
    await scanAttendanceReminders(db, now);
    expect(await botRecipients('attendance.remindIn')).toEqual([f.colleagueUserId]);
    // The managers hear of Bob's shift only.
    const absent = await db
      .select({ key: s.notifications.dedupKey })
      .from(s.notifications)
      .where(
        and(
          eq(s.notifications.orgId, f.orgId),
          eq(s.notifications.template, 'attendance.absent'),
          eq(s.notifications.channel, 'bot'),
        ),
      );
    expect(absent.map((n) => n.key)).toEqual([
      `attendance:${shiftOf.get(f.colleagueId)}:absent:${f.managerUserId}:bot`,
    ]);
  });
});
