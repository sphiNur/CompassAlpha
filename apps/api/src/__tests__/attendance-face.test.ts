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
  switchOn,
  TZ,
} from './helpers/attendance';

attendanceSuite();

describe.skipIf(!SHOULD_RUN)('attendance face enrollment', () => {
  /** Ali switched on and agreed to the face checks, with no face yet. */
  async function consented() {
    const f = fixture();
    await switchOn(f.staffId);
    await f.staff().attendance.faceConsentGive({ version: 1 });
  }
  /** Ali's photos, `over` in place of some. */
  const enroll = (over: Partial<Record<string, string>> = {}) => {
    const f = fixture();
    return f
      .staff()
      .attendance.faceEnroll({ storeId: f.storeId, photos: enrollPhotos('Ali', over) });
  };
  const decide = (enrollmentId: string, approve: boolean, note?: string) => {
    const f = fixture();
    return f.manager.attendance.faceEnrollDecide({
      storeId: f.storeId,
      enrollmentId,
      approve,
      ...(note === undefined ? {} : { note }),
    });
  };
  const posesOf = async (enrollmentId: string) =>
    (
      await getDb(undefined, { system: 'maintenance' })
        .select({ pose: s.attendanceFaceSamples.pose })
        .from(s.attendanceFaceSamples)
        .where(eq(s.attendanceFaceSamples.enrollmentId, enrollmentId))
    ).map((x) => x.pose);

  test('withdrawing the consent deletes the enrolled face; enrolling needs it again', async () => {
    const f = fixture();
    await staffReady();
    await f.staff().attendance.faceConsentWithdraw();
    expect((await f.staff().attendance.me({})).face.status).toBe('none');
    // Deleted, not only hidden.
    expect(
      await getDb(undefined, { system: 'maintenance' })
        .select()
        .from(s.attendanceFaceEnrollments)
        .where(eq(s.attendanceFaceEnrollments.memberId, f.staffId)),
    ).toEqual([]);
    await expectError(enroll(), 'attendance.errors.consentRequired');
    await f.staff().attendance.faceConsentGive({ version: 1 });
    expect((await enroll()).status).toBe('pending');
  });

  test('every photo is checked: a poor required one refuses, a poor tilt is left out', async () => {
    await consented();
    await expectError(enroll({ left: 'Ali:flat' }), 'attendance.errors.enrollRejected');
    await expectError(enroll({ front2: 'Bob:front2' }), 'attendance.errors.enrollRejected');
    // A poor tilt is only left out (2026-11-07).
    const partial = await enroll({ up: 'Ali:up:dark', down: 'nobody' });
    expect((await posesOf(partial.id)).sort()).toEqual(['front', 'front2', 'left', 'right']);
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
  });

  test('the ring: tilts and diagonals are kept when caught, not required', async () => {
    const f = fixture();
    const db = getDb(undefined, { system: 'maintenance' });
    await consented();
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
    expect((await posesOf(ring.id)).length).toBe(10);
    // The newer one replaced the waiting one.
    expect(
      await db
        .select()
        .from(s.attendanceFaceEnrollments)
        .where(eq(s.attendanceFaceEnrollments.id, minimal.id)),
    ).toEqual([]);
  });

  test('a waiting face does not clock; a manager refuses it with a note, and its photos go', async () => {
    const f = fixture();
    await consented();
    const first = await enroll();
    expect(first.status).toBe('pending');
    let me = await f.staff().attendance.me({});
    expect(me.face).toMatchObject({ status: 'pending', pending: true });
    await expectError(clock(f.staff()), 'attendance.errors.faceNotEnrolled');
    // A new enrollment replaces the one still waiting.
    const second = await enroll();
    const queue = await f.manager.attendance.reviewQueue({ storeId: f.storeId });
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
    await expect(decide(second.id, false)).rejects.toThrow('attendance.errors.enrollNoteRequired');
    await decide(second.id, false, 'Too dark');
    me = await f.staff().attendance.me({});
    expect(me.face).toMatchObject({ status: 'rejected', rejectedNote: 'Too dark' });
    // Sent back: its photos are gone.
    expect(await posesOf(second.id)).toEqual([]);
    await expectError(decide(second.id, true), 'attendance.errors.enrollmentNotFound');
    // Each waiting face told the managers; the refusal told Ali.
    expect(await botRecipients('attendance.faceEnrollPending')).toEqual([
      f.managerUserId,
      f.managerUserId,
    ]);
    expect(await botRecipients('attendance.faceEnrollRejected')).toEqual([f.staffUserId]);
  });

  test('the managers see the approved face, not a refused one', async () => {
    const f = fixture();
    await consented();
    await decide((await enroll()).id, false, 'Too dark');
    await decide((await enroll()).id, true);
    const me = await f.staff().attendance.me({});
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
    expect(await botRecipients('attendance.faceEnrollApproved')).toEqual([f.staffUserId]);
  });

  test('only the approved face clocks; anything else leaves no punch behind', async () => {
    const f = fixture();
    await staffReady();
    await expectError(clock(f.staff(), { who: 'Bob' }), 'attendance.errors.faceMismatch');
    await expectError(clock(f.staff(), { who: 'nobody' }), 'attendance.errors.faceNotFound');
    await expectError(clock(f.staff(), { who: 'boom' }), 'attendance.errors.faceCheckUnavailable');
    expect((await clock(f.staff())).face).toBe('match');
  });

  test('nobody approves their own face, except a super admin', async () => {
    const f = fixture();
    const db = getDb(undefined, { system: 'maintenance' });
    const [own] = await db
      .insert(s.attendanceFaceEnrollments)
      .values({ orgId: f.orgId, memberId: f.managerId, storeId: f.storeId })
      .returning();
    const queue = await f.manager.attendance.reviewQueue({ storeId: f.storeId });
    expect(queue.enrollments.find((e) => e.id === own!.id)!.own).toBe(true);
    await expectError(decide(own!.id, true), 'attendance.errors.enrollOwn');
    // A super admin may (owner, 2026-11-07): nobody is above them.
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
  });

  test('a manager asks for the face again: no punch until a new one is approved', async () => {
    const f = fixture();
    await staffReady();
    await expectError(
      f.staff().attendance.faceEnrollReset({ storeId: f.storeId, memberId: f.staffId }),
      'auth.errors.missingPermission',
    );
    await f.manager.attendance.faceEnrollReset({ storeId: f.storeId, memberId: f.staffId });
    expect((await f.staff().attendance.me({})).face.status).toBe('none');
    await expectError(clock(f.staff()), 'attendance.errors.faceNotEnrolled');
    await enrollApproved(f.staff(), 'Ali');
    expect((await clock(f.staff())).face).toBe('match');
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
