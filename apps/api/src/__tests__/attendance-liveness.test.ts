/**
 * Liveness and borrowed phones: the turns, the blink and the open mouth,
 * prints and pictures sent before, and clocking a colleague on one's
 * own phone.
 *
 * Each test gets a workspace of its own (helpers/attendance.ts). Split out
 * of attendance.test.ts by theme (review TEST1-17, 2026-11).
 *
 * Skipped when DATABASE_URL is unset or SKIP_PG_TESTS=1.
 */
import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { getDb, schema as s } from '@compass/db';
import { attendance, dateInTz } from '@compass/domain';
import { signLivenessToken } from '../services/face/liveness';
import { SHOULD_RUN } from './helpers/pg';
import { errorOf } from './helpers/errors';
import {
  attendanceSuite,
  fixture,
  anyPhoneAnywhere,
  botRecipients,
  clock,
  colleagueReady,
  enrollApproved,
  expectError,
  jpeg,
  passiveToken,
  refusal,
  resetPunches,
  staffReady,
  switchOn,
  DEVICE,
  OTHER_DEVICE,
  TZ,
} from './helpers/attendance';

attendanceSuite();

describe.skipIf(!SHOULD_RUN)('attendance liveness and borrowed phones', () => {
  /** Every punch kept for `memberId`, voided ones too. */
  const recorded = async (memberId: string) =>
    (
      await getDb(undefined, { system: 'maintenance' })
        .select({ id: s.attendancePunches.id })
        .from(s.attendancePunches)
        .where(eq(s.attendancePunches.memberId, memberId))
    ).map((p) => p.id);
  /** Every bot message sent in this workspace so far, by template. */
  const botTemplates = async () => {
    const f = fixture();
    const rows = await getDb(undefined, { system: 'maintenance' })
      .select({ template: s.notifications.template })
      .from(s.notifications)
      .where(and(eq(s.notifications.orgId, f.orgId), eq(s.notifications.channel, 'bot')))
      .orderBy(s.notifications.createdAt);
    return rows.map((row) => row.template);
  };

  test('a challenge is good for one punch, by the member it was asked for', async () => {
    const f = fixture();
    await staffReady();
    await switchOn(f.colleagueId);
    await f.manager.attendance.policySave(anyPhoneAnywhere(f.storeId));
    await expectError(
      f.staff().attendance.punch({
        storeId: f.storeId,
        kind: 'in',
        deviceId: OTHER_DEVICE,
        photos: { face: jpeg('Ali:front') },
      }),
      'attendance.errors.livenessRequired',
    );
    const challenge = await f.staff().attendance.livenessChallenge({
      storeId: f.storeId,
      force: true,
    });
    expect([...challenge.steps].sort()).toEqual(['left', 'right']);
    const first = await clock(f.staff(), { token: challenge.token });
    expect([first.liveness, first.face]).toEqual(['pass', 'match']);
    // One challenge, one punch.
    await expectError(
      clock(f.staff(), { kind: 'out', token: challenge.token }),
      'attendance.errors.livenessExpired',
    );
    // Another member's challenge does not fit.
    const theirs = await f.colleague().attendance.livenessChallenge({
      storeId: f.storeId,
      force: true,
    });
    await expectError(
      clock(f.staff(), { kind: 'out', token: theirs.token }),
      'attendance.errors.livenessExpired',
    );
    expect(await recorded(f.staffId)).toEqual([first.id]);
  });

  test('a failed check is refused, never recorded, and tells nobody', async () => {
    const f = fixture();
    await staffReady();
    await f.manager.attendance.policySave(anyPhoneAnywhere(f.storeId));
    const before = await botTemplates();
    for (const [left, right] of [
      ['Ali:print', 'Ali:print'],
      ['Ali:flat', 'Ali:flat'],
      ['Bob:left', 'Bob:right'],
    ] as const) {
      await expectError(clock(f.staff(), { left, right }), 'attendance.errors.livenessFailed');
    }
    expect(await recorded(f.staffId)).toEqual([]);
    expect(await botTemplates()).toEqual(before);
  });

  test('a colleague on a borrowed phone: known by the face, only with the turns, not twice', async () => {
    const f = fixture();
    await staffReady();
    await switchOn(f.colleagueId);
    await f.manager.attendance.policySave(anyPhoneAnywhere(f.storeId));
    // Bob (the colleague) clocks on Ali's (staff's) phone.
    await expectError(
      clock(f.staff(), { who: 'Bob', identify: true }),
      'attendance.errors.notRecognized',
    );
    await expectError(
      clock(f.colleague(), { who: 'Bob', device: DEVICE }),
      'attendance.errors.consentRequired',
    );
    await f.colleague().attendance.faceConsentGive({ version: 1 });
    await expectError(
      clock(f.colleague(), { who: 'Bob', device: DEVICE }),
      'attendance.errors.faceNotEnrolled',
    );
    await enrollApproved(f.colleague(), 'Bob');
    const own = await clock(f.colleague(), { who: 'Bob', device: DEVICE });
    expect(own.face).toBe('match');
    // The face says who: Ali's own face is not a colleague's, and he is
    // told it is his own (the phone's person is a candidate too).
    await expectError(
      clock(f.staff(), { who: 'Ali', identify: true }),
      'attendance.errors.identifyIsOwner',
    );
    // A borrowed phone never goes without the turns.
    const noTurns = await signLivenessToken({
      org: f.orgId,
      mid: '*',
      by: f.staffId,
      storeId: f.storeId,
      steps: [],
    });
    await expectError(
      clock(f.staff(), { who: 'Bob', identify: true, token: noTurns.token }),
      'attendance.errors.livenessNeeded',
    );
    await expectError(
      clock(f.staff(), { who: 'Bob', identify: true, left: 'Bob:print', right: 'Bob:print' }),
      'attendance.errors.livenessFailed',
    );
    // Bob clocked in on his own phone a moment ago: found again on Ali's
    // phone, that is the same punch twice, not his clock-out (2026-11-07).
    await expectError(
      clock(f.staff(), { who: 'Bob', identify: true }),
      'attendance.errors.justPunched',
    );
    await resetPunches(f.colleagueId);
    const borrowed = await clock(f.staff(), { who: 'Bob', identify: true });
    expect([borrowed.face, borrowed.liveness, borrowed.forName, borrowed.kind]).toEqual([
      'match',
      'pass',
      'Att Colleague',
      'in',
    ]);
    const date = dateInTz(new Date(borrowed.at), TZ);
    const sheet = await f.manager.attendance.sheet({ storeId: f.storeId, from: date, to: date });
    const row = sheet.punches.find((p) => p.id === borrowed.id)!;
    expect([row.memberId, row.viaName]).toEqual([f.colleagueId, 'Att Staff']);
    expect([...row.photos].sort()).toEqual(['face', 'left', 'right']);
    expect(await botRecipients('attendance.borrowedPhone')).toEqual([f.managerUserId]);
    expect(await botRecipients('attendance.clockedInForYou')).toEqual([f.colleagueUserId]);
  });

  test("no turns asked: only a plainly real photo of one's own face clocks", async () => {
    const f = fixture();
    await staffReady();
    await f.manager.attendance.policySave(anyPhoneAnywhere(f.storeId));
    const before = await botTemplates();
    // A photo held up: its blink and open mouth are prints too (2026-11-07).
    await expectError(
      clock(f.staff(), { who: 'Ali:print', token: await passiveToken(f.staffId) }),
      'attendance.errors.livenessFailed',
    );
    // Real movements after a printed straight photo: refused; the straight
    // frame must look real by itself (2026-11-07).
    await expectError(
      clock(f.staff(), {
        who: 'Ali:print',
        blink: 'Ali:blink',
        mouth: 'Ali:mouth',
        token: await passiveToken(f.staffId),
      }),
      'attendance.errors.livenessFailed',
    );
    // Real movements, a straight photo that is only probably real: the turns.
    await expectError(
      clock(f.staff(), {
        face: 'Ali:front:unsure',
        token: await passiveToken(f.staffId),
      }),
      'attendance.errors.livenessNeeded',
    );
    // Bob's face on Ali's punch: refused.
    await expectError(clock(f.staff(), { who: 'Bob' }), 'attendance.errors.faceMismatch');
    expect(await botTemplates()).toEqual(before);
    // One face photo, plainly real: no turns (the server did not ask).
    const passive = await clock(f.staff(), { token: await passiveToken(f.staffId) });
    expect([passive.liveness, passive.face]).toEqual(['passive', 'match']);
  });

  test("待核对: a punch on a colleague's phone waits until a manager lets it stand", async () => {
    const f = fixture();
    await staffReady();
    await colleagueReady();
    await f.manager.attendance.policySave(anyPhoneAnywhere(f.storeId));
    // Bob on Ali's phone is flagged; Ali's own plain punch is not.
    const borrowed = await clock(f.staff(), { who: 'Bob', identify: true });
    await clock(f.staff(), { token: await passiveToken(f.staffId) });
    const waiting = async () =>
      (await f.manager.attendance.reviewQueue({ storeId: f.storeId })).punches.map((p) => p.id);
    expect(await waiting()).toEqual([borrowed.id]);
    await expectError(
      f.staff().attendance.reviewQueue({ storeId: f.storeId }),
      'auth.errors.missingPermission',
    );
    await f.manager.attendance.reviewPunch({ storeId: f.storeId, punchId: borrowed.id });
    expect(await waiting()).toEqual([]);
  });

  test('a new phone: the turns first, then it clocks, flagged', async () => {
    const f = fixture();
    await staffReady();
    await f.manager.attendance.policySave({ ...anyPhoneAnywhere(f.storeId), requireDevice: true });
    // The first punch binds Ali's phone.
    await clock(f.staff());
    await expectError(
      clock(f.staff(), { kind: 'out', device: DEVICE, token: await passiveToken(f.staffId) }),
      'attendance.errors.livenessNeeded',
    );
    const moved = await clock(f.staff(), { kind: 'out', device: DEVICE });
    expect([moved.newDevice, moved.face]).toEqual([true, 'match']);
    const queue = await f.manager.attendance.reviewQueue({ storeId: f.storeId });
    expect(queue.punches.map((p) => p.id)).toEqual([moved.id]);
    expect(await botRecipients('attendance.newDevice')).toEqual([f.managerUserId]);
  });
});

describe.skipIf(!SHOULD_RUN)('attendance blink and open mouth (2026-11-07)', () => {
  test('every punch: both movements, real, the same person, not a copy', async () => {
    const f = fixture();
    await staffReady();
    await f.manager.attendance.policySave(anyPhoneAnywhere(f.storeId));
    // Every challenge asks for both, in either order, turns or not.
    const plain = await f.staff().attendance.livenessChallenge({ storeId: f.storeId });
    expect([...plain.acts].sort()).toEqual(['blink', 'mouth']);
    const token = () => passiveToken(f.staffId);

    await expectError(
      clock(f.staff(), { token: await token(), blink: null }),
      'attendance.errors.livenessRequired',
    );
    await expectError(
      clock(f.staff(), { token: await token(), mouth: 'Bob:mouth' }),
      'attendance.errors.livenessFailed',
    );
    // The straight photo sent again as the blink.
    await expectError(
      clock(f.staff(), { token: await token(), blink: 'Ali:front' }),
      'attendance.errors.livenessFailed',
    );
    await expectError(
      clock(f.staff(), { token: await token(), blink: 'nobody' }),
      'attendance.errors.livenessFailed',
    );
    const challenge = await token();
    const refused = await errorOf(() =>
      clock(f.staff(), { token: challenge, blink: 'Ali:front', mouth: 'Cat:mouth' }),
    );
    // Either order: the server picks the order of the movements.
    expect(
      (refused?.cause as { context?: { failures?: string } } | undefined)?.context?.failures
        ?.split(',')
        .sort(),
    ).toEqual(['otherPerson', 'sameFrame']);

    const ok = await clock(f.staff(), { token: await token() });
    expect([ok.liveness, ok.face]).toEqual(['passive', 'match']);

    // A challenge signed before the change asks for no movements.
    const old = (
      await signLivenessToken({
        org: f.orgId,
        mid: f.staffId,
        by: f.staffId,
        storeId: f.storeId,
        steps: [],
        acts: [],
      })
    ).token;
    const out = await clock(f.staff(), {
      kind: 'out',
      token: old,
      blink: null,
      mouth: null,
    });
    expect(out.kind).toBe('out');
  });
});

describe.skipIf(!SHOULD_RUN)('attendance review fixes (2026-11-07)', () => {
  const turns = async () => {
    const f = fixture();
    const challenge = await f.staff().attendance.livenessChallenge({
      storeId: f.storeId,
      force: true,
    });
    return challenge.token;
  };

  test('a printed straight frame does not pass on the strength of live movements', async () => {
    const f = fixture();
    await staffReady();
    await f.manager.attendance.policySave(anyPhoneAnywhere(f.storeId));
    // Mean real-face over the frames was 0.65 and went through.
    await expectError(
      clock(f.staff(), { token: await turns(), face: 'Ali:front:print' }),
      'attendance.errors.livenessFailed',
    );
  });

  test('the movements must be the enrolled person, not someone like the photo', async () => {
    const f = fixture();
    await staffReady();
    const challenge = await turns();
    const refused = await errorOf(() =>
      clock(f.staff(), {
        token: challenge,
        face: 'Ali:front:half',
        blink: 'Dan:blink',
        mouth: 'Dan:mouth',
        left: 'Dan:left',
        right: 'Dan:right',
      }),
    );
    expect(refused?.message).toBe('attendance.errors.livenessFailed');
    expect((refused?.cause as { context?: unknown } | undefined)?.context).toEqual({
      failures: 'otherPerson',
    });
  });

  test('pictures sent before are refused: an earlier punch, an enrollment photo', async () => {
    const f = fixture();
    await staffReady();
    const first = await clock(f.staff(), { token: await passiveToken(f.staffId), seq: 7001 });
    expect(first.kind).toBe('in');
    await expectError(
      clock(f.staff(), { kind: 'out', token: await passiveToken(f.staffId), seq: 7001 }),
      'attendance.errors.photoReused',
    );
    // The enrollment's own photos.
    await expectError(
      clock(f.staff(), { kind: 'out', token: await passiveToken(f.staffId), seq: null }),
      'attendance.errors.photoReused',
    );
    // New pictures clock as usual.
    const out = await clock(f.staff(), { kind: 'out', token: await passiveToken(f.staffId) });
    expect(out.kind).toBe('out');
  });

  test("a colleague's face only somewhat like them is not enough to clock them", async () => {
    const f = fixture();
    await staffReady();
    await colleagueReady();
    await expectError(
      clock(f.staff(), {
        identify: true,
        face: 'Bob:front:half',
        blink: 'Bob:blink:half',
        mouth: 'Bob:mouth:half',
        left: 'Bob:left:half',
        right: 'Bob:right:half',
      }),
      'attendance.errors.notRecognized',
    );
    // Bob's own face is known on Ali's phone.
    expect((await clock(f.staff(), { who: 'Bob', identify: true })).forName).toBe('Att Colleague');
  });
});

describe.skipIf(!SHOULD_RUN)('attendance straight-on punch (2026-11-07)', () => {
  /**
   * Ali and Bob ready to clock. Bob's shift ended an hour ago; he clocked
   * in at its start. Returns the shift's date.
   */
  async function bobsShiftOver(): Promise<string> {
    const f = fixture();
    await staffReady();
    await colleagueReady();
    const start = new Date(Date.now() - 5 * 3600_000);
    const end = new Date(Date.now() - 3600_000);
    await f.manager.attendance.shiftSave({
      storeId: f.storeId,
      memberId: f.colleagueId,
      date: dateInTz(start, TZ),
      start: attendance.localTime(start, TZ),
      end: attendance.localTime(end, TZ),
    });
    await f.manager.attendance.manualPunch({
      storeId: f.storeId,
      memberId: f.colleagueId,
      kind: 'in',
      date: dateInTz(start, TZ),
      time: attendance.localTime(start, TZ),
      reason: 'test',
    });
    return dateInTz(start, TZ);
  }
  /** Bob's face on Ali's phone, with a reason for the overtime. */
  const bobOnAlisPhone = () =>
    clock(fixture().staff(), { who: 'Bob', identify: true, overtimeReason: 'stocktake' });

  test("on a colleague's phone, the overtime question says whose it is", async () => {
    const f = fixture();
    await bobsShiftOver();
    const asked = await refusal(clock(f.staff(), { who: 'Bob', identify: true }));
    expect(asked.message).toBe('attendance.errors.overtimeReasonRequired');
    expect(asked.context?.name).toBe('Att Colleague');
    expect(Number(asked.context?.minutes)).toBeGreaterThanOrEqual(59);
    const out = await bobOnAlisPhone();
    expect([out.kind, out.forName]).toEqual(['out', 'Att Colleague']);
  });

  test('found again within two minutes, on any phone: the same punch, not his next', async () => {
    const f = fixture();
    await bobsShiftOver();
    await bobOnAlisPhone();
    const again = await refusal(bobOnAlisPhone());
    expect(again.message).toBe('attendance.errors.justPunched');
    expect(again.context).toMatchObject({ lastKind: 'out', name: 'Att Colleague' });
    expect(String(again.context?.time)).toMatch(/^\d{2}:\d{2}$/);
    // On his own phone the kind is his to say; the refusal says when he did.
    const own = await refusal(clock(f.colleague(), { who: 'Bob', kind: 'out', device: DEVICE }));
    expect(own.message).toBe('attendance.errors.notClockedIn');
    expect(own.context?.lastKind).toBe('out');
  });

  test('"not them": only the phone that made it, only once, and its overtime goes too', async () => {
    const f = fixture();
    // The overtime is on the shift's day: after midnight, that is not the
    // clock-out's own day (review TEST1-08).
    const date = await bobsShiftOver();
    const out = await bobOnAlisPhone();
    const sheet = () => f.manager.attendance.sheet({ storeId: f.storeId, from: date, to: date });
    const pendingOvertime = async () =>
      (await sheet()).overtime.filter((o) => o.punchId === out.id && o.status === 'pending');
    expect(await pendingOvertime()).toHaveLength(1);
    await expectError(
      f.colleague().attendance.punchUndo({ storeId: f.storeId, punchId: out.id }),
      'attendance.errors.undoNotYours',
    );
    // A manager voids it from the sheet, with a reason; this is not that.
    await expectError(
      f.manager.attendance.punchUndo({ storeId: f.storeId, punchId: out.id }),
      'attendance.errors.notEnabled',
    );
    await f.staff().attendance.punchUndo({ storeId: f.storeId, punchId: out.id });
    await expectError(
      f.staff().attendance.punchUndo({ storeId: f.storeId, punchId: out.id }),
      'attendance.errors.alreadyVoided',
    );
    const row = (await sheet()).punches.find((p) => p.id === out.id)!;
    expect([row.voided?.reason, row.voided?.byName]).toEqual([
      'attendance.voidReason.wrongPerson',
      'Att Staff',
    ]);
    // Its overtime is no longer waiting for anyone.
    expect(await pendingOvertime()).toEqual([]);
    expect(await botRecipients('attendance.punchUndone')).toEqual([f.managerUserId]);
    expect(await botRecipients('attendance.punchUndoneForYou')).toEqual([f.colleagueUserId]);
  });

  test('ATT-02: after a "not them", that face is not taken for him on this phone for a while', async () => {
    const f = fixture();
    await bobsShiftOver();
    // A "not them" on this phone a while ago leaves the face look alone.
    await getDb(undefined, { system: 'maintenance' })
      .insert(s.attendancePunches)
      .values({
        orgId: f.orgId,
        storeId: f.storeId,
        memberId: f.colleagueId,
        kind: 'in',
        punchedAt: new Date(Date.now() - 9 * 60_000),
        source: 'self',
        createdByMemberId: f.staffId,
        viaMemberId: f.staffId,
        voidedAt: new Date(Date.now() - 8 * 60_000),
        voidedByMemberId: f.staffId,
        voidReason: 'attendance.voidReason.wrongPerson',
      });
    const out = await bobOnAlisPhone();
    await f.staff().attendance.punchUndo({ storeId: f.storeId, punchId: out.id });
    // Taken back just now: the person clocking is told they were not
    // recognized, instead of punching him once more.
    const sameFace = await refusal(bobOnAlisPhone());
    expect(sameFace.message).toBe('attendance.errors.notRecognized');
    // The voided punch holds nothing up: his own clock-out goes through.
    const right = await clock(f.colleague(), {
      who: 'Bob',
      kind: 'out',
      device: DEVICE,
      overtimeReason: 'stocktake',
    });
    expect(right.kind).toBe('out');
  });

  test('after two minutes, "not them" is for a manager to do', async () => {
    const f = fixture();
    await staffReady();
    const [old] = await getDb(undefined, { system: 'maintenance' })
      .insert(s.attendancePunches)
      .values({
        orgId: f.orgId,
        storeId: f.storeId,
        memberId: f.colleagueId,
        kind: 'in',
        punchedAt: new Date(Date.now() - 5 * 60_000),
        source: 'self',
        createdByMemberId: f.staffId,
        viaMemberId: f.staffId,
      })
      .returning({ id: s.attendancePunches.id });
    await expectError(
      f.staff().attendance.punchUndo({ storeId: f.storeId, punchId: old!.id }),
      'attendance.errors.undoTooLate',
    );
  });
});
