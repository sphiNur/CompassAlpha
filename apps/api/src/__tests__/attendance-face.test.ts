/**
 * Face enrolment: the checked photos, the manager who approves them, and
 * withdrawing the consent.
 *
 * Each test gets a workspace of its own (helpers/attendance.ts). Split out
 * of attendance.test.ts by theme (review TEST1-17, 2026-11).
 *
 * Skipped when DATABASE_URL is unset or SKIP_PG_TESTS=1.
 */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { getDb, schema as s } from '@compass/db';
import { todayInTz } from '@compass/domain';
import { SHOULD_RUN } from './helpers/pg';
import { callerFor } from './helpers/ctx';
import { errorOf } from './helpers/errors';
import {
  attendanceSuite,
  fixture,
  botRecipients,
  clock,
  enrollApproved,
  enrollPhotos,
  expectError,
  jpeg,
  staffReady,
  TZ,
} from './helpers/attendance';

attendanceSuite();

describe.skipIf(!SHOULD_RUN)('attendance face enrollment', () => {
  test('six checked photos, approved by a manager; only that face clocks', async () => {
    const f = fixture();
    const db = getDb(undefined, { system: 'maintenance' });
    await staffReady();
    const enroll = (over: Partial<Record<string, string>> = {}) =>
      f.staff().attendance.faceEnroll({ storeId: f.storeId, photos: enrollPhotos('Ali', over) });

    // Withdrawing the consent deletes the enrolled face; enrolling needs it again.
    await f.staff().attendance.faceConsentWithdraw();
    expect((await f.staff().attendance.me({})).face.status).toBe('none');
    await expectError(enroll(), 'attendance.errors.consentRequired');
    await f.staff().attendance.faceConsentGive({ version: 1 });

    // Every photo is checked: a poor required one refuses the enrollment...
    await expectError(enroll({ left: 'Ali:flat' }), 'attendance.errors.enrollRejected');
    await expectError(enroll({ front2: 'Bob:front2' }), 'attendance.errors.enrollRejected');
    // ...a poor tilt is only left out (2026-11-07).
    const partial = await enroll({ up: 'Ali:up:dark', down: 'nobody' });
    expect(
      (
        await db
          .select({ pose: s.attendanceFaceSamples.pose })
          .from(s.attendanceFaceSamples)
          .where(eq(s.attendanceFaceSamples.enrollmentId, partial.id))
      )
        .map((x) => x.pose)
        .sort(),
    ).toEqual(['front', 'front2', 'left', 'right']);
    await expectError(
      enroll({
        left: 'Ali:left:print',
        right: 'Ali:right:print',
        up: 'Ali:up:print',
        down: 'Ali:down:print',
      }),
      'attendance.errors.enrollRejected',
    );
    await expectError(enroll({ front: 'boom' }), 'attendance.errors.faceCheckUnavailable');
    // The refusal says which photo and why.
    const refused = await errorOf(() => enroll({ up: 'Ali:up:dark', left: 'Ali:flat' }));
    expect(
      (refused?.cause as { context?: { problems?: string } } | undefined)?.context?.problems,
    ).toBe('left:notTurned');

    // The ring: tilts and diagonals are kept when caught, not required.
    const minimal = await f.staff().attendance.faceEnroll({
      storeId: f.storeId,
      photos: {
        front: jpeg('Ali:front'),
        left: jpeg('Ali:left'),
        right: jpeg('Ali:right'),
        front2: jpeg('Ali:front2'),
      },
    });
    expect(minimal.status).toBe('pending');
    const ring = await f.staff().attendance.faceEnroll({
      storeId: f.storeId,
      photos: {
        ...enrollPhotos('Ali'),
        upleft: jpeg('Ali:upleft'),
        upright: jpeg('Ali:upright'),
        downleft: jpeg('Ali:downleft'),
        downright: jpeg('Ali:downright'),
      },
    });
    expect(
      (
        await db
          .select({ pose: s.attendanceFaceSamples.pose })
          .from(s.attendanceFaceSamples)
          .where(eq(s.attendanceFaceSamples.enrollmentId, ring.id))
      ).length,
    ).toBe(10);
    // The newer one replaced the waiting one.
    expect(
      await db
        .select()
        .from(s.attendanceFaceEnrollments)
        .where(eq(s.attendanceFaceEnrollments.id, minimal.id)),
    ).toEqual([]);

    const first = await enroll();
    expect(first.status).toBe('pending');
    let me = await f.staff().attendance.me({});
    expect(me.face).toMatchObject({ status: 'pending', pending: true });
    await expectError(clock(f.staff()), 'attendance.errors.faceNotEnrolled');
    // A new enrollment replaces the one still waiting.
    const second = await enroll();
    let queue = await f.manager.attendance.reviewQueue({ storeId: f.storeId });
    expect(queue.enrollments.map((e) => [e.id, e.name, e.own])).toEqual([
      [second.id, 'Att Staff', false],
    ]);
    await expectError(
      f.staff().attendance.faceEnrollDecide({
        storeId: f.storeId,
        enrollmentId: second.id,
        approve: true,
      }),
      'auth.errors.missingPermission',
    );
    await expect(
      f.manager.attendance.faceEnrollDecide({
        storeId: f.storeId,
        enrollmentId: second.id,
        approve: false,
      }),
    ).rejects.toThrow('attendance.errors.enrollNoteRequired');
    await f.manager.attendance.faceEnrollDecide({
      storeId: f.storeId,
      enrollmentId: second.id,
      approve: false,
      note: 'Too dark',
    });
    me = await f.staff().attendance.me({});
    expect(me.face).toMatchObject({ status: 'rejected', rejectedNote: 'Too dark' });
    // Sent back: its photos are gone.
    expect(
      await db
        .select()
        .from(s.attendanceFaceSamples)
        .where(eq(s.attendanceFaceSamples.enrollmentId, second.id)),
    ).toEqual([]);
    await expectError(
      f.manager.attendance.faceEnrollDecide({
        storeId: f.storeId,
        enrollmentId: second.id,
        approve: true,
      }),
      'attendance.errors.enrollmentNotFound',
    );

    const third = await enroll();
    await f.manager.attendance.faceEnrollDecide({
      storeId: f.storeId,
      enrollmentId: third.id,
      approve: true,
    });
    me = await f.staff().attendance.me({});
    expect(me.face).toMatchObject({ status: 'approved', pending: false });
    expect(me.face.approvedAt).not.toBeNull();
    const shown = await f.manager.attendance.faceEnrollment({
      storeId: f.storeId,
      memberId: f.staffId,
    });
    expect(shown.map((e) => e.status)).toEqual(['approved']);
    expect(shown[0]!.photos.map((p) => p.pose)).toEqual([
      'front',
      'right',
      'up',
      'left',
      'down',
      'front2',
    ]);
    const today = todayInTz(TZ);
    const sheet = await f.manager.attendance.sheet({ storeId: f.storeId, from: today, to: today });
    expect(sheet.members.find((m) => m.memberId === f.staffId)!.face).toBe('approved');

    // Only that face clocks; anything else leaves no punch behind.
    await expectError(clock(f.staff(), { who: 'Bob' }), 'attendance.errors.faceMismatch');
    await expectError(clock(f.staff(), { who: 'nobody' }), 'attendance.errors.faceNotFound');
    await expectError(clock(f.staff(), { who: 'boom' }), 'attendance.errors.faceCheckUnavailable');
    expect((await clock(f.staff())).face).toBe('match');

    // Nobody approves their own face.
    const [own] = await db
      .insert(s.attendanceFaceEnrollments)
      .values({ orgId: f.orgId, memberId: f.managerId, storeId: f.storeId })
      .returning();
    queue = await f.manager.attendance.reviewQueue({ storeId: f.storeId });
    expect(queue.enrollments.find((e) => e.id === own!.id)!.own).toBe(true);
    await expectError(
      f.manager.attendance.faceEnrollDecide({
        storeId: f.storeId,
        enrollmentId: own!.id,
        approve: true,
      }),
      'attendance.errors.enrollOwn',
    );
    // ...except a super admin (owner, 2026-11-07): nobody is above them.
    const asSuper = await f.superAdmin().attendance.reviewQueue({ storeId: f.storeId });
    expect(asSuper.enrollments.find((e) => e.id === own!.id)!.own).toBe(false);
    await f.superAdmin().attendance.faceEnrollDecide({
      storeId: f.storeId,
      enrollmentId: own!.id,
      approve: true,
    });
    const [decided] = await db
      .select()
      .from(s.attendanceFaceEnrollments)
      .where(eq(s.attendanceFaceEnrollments.id, own!.id));
    expect(decided).toMatchObject({ status: 'approved', decidedByMemberId: f.managerId });
    await db.delete(s.attendanceFaceEnrollments).where(eq(s.attendanceFaceEnrollments.id, own!.id));

    // A manager asks for it again: no punch until a new one is approved.
    await expectError(
      f.staff().attendance.faceEnrollReset({ storeId: f.storeId, memberId: f.staffId }),
      'auth.errors.missingPermission',
    );
    await f.manager.attendance.faceEnrollReset({ storeId: f.storeId, memberId: f.staffId });
    expect((await f.staff().attendance.me({})).face.status).toBe('none');
    await expectError(clock(f.staff(), { kind: 'out' }), 'attendance.errors.faceNotEnrolled');
    await enrollApproved(f.staff(), 'Ali');

    const to = async (template: string) => [...new Set(await botRecipients(template))];
    expect(await to('attendance.faceEnrollPending')).toEqual([f.managerUserId]);
    expect(await to('attendance.faceEnrollRejected')).toEqual([f.staffUserId]);
    expect(await to('attendance.faceEnrollApproved')).toEqual([f.staffUserId]);
  });
});

describe.skipIf(!SHOULD_RUN)('attendance review fixes (2026-11-07)', () => {
  test('withdrawing face consent works in a read-only workspace', async () => {
    const f = fixture();
    await f.colleague().attendance.faceConsentGive({ version: 1 });
    expect((await f.colleague().attendance.me({})).faceConsent).not.toBeNull();
    const readOnly = callerFor({
      userId: f.colleagueUserId,
      memberId: f.colleagueId,
      orgId: f.orgId,
      orgTimezone: TZ,
      writeAccess: false,
      permissions: new Set(['attendance.clock']),
      roleSlugs: new Set(),
    });
    await expectError(
      readOnly.attendance.faceConsentGive({ version: 1 }),
      'subscription.errors.readOnly',
    );
    await readOnly.attendance.faceConsentWithdraw();
    const me = await f.colleague().attendance.me({});
    expect(me.faceConsent).toBeNull();
    expect(me.face?.status ?? 'none').toBe('none');
  });
});
