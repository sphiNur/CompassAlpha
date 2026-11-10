/**
 * Clocking and its records: who may clock, the phone and the place, the
 * roster and the sheet, manual punches and voids, the punch photos and
 * how long they are kept, and what happens to a member who has them.
 *
 * Each test gets a workspace of its own (helpers/attendance.ts). Split out
 * of attendance.test.ts by theme (review TEST1-17, 2026-11).
 *
 * Skipped when DATABASE_URL is unset or SKIP_PG_TESTS=1.
 */
import { describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema as s } from '@compass/db';
import { attendance, dateInTz, todayInTz } from '@compass/domain';
import {
  purgeOldAttendancePhotos,
  purgeOldFramePrints,
} from '../services/attendancePhotoRetention';
import { SHOULD_RUN } from './helpers/pg';
import { freshTgId } from './helpers/telegram';
import { callerFor } from './helpers/ctx';
import { pgErrorOf } from './helpers/errors';
import {
  attendanceSuite,
  fixture,
  clock,
  enrollApproved,
  expectError,
  passiveToken,
  staffReady,
  DEVICE,
  OTHER_DEVICE,
  SHOP,
  TZ,
} from './helpers/attendance';

attendanceSuite();

describe.skipIf(!SHOULD_RUN)('attendance', () => {
  test('clocking needs the member switch', async () => {
    const f = fixture();
    await expectError(
      f.staff().attendance.punch({ storeId: f.storeId, kind: 'in', deviceId: DEVICE }),
      'attendance.errors.notEnabled',
    );
    expect((await f.staff().attendance.me({})).stores).toEqual([]);
    await f.manager.attendance.memberSet({
      storeId: f.storeId,
      memberId: f.staffId,
      enabled: true,
    });
    const me = await f.staff().attendance.me({ deviceId: DEVICE });
    expect(me.stores.map((x) => x.storeId)).toEqual([f.storeId]);
    expect(me.stores[0]!.nextKind).toBe('in');
    expect(me.device).toEqual({ bound: false, matches: null });
    expect(me.face.status).toBe('none');
    // Face only: no punch before an approved enrollment.
    await expectError(clock(f.staff()), 'attendance.errors.consentRequired');
    await f.staff().attendance.faceConsentGive({ version: 1 });
    await expectError(clock(f.staff()), 'attendance.errors.faceNotEnrolled');
    await enrollApproved(f.staff(), 'Ali');
    expect((await f.staff().attendance.me({})).face.status).toBe('approved');
  });

  test('a manager switches only people of their own store', async () => {
    const f = fixture();
    await expectError(
      f.manager.attendance.memberSet({ storeId: f.storeId, memberId: f.outsiderId, enabled: true }),
      'attendance.errors.memberNotInStore',
    );
    await expectError(
      f.manager.attendance.memberSet({
        storeId: f.otherStoreId,
        memberId: f.outsiderId,
        enabled: true,
      }),
      'auth.errors.notAssignedToStore',
    );
  });

  test('first punch binds the phone; in and out alternate', async () => {
    const f = fixture();
    await staffReady();
    // Without photos or a challenge: refused.
    await expectError(
      f.staff().attendance.punch({ storeId: f.storeId, kind: 'in', deviceId: DEVICE }),
      'attendance.errors.photoRequired',
    );
    const first = await clock(f.staff(), { kind: 'in', device: DEVICE });
    expect([first.kind, first.face, first.liveness]).toEqual(['in', 'match', 'pass']);
    await expectError(
      clock(f.staff(), { kind: 'in', device: DEVICE }),
      'attendance.errors.alreadyClockedIn',
    );
    // Another phone without the turns: the turns first.
    await expectError(
      clock(f.staff(), {
        kind: 'out',
        device: OTHER_DEVICE,
        token: await passiveToken(f.staffId),
      }),
      'attendance.errors.livenessNeeded',
    );
    expect((await f.staff().attendance.me({ deviceId: OTHER_DEVICE })).device).toEqual({
      bound: true,
      matches: false,
    });
    await clock(f.staff(), { kind: 'out', device: DEVICE });
    await expectError(
      clock(f.staff(), { kind: 'out', device: DEVICE }),
      'attendance.errors.notClockedIn',
    );
    await f.manager.attendance.resetDevice({ storeId: f.storeId, memberId: f.staffId });
    expect((await f.staff().attendance.me({ deviceId: OTHER_DEVICE })).device.bound).toBe(false);
  });

  test('location rules', async () => {
    const f = fixture();
    await staffReady();
    const base = {
      storeId: f.storeId,
      requireDevice: true,
      requireGeo: true,
      geo: { ...SHOP, radiusM: 100 },
      graceMinutes: 5,
    };
    // A schema refusal: the key sits inside the zod issue list.
    await expect(f.manager.attendance.policySave({ ...base, geo: null })).rejects.toThrow(
      'attendance.errors.geoMissing',
    );
    await f.manager.attendance.policySave(base);
    const policy = await f.manager.attendance.policyGet({ storeId: f.storeId });
    expect(policy.geo).toEqual({ ...SHOP, radiusM: 100 });

    const punch = (location: { lat: number; lng: number; accuracy: number } | null) =>
      clock(f.staff(), { kind: 'in', device: OTHER_DEVICE, location });
    await expectError(punch(null), 'attendance.errors.locationRequired');
    await expectError(punch({ ...SHOP, accuracy: 900 }), 'attendance.errors.locationInaccurate');
    await expectError(
      punch({ lat: SHOP.lat + 0.01, lng: SHOP.lng, accuracy: 10 }),
      'attendance.errors.outsideArea',
    );
    const ok = await punch({ lat: SHOP.lat + 0.0005, lng: SHOP.lng, accuracy: 15 });
    expect(ok.kind).toBe('in');
    await clock(f.staff(), {
      kind: 'out',
      device: OTHER_DEVICE,
      location: { ...SHOP, accuracy: 5 },
    });
    // The map: the area and where the phone was.
    const today = todayInTz(TZ);
    const sheet = await f.manager.attendance.sheet({ storeId: f.storeId, from: today, to: today });
    expect(sheet.geo).toEqual({ ...SHOP, radiusM: 100 });
    const placed = sheet.punches.find((p) => p.id === ok.id);
    expect(placed?.location?.lat).toBeCloseTo(SHOP.lat + 0.0005, 6);
    expect(placed?.location?.accuracyM).toBe(15);
  });

  test('roster, sheet, manual punch and void', async () => {
    const f = fixture();
    await staffReady();
    const today = todayInTz(TZ);
    const shift = await f.manager.attendance.shiftSave({
      storeId: f.storeId,
      memberId: f.staffId,
      date: today,
      start: '00:00',
      end: '23:59',
    });
    await expectError(
      f.manager.attendance.shiftSave({
        storeId: f.storeId,
        memberId: f.staffId,
        date: today,
        start: '10:00',
        end: '12:00',
      }),
      'attendance.errors.shiftOverlap',
    );
    await expectError(
      f.manager.attendance.shiftSave({
        storeId: f.storeId,
        memberId: f.outsiderId,
        date: today,
        start: '10:00',
        end: '12:00',
      }),
      'attendance.errors.memberNotInStore',
    );
    const manual = await f.manager.attendance.manualPunch({
      storeId: f.storeId,
      memberId: f.staffId,
      kind: 'in',
      date: today,
      time: '00:01',
      reason: 'Forgot to clock in',
    });
    const sheet = await f.manager.attendance.sheet({ storeId: f.storeId, from: today, to: today });
    const staffRow = sheet.members.find((m) => m.memberId === f.staffId)!;
    expect(staffRow.enabled).toBe(true);
    expect(sheet.shifts.map((x) => x.id)).toEqual([shift.id]);
    const day = sheet.days.find((d) => d.memberId === f.staffId)!;
    expect(day.shiftIds).toEqual([shift.id]);
    expect(day.punchIds).toContain(manual.id);
    const manualRow = sheet.punches.find((p) => p.id === manual.id)!;
    expect(manualRow.source).toBe('manual');
    expect(manualRow.createdByName).toBe('Att Manager');

    await f.manager.attendance.voidPunch({
      storeId: f.storeId,
      punchId: manual.id,
      reason: 'Wrong person',
    });
    await expectError(
      f.manager.attendance.voidPunch({ storeId: f.storeId, punchId: manual.id, reason: 'again' }),
      'attendance.errors.alreadyVoided',
    );
    const after = await f.manager.attendance.sheet({ storeId: f.storeId, from: today, to: today });
    expect(after.punches.find((p) => p.id === manual.id)!.voided?.reason).toBe('Wrong person');
    expect(after.days.find((d) => d.memberId === f.staffId)!.punchIds).not.toContain(manual.id);

    await expectError(
      f.staff().attendance.sheet({ storeId: f.storeId, from: today, to: today }),
      'auth.errors.missingPermission',
    );
    await f.manager.attendance.shiftDelete({ storeId: f.storeId, shiftId: shift.id });
  });

  test('punches are never deleted or rewritten', async () => {
    const f = fixture();
    const db = getDb(undefined, { system: 'maintenance' });
    // A punch of its own, long ago and already voided, so the test needs
    // no earlier one and no later count sees it.
    const [row] = await db
      .insert(s.attendancePunches)
      .values({
        orgId: f.orgId,
        storeId: f.storeId,
        memberId: f.staffId,
        kind: 'in',
        punchedAt: new Date('2020-01-06T04:00:00Z'),
        source: 'manual',
        reason: 'append-only check',
        createdByMemberId: f.managerId,
        voidedAt: new Date('2020-01-06T05:00:00Z'),
        voidedByMemberId: f.managerId,
        voidReason: 'append-only check',
      })
      .returning({ id: s.attendancePunches.id });
    const byId = eq(s.attendancePunches.id, row!.id);
    expect(await pgErrorOf(() => db.delete(s.attendancePunches).where(byId))).toMatchObject({
      code: 'P0001',
      message: 'attendance punches are never deleted; void them instead',
    });
    expect(
      await pgErrorOf(() =>
        db
          .update(s.attendancePunches)
          .set({ punchedAt: sql`now() - interval '1 hour'` })
          .where(byId),
      ),
    ).toMatchObject({ code: 'P0001', message: 'an attendance punch can only be voided, once' });
  });

  test('copy a week skips clashes', async () => {
    const f = fixture();
    const monday = '2030-01-07';
    await f.manager.attendance.shiftSave({
      storeId: f.storeId,
      memberId: f.staffId,
      date: monday,
      start: '09:00',
      end: '18:00',
    });
    await f.manager.attendance.shiftSave({
      storeId: f.storeId,
      memberId: f.staffId,
      date: '2030-01-08',
      start: '20:00',
      end: '04:00',
    });
    const first = await f.manager.attendance.copyWeek({
      storeId: f.storeId,
      fromWeek: monday,
      toWeek: '2030-01-14',
    });
    expect(first).toEqual({ copied: 2, skipped: 0 });
    const again = await f.manager.attendance.copyWeek({
      storeId: f.storeId,
      fromWeek: monday,
      toWeek: '2030-01-14',
    });
    expect(again).toEqual({ copied: 0, skipped: 2 });
    const sheet = await f.manager.attendance.sheet({
      storeId: f.storeId,
      from: '2030-01-14',
      to: '2030-01-20',
    });
    expect(sheet.shifts.map((x) => [x.date, x.start, x.end])).toEqual([
      ['2030-01-14', '09:00', '18:00'],
      ['2030-01-15', '20:00', '04:00'],
    ]);
  });
});

describe.skipIf(!SHOULD_RUN)('attendance photos', () => {
  test('the face only, no place photo (2026-11-07); managers see it; 90 days', async () => {
    const f = fixture();
    const db = getDb(undefined, { system: 'maintenance' });
    await staffReady();
    const rules = {
      storeId: f.storeId,
      requireDevice: false,
      requireGeo: false,
      geo: null,
      graceMinutes: 5,
      overtimeAfterMinutes: 30,
    };
    // An old page that still sends the switch: it is not kept.
    await f.manager.attendance.policySave({ ...rules, requireScene: true });
    expect((await f.staff().attendance.me({})).stores[0]!.rules).toMatchObject({
      requirePhoto: true,
      requireFace: true,
      requireLiveness: true,
      requireScene: false,
    });
    const token = () => passiveToken(f.staffId);
    const notJpeg = Buffer.from('not a photo at all').toString('base64');
    await expectError(
      f.staff().attendance.punch({
        storeId: f.storeId,
        kind: 'in',
        deviceId: OTHER_DEVICE,
        photos: { face: notJpeg },
        liveness: { token: await token() },
      }),
      'attendance.errors.photoInvalid',
    );
    // A place photo from an old page is not stored.
    const done = await clock(f.staff(), { token: await token(), scene: 'shop' });
    expect(done.liveness).toBe('passive');

    const date = dateInTz(new Date(done.at), TZ);
    const sheet = await f.manager.attendance.sheet({ storeId: f.storeId, from: date, to: date });
    expect(sheet.punches.find((p) => p.id === done.id)!.photos).toEqual(['face']);
    const photos = await f.manager.attendance.punchPhotos({ storeId: f.storeId, punchId: done.id });
    expect(photos.map((p) => p.kind)).toEqual(['face']);
    expect(Buffer.from(photos[0]!.src.split(',')[1]!, 'base64').toString('latin1')).toContain(
      'Ali:front#',
    );
    await expectError(
      f.staff().attendance.punchPhotos({ storeId: f.storeId, punchId: done.id }),
      'auth.errors.missingPermission',
    );

    // Kept 90 days.
    expect(await purgeOldAttendancePhotos(db)).toBe(0);
    await db.execute(
      sql`UPDATE inventory.attendance_photos SET taken_at = now() - interval '91 days' WHERE punch_id = ${done.id}`,
    );
    expect(await purgeOldAttendancePhotos(db)).toBe(1);
    expect(
      await f.manager.attendance.punchPhotos({ storeId: f.storeId, punchId: done.id }),
    ).toEqual([]);
    // The frame prints go after 90 days too: the straight frame, the blink
    // and the open mouth.
    await db.execute(
      sql`UPDATE inventory.attendance_punch_frames SET taken_at = now() - interval '91 days' WHERE punch_id = ${done.id}`,
    );
    expect(await purgeOldFramePrints(db)).toBeGreaterThanOrEqual(3);
    const prints = await db.execute(
      sql`SELECT count(*)::int AS n FROM inventory.attendance_punch_frames WHERE punch_id = ${done.id}`,
    );
    expect((prints as unknown as { n: number }[])[0]!.n).toBe(0);
  });
});

describe.skipIf(!SHOULD_RUN)('attendance review fixes (2026-11-07)', () => {
  test('a manager does not change their own attendance or wage; a super admin does', async () => {
    const f = fixture();
    const hourAgo = new Date(Date.now() - 3600_000);
    const when = { date: dateInTz(hourAgo, TZ), time: attendance.localTime(hourAgo, TZ) };
    const own = { storeId: f.storeId, memberId: f.managerId };
    await expectError(
      f.manager.attendance.manualPunch({ ...own, ...when, kind: 'in', reason: 'own' }),
      'attendance.errors.manageOwn',
    );
    await expectError(
      f.manager.attendance.payRateSet({ ...own, dailyWage: '999999', effectiveFrom: when.date }),
      'attendance.errors.manageOwn',
    );
    // The super admin may.
    const mine = await f
      .superAdmin()
      .attendance.manualPunch({ ...own, ...when, kind: 'in', reason: 'forgot' });
    await f
      .superAdmin()
      .attendance.payRateSet({ ...own, dailyWage: '100', effectiveFrom: when.date });
    await expectError(
      f.manager.attendance.voidPunch({ storeId: f.storeId, punchId: mine.id, reason: 'own' }),
      'attendance.errors.manageOwn',
    );
    await expectError(
      f.manager.attendance.reviewPunch({ storeId: f.storeId, punchId: mine.id }),
      'attendance.errors.manageOwn',
    );
    const db = getDb(undefined, { system: 'maintenance' });
    const [ot] = (await db.execute(sql`
      INSERT INTO inventory.attendance_overtime (org_id, store_id, member_id, punch_id, minutes, reason)
      VALUES (${f.orgId}, ${f.storeId}, ${f.managerId}, ${mine.id}, 45, 'own overtime')
      RETURNING id`)) as unknown as { id: string }[];
    await expectError(
      f.manager.attendance.overtimeDecide({
        storeId: f.storeId,
        overtimeId: ot!.id,
        approve: true,
      }),
      'attendance.errors.manageOwn',
    );
    await f
      .superAdmin()
      .attendance.overtimeDecide({ storeId: f.storeId, overtimeId: ot!.id, approve: false });
    await f
      .superAdmin()
      .attendance.voidPunch({ storeId: f.storeId, punchId: mine.id, reason: 'test' });
    // Someone else's attendance: as before.
    const sheet = await f.manager.attendance.sheet({
      storeId: f.storeId,
      from: when.date,
      to: when.date,
    });
    expect(sheet.members.find((m) => m.memberId === f.managerId)?.own).toBe(true);
    expect(sheet.members.find((m) => m.memberId === f.staffId)?.own).toBe(false);
  });

  test('a member with attendance is suspended, not removed; the records stay', async () => {
    const f = fixture();
    const db = getDb(undefined, { system: 'maintenance' });
    // A punch of Ali's: attendance to keep.
    await db.insert(s.attendancePunches).values({
      orgId: f.orgId,
      storeId: f.storeId,
      memberId: f.staffId,
      kind: 'in',
      punchedAt: new Date(Date.now() - 3600_000),
      source: 'manual',
      reason: 'kept',
      createdByMemberId: f.managerId,
    });
    // An org admin by a global binding: removing someone from the whole
    // organisation is ranked by global bindings alone (ADM1-01).
    const [adminRole] = await db
      .insert(s.roles)
      .values({ orgId: f.orgId, slug: `att-admin-${Date.now()}`, name: 'Admin', rank: 80 })
      .returning();
    const [adminUser] = await db
      .insert(s.users)
      .values({ displayName: 'Att Admin', tgUserId: freshTgId() })
      .returning();
    const [adminMember] = await db
      .insert(s.members)
      .values({ orgId: f.orgId, userId: adminUser!.id, status: 'active' })
      .returning();
    await db.insert(s.memberRoleBindings).values({
      memberId: adminMember!.id,
      roleId: adminRole!.id,
      scopeType: 'global',
      scopeId: null,
    });
    const admin = callerFor({
      userId: adminUser!.id,
      memberId: adminMember!.id,
      orgId: f.orgId,
      orgTimezone: TZ,
      writeAccess: true,
      permissions: new Set(['org.admin', 'users.manage', 'attendance.manage']),
      roleSlugs: new Set(),
    });
    await expectError(
      admin.admin.memberRemove({ memberId: f.staffId }),
      'admin.errors.memberHasAttendance',
    );
    const left = await db.execute(
      sql`SELECT count(*)::int AS n FROM inventory.attendance_punches WHERE member_id = ${f.staffId}`,
    );
    expect((left as unknown as { n: number }[])[0]!.n).toBeGreaterThan(0);
    // The database refuses it too.
    let refused = false;
    try {
      await db.execute(sql`DELETE FROM auth.members WHERE id = ${f.staffId}`);
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });
});
