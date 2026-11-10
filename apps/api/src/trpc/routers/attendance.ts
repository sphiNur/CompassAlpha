/**
 * Attendance: clock in / out, the shift roster and the attendance sheet
 * (owner request 2026-11-05).
 *
 * - `attendance.clock` is switched on per member (a global allow override,
 *   `memberSet`); it is checked here for the concrete store, together with
 *   the member's assignment to that store.
 * - `attendance.manage` (store managers and up) plans shifts, reads the
 *   sheet, adds or voids punches with a reason and sets the store's rules.
 * - A self punch must pass the store's rules: the bound phone and the
 *   location radius. The time is the server's; offline punches are not
 *   accepted. (A store-network check was dropped 2026-11-05: a Mini App
 *   cannot read the Wi-Fi name and shop broadband addresses change.)
 * - Punches are never deleted; a correction voids one (trigger-enforced).
 * - Face only (owner decisions 2026-11-06): every self punch is checked by
 *   face in every store. A person first enrolls their face (six guided
 *   photos), a store manager approves it, and only then can they clock; a
 *   face that is not theirs is refused. Without a camera that works, a
 *   colleague's phone or a manager's manual punch is the way.
 */
import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, sql } from 'drizzle-orm';
import type { DB } from '@compass/db';
import { schema as s } from '@compass/db';
import {
  AttendanceCopyWeekInputSchema,
  AttendanceLivenessChallengeInputSchema,
  AttendanceExportLinkInputSchema,
  AttendanceManualPunchInputSchema,
  AttendanceMeInputSchema,
  AttendanceMemberSetInputSchema,
  AttendanceOvertimeDecideInputSchema,
  AttendancePunchPhotosInputSchema,
  AttendanceFaceEnrollDecideInputSchema,
  AttendanceFaceEnrollInputSchema,
  AttendanceFaceMemberInputSchema,
  AttendancePayRateSetInputSchema,
  AttendanceWageSuggestionsInputSchema,
  AttendancePolicyGetInputSchema,
  AttendancePolicySaveInputSchema,
  AttendancePunchInputSchema,
  AttendancePunchUndoInputSchema,
  AttendanceResetDeviceInputSchema,
  AttendanceSheetInputSchema,
  AttendanceShiftDeleteInputSchema,
  AttendanceShiftSaveInputSchema,
  AttendanceVoidPunchInputSchema,
  AttendanceFaceConsentInputSchema,
  AttendanceReviewPunchInputSchema,
  AttendanceReviewQueueInputSchema,
} from '@compass/contracts';
import {
  ATTENDANCE_FACE_CONSENT_VERSION,
  ATTENDANCE_UNDO_WINDOW_MS,
  locationVerdict,
} from '@compass/contracts/limits';
import { z } from 'zod';
import { attendance as rules, dateInTz, todayInTz } from '@compass/domain';
import { hub } from '../../realtime/hub';
import {
  assertActorAssignedToStore,
  effectivePermissionsForStore,
  getActorStoreIds,
} from '../../services/storeScope';
import { storeTimeZone } from '../../services/timeZone';
import { faceFeature, MATCH_THRESHOLD, type FaceResult } from '../../services/face';
import {
  bestScore,
  ENROLL_POSES,
  evaluateEnrollment,
  type EnrollPose,
} from '../../services/face/enroll';
import {
  CHECK_LINES,
  faceInGrayZone,
  identify,
  movesMatch,
  samePicture,
  spotCheck,
  type KnownFace,
} from '../../services/face/checks';
import {
  evaluateLiveness,
  evaluateActs,
  signLivenessToken,
  verifyLivenessToken,
  type LivenessVerdict,
} from '../../services/face/liveness';
import type { Act } from '../../services/face/liveness';
import { dispatch, findRecipientsByPermissionInStore } from '../../services/notify';
import { linkForStore } from '../../services/notifyForEvent';
import { exportFileName, monthRange, signExportToken } from '../../services/attendanceExport';
import type { RequestContext } from '../context';
import { authedProcedure, idempotentMutation, router } from '../trpc';
import { loadWageRoster } from './settlement';

type Session = {
  memberId: string;
  orgId: string;
  orgTimezone: string;
  permissions: ReadonlySet<string>;
  roleSlugs: ReadonlySet<string>;
};
type StoreRow = typeof s.stores.$inferSelect;
type PolicyRow = typeof s.attendanceStorePolicies.$inferSelect;

const DAY = 24 * 3600_000;
/** The longest range the sheet reads at once. */
const MAX_SHEET_DAYS = 62;
/** How far back 待核对 looks, and how many punches it lists at most. */
const REVIEW_DAYS = 14;
const REVIEW_LIMIT = 200;
/** What a "not them" punch is voided with; the sheet shows it translated. */
const WRONG_PERSON_REASON = 'attendance.voidReason.wrongPerson';
/** How long a colleague taken back as "not them" stays out of that phone's face look. */
const TAKEN_BACK_LEFT_OUT_MS = 5 * 60_000;

function fail(
  code: 'FORBIDDEN' | 'BAD_REQUEST' | 'NOT_FOUND' | 'CONFLICT',
  key: string,
  cause?: object,
): never {
  throw new TRPCError({ code, message: `attendance.errors.${key}`, cause });
}

export function hashDeviceId(deviceId: string): string {
  return createHash('sha256').update(`compass-attendance:${deviceId}`).digest('hex');
}

async function loadStore(tx: DB, session: Session, storeId: string): Promise<StoreRow> {
  const store = await tx.query.stores.findFirst({
    where: (st, { and: and2, eq: eq2 }) => and2(eq2(st.id, storeId), eq2(st.orgId, session.orgId)),
  });
  if (!store || store.deletedAt) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.storeNotFound' });
  }
  return store;
}

async function authorize(
  tx: DB,
  session: Session,
  storeId: string,
  permission: 'attendance.clock' | 'attendance.manage',
): Promise<StoreRow> {
  const store = await loadStore(tx, session, storeId);
  await assertActorAssignedToStore(tx, session.memberId, storeId, session.permissions);
  const effective = await effectivePermissionsForStore(
    tx,
    session.memberId,
    storeId,
    session.permissions,
  );
  if (!effective.has(permission)) {
    if (permission === 'attendance.clock') fail('FORBIDDEN', 'notEnabled');
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'auth.errors.missingPermission',
      cause: { missingPermission: permission },
    });
  }
  return store;
}

/** `"123.45"` → 12345; amounts are validated two-decimal strings. */
function moneyToCents(value: string): number {
  const [whole = '0', frac = ''] = value.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0').slice(0, 2));
}

function centsToMoney(cents: number): string {
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

function tzOf(store: StoreRow, session: Session): string {
  return storeTimeZone(store.timezone, session.orgTimezone);
}

async function loadPolicy(tx: DB, storeId: string): Promise<PolicyRow | undefined> {
  return tx.query.attendanceStorePolicies.findFirst({
    where: (p, { eq: eq2 }) => eq2(p.storeId, storeId),
  });
}

function policyView(p: PolicyRow | undefined) {
  return {
    requireDevice: p?.requireDevice ?? true,
    requireGeo: p?.requireGeo ?? false,
    geo:
      p?.geoLat != null && p.geoLng != null && p.geoRadiusM != null
        ? { lat: Number(p.geoLat), lng: Number(p.geoLng), radiusM: p.geoRadiusM }
        : null,
    graceMinutes: p?.graceMinutes ?? 5,
    overtimeAfterMinutes: p?.overtimeAfterMinutes ?? 30,
    // Face only, in every store (owner decision 2026-11-06).
    requirePhoto: true,
    requireFace: true,
    requireLiveness: true,
    /** A photo of the place too (off by default since 2026-11-06). */
    // The place photo was removed (owner, 2026-11-07): never asked for.
    requireScene: false,
  };
}

type FaceVerdict = {
  result: 'match' | 'mismatch' | 'unchecked';
  score: number | null;
};

/** Approved enrollments' features, per member. */
async function enrolledFeatures(
  tx: DB,
  memberIds: readonly string[],
): Promise<Map<string, number[][]>> {
  const out = new Map<string, number[][]>();
  if (memberIds.length === 0) return out;
  const rows = await tx
    .select({
      memberId: s.attendanceFaceEnrollments.memberId,
      feature: s.attendanceFaceSamples.feature,
    })
    .from(s.attendanceFaceSamples)
    .innerJoin(
      s.attendanceFaceEnrollments,
      eq(s.attendanceFaceEnrollments.id, s.attendanceFaceSamples.enrollmentId),
    )
    .where(
      and(
        inArray(s.attendanceFaceEnrollments.memberId, [...memberIds]),
        eq(s.attendanceFaceEnrollments.status, 'approved'),
      ),
    );
  for (const r of rows) {
    const list = out.get(r.memberId) ?? [];
    list.push(r.feature);
    out.set(r.memberId, list);
  }
  return out;
}

/**
 * The face photo against a person's approved enrollment (`features`, the
 * best of its photos counts). `checked` is the worker's answer; null = the
 * check could not run. Null when the person has no approved enrollment.
 */
function faceCompare(
  features: readonly (readonly number[])[] | undefined,
  checked: FaceResult | null,
): FaceVerdict | null {
  if (!features?.length) return null;
  if (!checked || !checked.found) return { result: 'unchecked', score: null };
  const score = bestScore(features, checked.feature) ?? -1;
  return { result: score >= MATCH_THRESHOLD ? 'match' : 'mismatch', score };
}

/** One frame of a punch: what is kept of it to refuse it if sent again. */
interface FramePrint {
  kind: 'face' | 'blink' | 'mouth' | 'left' | 'right';
  sha256: Buffer;
  feature: number[];
}

const print = (kind: FramePrint['kind'], bytes: Buffer, feature: number[]): FramePrint => ({
  kind,
  sha256: createHash('sha256').update(bytes).digest(),
  feature,
});

/** Frames compared feature by feature with the new ones: the latest this many. */
const FRAME_PRINTS_COMPARED = 400;

/**
 * Whether one of `prints` was sent before for `memberId` (2026-11-07): the
 * same bytes as a kept frame, or the same picture as a recent frame or an
 * enrollment photo. A person in front of the camera never gives the same
 * picture twice; saved pictures do.
 */
async function framesSeenBefore(
  tx: DB,
  memberId: string,
  prints: readonly FramePrint[],
  enrolled: readonly (readonly number[])[],
): Promise<boolean> {
  const sameBytes = await tx
    .select({ id: s.attendancePunchFrames.id })
    .from(s.attendancePunchFrames)
    .where(
      and(
        eq(s.attendancePunchFrames.memberId, memberId),
        inArray(
          s.attendancePunchFrames.sha256,
          prints.map((p) => p.sha256),
        ),
      ),
    )
    .limit(1);
  if (sameBytes.length > 0) return true;
  const recent = await tx
    .select({ feature: s.attendancePunchFrames.feature })
    .from(s.attendancePunchFrames)
    .where(eq(s.attendancePunchFrames.memberId, memberId))
    .orderBy(desc(s.attendancePunchFrames.takenAt))
    .limit(FRAME_PRINTS_COMPARED);
  return samePicture(
    prints.map((p) => p.feature),
    [...recent.map((r) => r.feature), ...enrolled],
  );
}

type EnrollmentRow = typeof s.attendanceFaceEnrollments.$inferSelect;

/** The person's face enrollment state: the one in use and the latest one. */
async function enrollmentState(tx: DB, memberId: string) {
  const rows = await tx
    .select()
    .from(s.attendanceFaceEnrollments)
    .where(eq(s.attendanceFaceEnrollments.memberId, memberId))
    .orderBy(sql`${s.attendanceFaceEnrollments.createdAt} DESC`)
    .limit(5);
  const approved = rows.find((r) => r.status === 'approved') ?? null;
  const latest: EnrollmentRow | null = rows[0] ?? null;
  return { approved, latest };
}

/** What the person sees: in use, waiting, sent back, or nothing yet. */
function enrollmentView(state: Awaited<ReturnType<typeof enrollmentState>>) {
  const { approved, latest } = state;
  return {
    status: approved ? ('approved' as const) : (latest?.status ?? ('none' as const)),
    approvedAt: approved?.decidedAt?.toISOString() ?? null,
    /** A newer enrollment waiting or sent back while an older one is in use. */
    pending: latest?.status === 'pending',
    rejectedNote: latest?.status === 'rejected' ? (latest.note ?? null) : null,
  };
}

/** Face, the two liveness turns, then the place. */
const PHOTO_ORDER = ['face', 'left', 'right', 'scene'] as const;

/** Largest photo the server keeps (the column's own limit). */
const MAX_PHOTO_BYTES = 600_000;

/** A base64 photo from the client → JPEG bytes, or refused. */
function photoBytes(b64: string): Buffer {
  const bytes = Buffer.from(b64, 'base64');
  const jpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!jpeg || bytes.length > MAX_PHOTO_BYTES) fail('BAD_REQUEST', 'photoInvalid');
  return bytes;
}

/** Active members working at the store (assignment or store role). */
async function storeRoster(tx: DB, orgId: string, storeId: string) {
  return loadWageRoster(tx, orgId, storeId);
}

async function assertInStore(tx: DB, orgId: string, storeId: string, memberId: string) {
  const roster = await storeRoster(tx, orgId, storeId);
  const person = roster.find((m) => m.memberId === memberId);
  if (!person) fail('BAD_REQUEST', 'memberNotInStore');
  return person;
}

/**
 * Clocking `memberId` in on this member's phone: a colleague at the same
 * store who clocks there (owner decision 2026-11-06: same store only).
 */
async function assertColleague(tx: DB, session: Session, storeId: string, memberId: string) {
  if (memberId === session.memberId) return;
  const roster = await storeRoster(tx, session.orgId, storeId);
  const enabled = await clockEnabled(tx, [memberId]);
  if (!roster.some((m) => m.memberId === memberId) || !enabled.has(memberId)) {
    fail('FORBIDDEN', 'notColleague');
  }
}

/**
 * A super admin handles their own attendance: approves their own face,
 * fixes their own punches, sets their own wage, decides their own
 * overtime. Other managers do not (owner decisions 2026-11-06 / 2026-11-07).
 */
function handlesOwn(session: Session): boolean {
  return session.roleSlugs.has('super_admin');
}

/** Refuses a manager's action on their own attendance (see `handlesOwn`). */
function refuseOwn(session: Session, memberId: string): void {
  if (memberId === session.memberId && !handlesOwn(session)) fail('FORBIDDEN', 'manageOwn');
}

function publish(orgId: string, storeId: string): void {
  hub.publish(orgId, { type: 'attendance.changed', orgId, storeId });
}

/** Who has `attendance.clock` through the global allow override. */
async function clockEnabled(tx: DB, memberIds: readonly string[]): Promise<Set<string>> {
  if (memberIds.length === 0) return new Set();
  const now = new Date();
  const rows = await tx
    .select({
      memberId: s.memberPermissionOverrides.memberId,
      effect: s.memberPermissionOverrides.effect,
      expiresAt: s.memberPermissionOverrides.expiresAt,
    })
    .from(s.memberPermissionOverrides)
    .where(
      and(
        inArray(s.memberPermissionOverrides.memberId, [...memberIds]),
        eq(s.memberPermissionOverrides.permissionKey, 'attendance.clock'),
        eq(s.memberPermissionOverrides.scopeType, 'global'),
      ),
    );
  const out = new Set<string>();
  for (const r of rows) {
    if (r.expiresAt && r.expiresAt <= now) continue;
    if (r.effect === 'allow') out.add(r.memberId);
  }
  for (const r of rows) if (r.effect === 'deny') out.delete(r.memberId);
  return out;
}

/** The challenge's `mid` when the face itself says whose punch it is. */
const IDENTIFY_MEMBER = '*';

async function hasFaceConsent(tx: DB, memberId: string): Promise<boolean> {
  const row = await tx.query.attendanceFaceConsents.findFirst({
    where: (c, { eq: eq2 }) => eq2(c.memberId, memberId),
  });
  return !!row;
}

/**
 * The store's people with a face reference who agreed to its use:
 * candidates for "whose face is this". `colleagues` keeps only those who
 * clock in (a borrowed phone may only clock a colleague).
 */
async function knownFaces(
  tx: DB,
  orgId: string,
  storeId: string,
  opts: { except?: string; colleagues?: boolean } = {},
): Promise<KnownFace[]> {
  const roster = await storeRoster(tx, orgId, storeId);
  let ids = roster.map((m) => m.memberId).filter((id) => id !== opts.except);
  if (opts.colleagues) {
    const enabled = await clockEnabled(tx, ids);
    ids = ids.filter((id) => enabled.has(id));
  }
  if (ids.length === 0) return [];
  const consented = await tx
    .select({ memberId: s.attendanceFaceConsents.memberId })
    .from(s.attendanceFaceConsents)
    .where(inArray(s.attendanceFaceConsents.memberId, ids));
  const agreed = new Set(consented.map((r) => r.memberId));
  const features = await enrolledFeatures(
    tx,
    ids.filter((id) => agreed.has(id)),
  );
  const names = new Map(roster.map((m) => [m.memberId, m.displayName]));
  return [...features].map(([memberId, list]) => ({
    memberId,
    name: names.get(memberId) ?? '—',
    features: list,
  }));
}

/**
 * Risk signals before a punch: a phone other than the bound one, and the
 * 1-in-3 spot check (keyed on the person, the store's day and how many
 * punches they made there today).
 */
async function punchRisk(tx: DB, session: Session, store: StoreRow, deviceId: string | null) {
  const device = await tx.query.attendanceDevices.findFirst({
    where: (d, { eq: eq2 }) => eq2(d.memberId, session.memberId),
  });
  const newDevice = !!device && (!deviceId || device.deviceHash !== hashDeviceId(deviceId));
  const tz = tzOf(store, session);
  const today = todayInTz(tz);
  const since = new Date(Date.now() - 2 * DAY);
  const recent = await tx
    .select({ at: s.attendancePunches.punchedAt })
    .from(s.attendancePunches)
    .where(
      and(
        eq(s.attendancePunches.memberId, session.memberId),
        eq(s.attendancePunches.storeId, store.id),
        isNull(s.attendancePunches.voidedAt),
        gte(s.attendancePunches.punchedAt, since),
      ),
    );
  const punchesToday = recent.filter((r) => dateInTz(r.at, tz) === today).length;
  return { newDevice, spot: spotCheck(session.memberId, today, punchesToday) };
}

function shiftView(row: typeof s.attendanceShifts.$inferSelect, tz: string) {
  return {
    id: row.id,
    memberId: row.memberId,
    date: row.shiftDate,
    start: rules.localTime(row.startsAt, tz),
    end: rules.localTime(row.endsAt, tz),
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    note: row.note,
  };
}

async function overlaps(
  tx: DB,
  memberId: string,
  startsAt: Date,
  endsAt: Date,
  exceptId?: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: s.attendanceShifts.id })
    .from(s.attendanceShifts)
    .where(
      and(
        eq(s.attendanceShifts.memberId, memberId),
        lt(s.attendanceShifts.startsAt, endsAt),
        gt(s.attendanceShifts.endsAt, startsAt),
        exceptId ? ne(s.attendanceShifts.id, exceptId) : undefined,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** The attendance sheet for one store and date range (manager only). */
/**
 * The attendance sheet for one store and date range. Callers authorize:
 * the sheet itself needs attendance.manage, the settlement's wage
 * suggestion settlement.record.
 */
async function buildSheet(tx: DB, session: Session, store: StoreRow, from: string, to: string) {
  const tz = tzOf(store, session);
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY + 1;
  if (days > MAX_SHEET_DAYS) fail('BAD_REQUEST', 'rangeTooLong');
  const fromAt = new Date(rules.zonedTimeToUtc(from, '00:00', tz).getTime() - DAY);
  const toAt = new Date(rules.zonedTimeToUtc(rules.nextDate(to), '00:00', tz).getTime() + DAY);
  const now = new Date();
  const [roster, policy, shifts, punches, devices, rates, overtime] = await Promise.all([
    storeRoster(tx, session.orgId, store.id),
    loadPolicy(tx, store.id),
    tx
      .select()
      .from(s.attendanceShifts)
      .where(
        and(
          eq(s.attendanceShifts.storeId, store.id),
          gte(s.attendanceShifts.shiftDate, rules.nextDate(from, -1)),
          lte(s.attendanceShifts.shiftDate, to),
        ),
      )
      .orderBy(asc(s.attendanceShifts.startsAt)),
    tx
      .select()
      .from(s.attendancePunches)
      .where(
        and(
          eq(s.attendancePunches.storeId, store.id),
          gte(s.attendancePunches.punchedAt, fromAt),
          lte(s.attendancePunches.punchedAt, toAt),
        ),
      )
      .orderBy(asc(s.attendancePunches.punchedAt)),
    tx
      .select({ memberId: s.attendanceDevices.memberId, boundAt: s.attendanceDevices.boundAt })
      .from(s.attendanceDevices)
      .where(eq(s.attendanceDevices.orgId, session.orgId)),
    tx
      .select()
      .from(s.attendancePayRates)
      .where(
        and(
          eq(s.attendancePayRates.orgId, session.orgId),
          lte(s.attendancePayRates.effectiveFrom, to),
        ),
      )
      .orderBy(asc(s.attendancePayRates.effectiveFrom)),
    // By the clock-out it belongs to, as the punches above. It was by the
    // record's creation time, so the overtime of a clock-out a manager
    // entered days later was in no sheet and no export.
    tx
      .select({ overtime: s.attendanceOvertime })
      .from(s.attendanceOvertime)
      .innerJoin(s.attendancePunches, eq(s.attendancePunches.id, s.attendanceOvertime.punchId))
      .where(
        and(
          eq(s.attendanceOvertime.storeId, store.id),
          gte(s.attendancePunches.punchedAt, fromAt),
          lte(s.attendancePunches.punchedAt, toAt),
        ),
      )
      .then((rows) => rows.map((r) => r.overtime)),
  ]);
  const photoRows =
    punches.length === 0
      ? []
      : await tx
          .select({
            punchId: s.attendancePhotos.punchId,
            kind: s.attendancePhotos.kind,
            faceResult: s.attendancePhotos.faceResult,
            faceScore: s.attendancePhotos.faceScore,
            faceLikeMemberId: s.attendancePhotos.faceLikeMemberId,
          })
          .from(s.attendancePhotos)
          .where(
            inArray(
              s.attendancePhotos.punchId,
              punches.map((p) => p.id),
            ),
          );
  const photoKinds = new Map<string, ('face' | 'scene' | 'left' | 'right')[]>();
  const faceOf = new Map<string, { result: string; score: number | null }>();
  const faceLikeOf = new Map<string, string>();
  for (const ph of photoRows) {
    photoKinds.set(ph.punchId, [...(photoKinds.get(ph.punchId) ?? []), ph.kind]);
    if (ph.faceResult) faceOf.set(ph.punchId, { result: ph.faceResult, score: ph.faceScore });
    if (ph.faceLikeMemberId) faceLikeOf.set(ph.punchId, ph.faceLikeMemberId);
  }
  const reviewed =
    punches.length === 0
      ? new Set<string>()
      : new Set(
          (
            await tx
              .select({ punchId: s.attendancePunchReviews.punchId })
              .from(s.attendancePunchReviews)
              .where(
                inArray(
                  s.attendancePunchReviews.punchId,
                  punches.map((p) => p.id),
                ),
              )
          ).map((r) => r.punchId),
        );
  const memberIds = new Set([
    ...roster.map((m) => m.memberId),
    ...shifts.map((x) => x.memberId),
    ...punches.map((x) => x.memberId),
  ]);
  const enabled = await clockEnabled(tx, [...memberIds]);
  const names = new Map(roster.map((m) => [m.memberId, m.displayName]));
  const missingNames = [...memberIds].filter((id) => !names.has(id));
  const actorIds = punches
    .flatMap((p) => [p.createdByMemberId, p.voidedByMemberId, p.viaMemberId])
    .concat(overtime.map((o) => o.decidedByMemberId ?? ''))
    .concat([...faceLikeOf.values()])
    .filter((x): x is string => !!x);
  const extra = [...new Set([...missingNames, ...actorIds])];
  if (extra.length > 0) {
    const rows = await tx
      .select({ memberId: s.members.id, displayName: s.users.displayName })
      .from(s.members)
      .innerJoin(s.users, eq(s.users.id, s.members.userId))
      .where(inArray(s.members.id, extra));
    for (const r of rows) if (!names.has(r.memberId)) names.set(r.memberId, r.displayName);
  }
  const deviceBound = new Map(devices.map((d) => [d.memberId, d.boundAt]));
  // Each person's face enrollment: in use, waiting, sent back or none.
  const enrollments = await tx
    .select({
      memberId: s.attendanceFaceEnrollments.memberId,
      status: s.attendanceFaceEnrollments.status,
    })
    .from(s.attendanceFaceEnrollments)
    .where(eq(s.attendanceFaceEnrollments.orgId, session.orgId))
    .orderBy(asc(s.attendanceFaceEnrollments.createdAt));
  const faceStatus = new Map<string, 'approved' | 'pending' | 'rejected'>();
  // The one in use wins; otherwise the latest.
  for (const e of enrollments) {
    if (faceStatus.get(e.memberId) !== 'approved') faceStatus.set(e.memberId, e.status);
  }
  const view = policyView(policy);
  const allDays = rules.summarize({
    shifts: shifts.map((x) => ({
      id: x.id,
      memberId: x.memberId,
      date: x.shiftDate,
      startsAt: x.startsAt,
      endsAt: x.endsAt,
    })),
    punches: punches
      .filter((p) => !p.voidedAt)
      .map((p) => ({ id: p.id, memberId: p.memberId, kind: p.kind, at: p.punchedAt })),
    graceMinutes: view.graceMinutes,
    now,
    dateOf: (at) => dateInTz(at, tz),
  });
  const summaries = allDays.filter((d) => d.date >= from && d.date <= to);
  // The day each punch counts for (2026-11-10): its shift's, so an overnight
  // shift keeps its early-morning out, as in the rows above; else its own
  // date. The export and the overtime used the punch's own date, so after
  // a clock-out past midnight the shift's row had the hours but not the
  // clock-out or its overtime.
  const dayOfPunch = new Map<string, string>();
  for (const d of allDays) for (const id of d.punchIds) dayOfPunch.set(id, d.date);
  const dayOf = (p: { id: string; punchedAt: Date }) =>
    dayOfPunch.get(p.id) ?? dateInTz(p.punchedAt, tz);
  const rosterIds = new Set(roster.map((m) => m.memberId));
  // The rate a day is paid at: the latest one in effect on that date.
  const rateOn = (memberId: string, date: string): string | null => {
    let found: string | null = null;
    for (const r of rates)
      if (r.memberId === memberId && r.effectiveFrom <= date) found = r.dailyWage;
    return found;
  };
  const voidedPunch = new Set(punches.filter((p) => p.voidedAt).map((p) => p.id));
  const punchById = new Map(punches.map((p) => [p.id, p]));
  const overtimeView = overtime
    .filter((o) => !voidedPunch.has(o.punchId) && punchById.has(o.punchId))
    .map((o) => ({
      id: o.id,
      memberId: o.memberId,
      punchId: o.punchId,
      date: dayOf(punchById.get(o.punchId)!),
      minutes: o.minutes,
      reason: o.reason,
      status: o.status,
      decidedByName: o.decidedByMemberId ? (names.get(o.decidedByMemberId) ?? null) : null,
      decisionNote: o.decisionNote,
    }))
    // Only the sheet's days: the export's totals counted the day before
    // and the days after too.
    .filter((o) => o.date >= from && o.date <= to);
  return {
    timezone: tz,
    today: todayInTz(tz, now),
    graceMinutes: view.graceMinutes,
    /** The store's clock-in area, for the map. */
    geo: view.geo,
    requireFace: view.requireFace,
    requireLiveness: view.requireLiveness,
    members: [...memberIds]
      .map((id) => ({
        memberId: id,
        name: names.get(id) ?? '—',
        inStore: rosterIds.has(id),
        enabled: enabled.has(id),
        /** The manager's own row: only a super admin changes it (2026-11-07). */
        own: id === session.memberId && !handlesOwn(session),
        deviceBoundAt: deviceBound.get(id)?.toISOString() ?? null,
        face: faceStatus.get(id) ?? ('none' as const),
        dailyWage: rateOn(id, to),
      }))
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name)),
    shifts: shifts.filter((x) => x.shiftDate >= from).map((x) => shiftView(x, tz)),
    punches: punches.map((p) => ({
      id: p.id,
      memberId: p.memberId,
      kind: p.kind,
      at: p.punchedAt.toISOString(),
      date: dateInTz(p.punchedAt, tz),
      /** The day it counts for; `date` is the day it was made on. */
      day: dayOf(p),
      time: rules.localTime(p.punchedAt, tz),
      source: p.source,
      reason: p.reason,
      distanceM: p.distanceM,
      /** Where the phone was (for the map), when it sent a location. */
      location:
        p.geoLat != null && p.geoLng != null
          ? { lat: Number(p.geoLat), lng: Number(p.geoLng), accuracyM: p.geoAccuracyM }
          : null,
      photos: photoKinds.get(p.id) ?? [],
      face: (faceOf.get(p.id) ?? null) as {
        result: 'match' | 'mismatch' | 'enrolled' | 'unchecked';
        score: number | null;
      } | null,
      liveness: p.liveness,
      livenessScore: p.livenessScore,
      viaName: p.viaMemberId ? (names.get(p.viaMemberId) ?? '—') : null,
      faceLikeName: faceLikeOf.has(p.id) ? (names.get(faceLikeOf.get(p.id)!) ?? '—') : null,
      newDevice: p.newDevice,
      reviewed: reviewed.has(p.id),
      createdByName: p.source === 'manual' ? (names.get(p.createdByMemberId) ?? null) : null,
      voided: p.voidedAt
        ? {
            at: p.voidedAt.toISOString(),
            byName: p.voidedByMemberId ? (names.get(p.voidedByMemberId) ?? null) : null,
            reason: p.voidReason ?? '',
          }
        : null,
    })),
    days: summaries.map((d) => {
      const wage = rateOn(d.memberId, d.date);
      return {
        ...d,
        dailyWage: wage,
        pay: rules.dayPay(d, wage === null ? null : moneyToCents(wage)),
      };
    }),
    overtime: overtimeView,
  };
}

/**
 * The shift a clock-out at `at` belongs to (same window as the sheet:
 * four hours before the start to six after the end), and how many
 * overtime minutes it carries.
 */
async function overtimeFor(
  tx: DB,
  memberId: string,
  storeId: string,
  at: Date,
  afterMinutes: number,
): Promise<{ shiftId: string; minutes: number } | null> {
  const shifts = await tx
    .select({
      id: s.attendanceShifts.id,
      startsAt: s.attendanceShifts.startsAt,
      endsAt: s.attendanceShifts.endsAt,
    })
    .from(s.attendanceShifts)
    .where(
      and(
        eq(s.attendanceShifts.memberId, memberId),
        eq(s.attendanceShifts.storeId, storeId),
        lte(s.attendanceShifts.startsAt, new Date(at.getTime() + 4 * 3600_000)),
        gte(s.attendanceShifts.endsAt, new Date(at.getTime() - 6 * 3600_000)),
      ),
    );
  // The latest shift that has ended by then is the one being clocked out of.
  const ended = shifts
    .filter((x) => x.endsAt.getTime() <= at.getTime())
    .sort((a, b) => b.endsAt.getTime() - a.endsAt.getTime())[0];
  if (!ended) return null;
  const minutes = rules.overtimeMinutes(ended.endsAt, at, afterMinutes);
  return minutes > 0 ? { shiftId: ended.id, minutes } : null;
}

/**
 * ATT-02 (2026-11-09): the colleagues this phone's person took back as
 * "not them" a moment ago. The face in front of the camera is still the
 * one that matched them, and it matched them again: each round another
 * punch in their name and two more messages, while the person clocking
 * (often not enrolled) was never found. Left out, the face is not
 * recognized and the sheet says what to do instead.
 */
async function takenBackOnPhone(tx: DB, storeId: string, phoneMemberId: string) {
  const since = Date.now() - TAKEN_BACK_LEFT_OUT_MS;
  const rows = await tx
    .select({ memberId: s.attendancePunches.memberId })
    .from(s.attendancePunches)
    .where(
      and(
        eq(s.attendancePunches.storeId, storeId),
        // An undo comes within ATTENDANCE_UNDO_WINDOW_MS of the punch.
        gte(s.attendancePunches.punchedAt, new Date(since - ATTENDANCE_UNDO_WINDOW_MS)),
        eq(s.attendancePunches.viaMemberId, phoneMemberId),
        eq(s.attendancePunches.voidReason, WRONG_PERSON_REASON),
        gte(s.attendancePunches.voidedAt, new Date(since)),
      ),
    );
  return new Set(rows.map((r) => r.memberId));
}

/** A member's punches at a store in the last two days, voided ones left out. */
function recentPunches(tx: DB, memberId: string, storeId: string, now: Date) {
  return tx
    .select({ kind: s.attendancePunches.kind, at: s.attendancePunches.punchedAt })
    .from(s.attendancePunches)
    .where(
      and(
        eq(s.attendancePunches.memberId, memberId),
        eq(s.attendancePunches.storeId, storeId),
        isNull(s.attendancePunches.voidedAt),
        gte(s.attendancePunches.punchedAt, new Date(now.getTime() - 2 * DAY)),
      ),
    );
}

/** The latest of `punches`, or null. */
function latestPunch<T extends { at: Date }>(punches: readonly T[]): T | null {
  let last: T | null = null;
  for (const p of punches) if (!last || p.at.getTime() >= last.at.getTime()) last = p;
  return last;
}

/**
 * The overtime minutes a clock-out by this member would carry now (0: none,
 * or their next punch is a clock-in). The phone asks why before it opens
 * the camera (2026-11-07); the punch decides again at its own time.
 */
async function clockOutOvertime(tx: DB, memberId: string, storeId: string): Promise<number> {
  const now = new Date();
  const recent = await recentPunches(tx, memberId, storeId, now);
  if (rules.nextPunchKind(recent, now) !== 'out') return 0;
  const policy = policyView(await loadPolicy(tx, storeId));
  const overtime = await overtimeFor(tx, memberId, storeId, now, policy.overtimeAfterMinutes);
  return overtime?.minutes ?? 0;
}

async function loadSheet(ctx: RequestContext, input: z.infer<typeof AttendanceSheetInputSchema>) {
  const session = ctx.session!;
  return ctx.withOrg(async (tx) => {
    const store = await authorize(tx, session, input.storeId, 'attendance.manage');
    return buildSheet(tx, session, store, input.from, input.to);
  });
}

export type AttendanceSheetData = Awaited<ReturnType<typeof loadSheet>>;

async function loadPolicyView(ctx: RequestContext, storeId: string) {
  const session = ctx.session!;
  return ctx.withOrg(async (tx) => {
    const store = await authorize(tx, session, storeId, 'attendance.manage');
    const row = await loadPolicy(tx, store.id);
    return policyView(row);
  });
}

export type AttendancePolicyData = Awaited<ReturnType<typeof loadPolicyView>>;

/**
 * A month of the sheet for the spreadsheet export, checked against the
 * member's permission like the sheet itself. Runs inside the caller's org
 * transaction (the export route has no tRPC context).
 */
export async function loadMonthSheet(tx: DB, session: Session, storeId: string, month: string) {
  const store = await authorize(tx, session, storeId, 'attendance.manage');
  const { from, to } = monthRange(month);
  return { store, sheet: await buildSheet(tx, session, store, from, to) };
}

export const attendanceRouter = router({
  /** The clock screen: stores this member clocks at, today's shifts and punches. */
  me: authedProcedure.input(AttendanceMeInputSchema).query(async ({ ctx, input }) => {
    const session = ctx.session!;
    return ctx.withOrg(async (tx) => {
      const allowed = await getActorStoreIds(tx, session.memberId, session.permissions);
      const stores = await tx.query.stores.findMany({
        where: (st, { and: and2, eq: eq2, isNull: isNull2 }) =>
          and2(eq2(st.orgId, session.orgId), eq2(st.isActive, true), isNull2(st.deletedAt)),
        orderBy: (st, { asc: asc2 }) => [asc2(st.name)],
      });
      const device = await tx.query.attendanceDevices.findFirst({
        where: (d, { eq: eq2 }) => eq2(d.memberId, session.memberId),
      });
      const consent = await tx.query.attendanceFaceConsents.findFirst({
        where: (c, { eq: eq2 }) => eq2(c.memberId, session.memberId),
      });
      const enrollment = enrollmentView(await enrollmentState(tx, session.memberId));
      const now = new Date();
      const out = [];
      for (const store of stores) {
        if (allowed !== null && !allowed.includes(store.id)) continue;
        const perms = await effectivePermissionsForStore(
          tx,
          session.memberId,
          store.id,
          session.permissions,
        );
        if (!perms.has('attendance.clock')) continue;
        const tz = tzOf(store, session);
        const today = todayInTz(tz, now);
        const [policy, shifts, punches] = await Promise.all([
          loadPolicy(tx, store.id),
          tx
            .select()
            .from(s.attendanceShifts)
            .where(
              and(
                eq(s.attendanceShifts.memberId, session.memberId),
                eq(s.attendanceShifts.storeId, store.id),
                gte(s.attendanceShifts.shiftDate, rules.nextDate(today, -1)),
                lte(s.attendanceShifts.shiftDate, rules.nextDate(today, 7)),
              ),
            )
            .orderBy(asc(s.attendanceShifts.startsAt)),
          tx
            .select()
            .from(s.attendancePunches)
            .where(
              and(
                eq(s.attendancePunches.memberId, session.memberId),
                eq(s.attendancePunches.storeId, store.id),
                isNull(s.attendancePunches.voidedAt),
                gte(s.attendancePunches.punchedAt, new Date(now.getTime() - 2 * DAY)),
              ),
            )
            .orderBy(asc(s.attendancePunches.punchedAt)),
        ]);
        const view = policyView(policy);
        out.push({
          storeId: store.id,
          storeName: store.name,
          timezone: tz,
          today,
          rules: {
            requireDevice: view.requireDevice,
            requireGeo: view.requireGeo,
            geo: view.requireGeo ? view.geo : null,
            requirePhoto: view.requirePhoto,
            requireFace: view.requireFace,
            requireLiveness: view.requireLiveness,
            requireScene: view.requireScene,
          },
          nextKind: rules.nextPunchKind(
            punches.map((p) => ({ kind: p.kind, at: p.punchedAt })),
            now,
          ),
          shifts: shifts.map((row) => shiftView(row, tz)),
          punches: punches
            .filter(
              (p) =>
                dateInTz(p.punchedAt, tz) === today || now.getTime() - p.punchedAt.getTime() < DAY,
            )
            .map((p) => ({
              id: p.id,
              kind: p.kind,
              at: p.punchedAt.toISOString(),
              /** The store's day it fell on: yesterday's are listed too (ATT-05). */
              date: dateInTz(p.punchedAt, tz),
              time: rules.localTime(p.punchedAt, tz),
              source: p.source,
            })),
        });
      }
      return {
        stores: out,
        device: {
          bound: !!device,
          matches:
            device && input.deviceId ? device.deviceHash === hashDeviceId(input.deviceId) : null,
        },
        /** Agreed to the face check (the current wording's version). */
        faceConsent:
          !!consent && consent.version >= ATTENDANCE_FACE_CONSENT_VERSION
            ? { at: consent.consentedAt.toISOString() }
            : null,
        /** The face enrollment: clocking waits for an approved one. */
        face: enrollment,
      };
    });
  }),

  /**
   * The liveness challenge for one punch: whether it needs the head turns
   * (a risk signal or the 1-in-3 spot check, 2026-11-06) and their order,
   * signed for one punch and three minutes. `identify` = a colleague
   * clocking on this phone, found by their face.
   */
  livenessChallenge: authedProcedure
    .input(AttendanceLivenessChallengeInputSchema)
    .mutation(async ({ ctx, input }) => {
      const session = ctx.session!;
      const { turns, overtimeMinutes } = await ctx.withOrg(async (tx) => {
        const store = await authorize(tx, session, input.storeId, 'attendance.clock');
        // A clock-out well past the shift: the phone asks why first, so
        // the punch goes out straight after the camera. Whose clock-out a
        // colleague's is, only their face says.
        const overtimeMinutes = input.identify
          ? 0
          : await clockOutOvertime(tx, session.memberId, store.id);
        // Nobody vouches for a borrowed phone: always the turns.
        if (input.identify || input.force) return { turns: true, overtimeMinutes };
        const risk = await punchRisk(tx, session, store, input.deviceId ?? null);
        return { turns: risk.newDevice || risk.spot, overtimeMinutes };
      });
      const challenge = await signLivenessToken({
        org: session.orgId,
        mid: input.identify ? IDENTIFY_MEMBER : session.memberId,
        by: session.memberId,
        storeId: input.storeId,
        steps: turns ? undefined : [],
      });
      return { ...challenge, overtimeMinutes };
    }),

  punch: idempotentMutation.input(AttendancePunchInputSchema).mutation(async ({ ctx, input }) => {
    const session = ctx.session!;
    // A colleague clocking on this phone, found by their face.
    const identifying = !!input.identify;
    const borrowed = identifying;
    // Face only (2026-11-06): no face photo, no punch.
    await ctx.withOrg(async (tx) => {
      await authorize(tx, session, input.storeId, 'attendance.clock');
      if (borrowed) return;
      // The person agrees in the app, then enrolls and is approved.
      if (!(await hasFaceConsent(tx, session.memberId))) fail('BAD_REQUEST', 'consentRequired');
      const { approved } = await enrollmentState(tx, session.memberId);
      if (!approved) fail('BAD_REQUEST', 'faceNotEnrolled');
    });
    const shots = input.photos;
    if (!shots) fail('BAD_REQUEST', 'photoRequired');
    // The face and liveness checks (~0.5 s a frame) run before the
    // transaction, not inside it.
    const faceBytes = photoBytes(shots.face);
    const checked = await faceFeature(faceBytes);
    if (!checked) fail('CONFLICT', 'faceCheckUnavailable');
    if (!checked.found) fail('BAD_REQUEST', 'faceNotFound');
    // Every frame's print, and the movement frames' features: each must be
    // the enrolled person, and none may have been sent before (2026-11-07).
    const prints: FramePrint[] = [print('face', faceBytes, checked.feature)];
    const moves: number[][] = [];
    if (!input.liveness) fail('BAD_REQUEST', 'livenessRequired');
    const claims = await verifyLivenessToken(input.liveness.token);
    if (
      !claims ||
      claims.org !== session.orgId ||
      claims.by !== session.memberId ||
      claims.mid !== (identifying ? IDENTIFY_MEMBER : session.memberId) ||
      claims.storeId !== input.storeId
    ) {
      fail('BAD_REQUEST', 'livenessExpired');
    }
    const nonce = claims.nonce;
    // The blink and the open mouth (2026-11-07): seen by the phone, the
    // frames checked here. A token from before asks for none.
    const acts = claims.acts ?? [];
    if (acts.length > 0) {
      const frames: { act: Act; bytes: Buffer }[] = [];
      for (const act of acts) {
        const b64 = input.liveness[act];
        if (!b64) fail('BAD_REQUEST', 'livenessRequired');
        frames.push({ act, bytes: photoBytes(b64) });
      }
      const results: { act: Act; result: FaceResult | null; copy: boolean }[] = [];
      for (const f of frames) {
        results.push({
          act: f.act,
          result: await faceFeature(f.bytes),
          copy: f.bytes.equals(faceBytes) || frames.some((o) => o !== f && o.bytes.equals(f.bytes)),
        });
      }
      const verdict = evaluateActs(checked, results);
      if (verdict.result === 'unchecked') fail('CONFLICT', 'faceCheckUnavailable');
      if (verdict.result === 'fail') {
        fail('BAD_REQUEST', 'livenessFailed', {
          context: { failures: verdict.failures.join(',') },
        });
      }
      frames.forEach((f, i) => {
        const r = results[i]!.result;
        if (r?.found) {
          prints.push(print(f.act, f.bytes, r.feature));
          moves.push(r.feature);
        }
      });
    }
    const turnsAsked = claims.steps.length > 0;
    // A borrowed phone always asks for the turns: nobody else vouches for it.
    if (borrowed && !turnsAsked) fail('BAD_REQUEST', 'livenessNeeded');
    let live: LivenessVerdict;
    if (turnsAsked) {
      if (!input.liveness.left || !input.liveness.right) fail('BAD_REQUEST', 'livenessRequired');
      const leftBytes = photoBytes(input.liveness.left);
      const rightBytes = photoBytes(input.liveness.right);
      const left = await faceFeature(leftBytes);
      const right = await faceFeature(rightBytes);
      live = evaluateLiveness(checked, left, right);
      if (live.result === 'unchecked') fail('CONFLICT', 'faceCheckUnavailable');
      // Face only: a failed check is refused; the person tries again.
      if (live.result === 'fail') {
        fail('BAD_REQUEST', 'livenessFailed', { context: { failures: live.failures } });
      }
      if (left?.found && right?.found) {
        prints.push(
          print('left', leftBytes, left.feature),
          print('right', rightBytes, right.feature),
        );
        moves.push(left.feature, right.feature);
      }
    } else if (checked.real >= CHECK_LINES.realSure) {
      // One face photo, plainly a real face: no turns this time.
      live = { result: 'passive', score: checked.real, failures: [] };
    } else {
      // Not sure it is a real face: the same punch again with the turns.
      fail('BAD_REQUEST', 'livenessNeeded');
    }
    return ctx.withOrg(async (tx) => {
      const store = await authorize(tx, session, input.storeId, 'attendance.clock');
      // Whose punch: this phone's person, or the colleague the face
      // belongs to.
      let target = session.memberId;
      let targetName: string | null = null;
      if (identifying) {
        const takenBack = await takenBackOnPhone(tx, store.id, session.memberId);
        const known = (
          await knownFaces(tx, session.orgId, store.id, {
            except: session.memberId,
            colleagues: true,
          })
        ).filter((k) => !takenBack.has(k.memberId));
        // The phone's own person is a candidate too (2026-11-07): their
        // face must not pass for a colleague who looks like them.
        const own = (await enrolledFeatures(tx, [session.memberId])).get(session.memberId);
        if (own?.length) known.push({ memberId: session.memberId, name: '', features: own });
        const who = identify(checked.feature, known, CHECK_LINES.identifyMin);
        if (!who) fail('FORBIDDEN', 'notRecognized');
        if (who.memberId === session.memberId) fail('FORBIDDEN', 'identifyIsOwner');
        target = who.memberId;
        targetName = who.name || null;
      }
      if (borrowed) {
        await assertColleague(tx, session, store.id, target);
        if (!(await hasFaceConsent(tx, target))) fail('FORBIDDEN', 'borrowNoConsent');
      }
      // One punch at a time per member: the alternation check below reads
      // what the previous punch wrote.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'attendance:' + target}))`);
      const policy = policyView(await loadPolicy(tx, store.id));
      const now = new Date();
      // The place, where the store asks for it.
      const photos = {
        face: photoBytes(shots.face),
        // A place photo from a phone still on the old page is not kept.
        scene: null,
      };

      const enrolled = (await enrolledFeatures(tx, [target])).get(target);
      const face = faceCompare(enrolled, checked);
      if (!face) fail('BAD_REQUEST', borrowed ? 'borrowNoFace' : 'faceNotEnrolled');
      // A face close to the line is confirmed with the turns.
      if (!turnsAsked && face.score != null && faceInGrayZone(face.score)) {
        fail('BAD_REQUEST', 'livenessNeeded');
      }
      // Face only: someone else's face is refused (owner, 2026-11-06).
      if (face.result !== 'match') {
        fail('FORBIDDEN', borrowed ? 'borrowFaceMismatch' : 'faceMismatch');
      }
      // The blink, the open mouth and the turns are this person too, not
      // someone else moving after a photo of them (2026-11-07).
      if (!movesMatch(enrolled ?? [], moves)) {
        fail('BAD_REQUEST', 'livenessFailed', { context: { failures: 'otherPerson' } });
      }
      // A token used for a punch already: say so before looking at frames.
      const used = await tx
        .select({ id: s.attendancePunches.id })
        .from(s.attendancePunches)
        .where(eq(s.attendancePunches.livenessNonce, nonce))
        .limit(1);
      if (used.length > 0) fail('BAD_REQUEST', 'livenessExpired');
      if (await framesSeenBefore(tx, target, prints, enrolled ?? [])) {
        fail('BAD_REQUEST', 'photoReused');
      }

      // Device: the first punch binds the phone. A borrowed phone is the
      // colleague's, not this person's: it is neither bound nor checked.
      let newDevice = false;
      if (!borrowed) {
        const hash = hashDeviceId(input.deviceId);
        const device = await tx.query.attendanceDevices.findFirst({
          where: (d, { eq: eq2 }) => eq2(d.memberId, session.memberId),
        });
        if (!device) {
          await tx.insert(s.attendanceDevices).values({
            memberId: session.memberId,
            orgId: session.orgId,
            deviceHash: hash,
            platform: input.platform?.slice(0, 32) ?? null,
          });
        } else if (device.deviceHash !== hash) {
          if (policy.requireDevice) {
            // A new phone is a risk signal: the turns, then it may clock.
            if (!turnsAsked) fail('BAD_REQUEST', 'livenessNeeded');
            // A lost or broken phone is no excuse (owner, 2026-11-06): with
            // the face and liveness confirmed, the new phone clocks too,
            // marked for the managers, who rebind it with "reset device".
            if (live.result !== 'pass') fail('FORBIDDEN', 'otherDevice');
            newDevice = true;
          }
        }
      }

      let distanceM: number | null = null;
      if (policy.requireGeo && policy.geo) {
        const loc = input.location;
        if (!loc) fail('BAD_REQUEST', 'locationRequired');
        distanceM = Math.round(rules.distanceMeters(loc, policy.geo));
        const verdict = locationVerdict({
          distanceM,
          accuracyM: loc.accuracy,
          radiusM: policy.geo.radiusM,
        });
        if (verdict === 'inaccurate') {
          fail('BAD_REQUEST', 'locationInaccurate', {
            context: { accuracy: Math.round(loc.accuracy) },
          });
        }
        if (verdict === 'outside') {
          fail('FORBIDDEN', 'outsideArea', {
            context: { distance: distanceM, radius: policy.geo.radiusM },
          });
        }
      } else if (input.location && policy.geo) {
        distanceM = Math.round(rules.distanceMeters(input.location, policy.geo));
      }

      const recent = await recentPunches(tx, target, store.id, now);
      const last = latestPunch(recent);
      const lastSeen = last
        ? { lastKind: last.kind, time: rules.localTime(last.at, tzOf(store, session)) }
        : null;
      // The same colleague found again within two minutes of their last
      // punch, on this phone or another, is that punch sent again (an
      // answer lost on a slow link), not their next one (2026-11-07). The
      // server picks a colleague's kind, so it used to become their
      // clock-out a minute after the clock-in.
      if (
        identifying &&
        last &&
        lastSeen &&
        now.getTime() - last.at.getTime() < ATTENDANCE_UNDO_WINDOW_MS
      ) {
        fail('CONFLICT', 'justPunched', { context: { ...lastSeen, name: targetName } });
      }
      const expected = rules.nextPunchKind(recent, now);
      // A colleague found by their face: their own next punch.
      const kind = identifying ? expected : (input.kind ?? expected);
      if (kind !== expected) {
        // With the last punch's kind and time, the phone can say "clocked
        // in already at 09:02" when that is what happened.
        fail(
          'CONFLICT',
          kind === 'in' ? 'alreadyClockedIn' : 'notClockedIn',
          lastSeen ? { context: lastSeen } : undefined,
        );
      }

      // Well past the shift's end: the person says why, and it waits for a
      // manager's approval before it counts (owner decision 2026-11-05).
      // For a colleague the phone learns it only now, so it hears whose.
      const overtime =
        kind === 'out'
          ? await overtimeFor(tx, target, store.id, now, policy.overtimeAfterMinutes)
          : null;
      if (overtime && !input.overtimeReason) {
        fail('BAD_REQUEST', 'overtimeReasonRequired', {
          context: {
            minutes: overtime.minutes,
            ...(identifying && targetName ? { name: targetName } : {}),
          },
        });
      }

      const inserted = await tx
        .insert(s.attendancePunches)
        .values({
          orgId: session.orgId,
          storeId: store.id,
          memberId: target,
          kind,
          punchedAt: now,
          source: 'self',
          geoLat: input.location ? input.location.lat.toFixed(6) : null,
          geoLng: input.location ? input.location.lng.toFixed(6) : null,
          geoAccuracyM: input.location ? Math.round(input.location.accuracy) : null,
          distanceM,
          createdByMemberId: session.memberId,
          liveness: live.result,
          livenessScore: live.score,
          livenessNonce: nonce,
          viaMemberId: borrowed ? session.memberId : null,
          newDevice,
        })
        .onConflictDoNothing()
        .returning();
      // The challenge was already used for a punch.
      if (inserted.length === 0) fail('BAD_REQUEST', 'livenessExpired');
      const row = inserted[0]!;
      if (overtime) {
        await tx.insert(s.attendanceOvertime).values({
          orgId: session.orgId,
          storeId: store.id,
          memberId: target,
          shiftId: overtime.shiftId,
          punchId: row.id,
          minutes: overtime.minutes,
          reason: input.overtimeReason ?? null,
        });
      }
      const frames: { kind: 'face' | 'scene' | 'left' | 'right'; bytes: Buffer }[] = [
        { kind: 'face', bytes: photos.face },
      ];
      if (photos.scene) frames.push({ kind: 'scene', bytes: photos.scene });
      if (turnsAsked && input.liveness?.left && input.liveness.right) {
        frames.push(
          { kind: 'left', bytes: photoBytes(input.liveness.left) },
          { kind: 'right', bytes: photoBytes(input.liveness.right) },
        );
      }
      await tx.insert(s.attendancePunchFrames).values(
        prints.map((p) => ({
          orgId: session.orgId,
          memberId: target,
          punchId: row.id,
          kind: p.kind,
          sha256: p.sha256,
          feature: p.feature,
          takenAt: now,
        })),
      );
      await tx.insert(s.attendancePhotos).values(
        frames.map(({ kind: k, bytes }) => ({
          orgId: session.orgId,
          storeId: store.id,
          memberId: target,
          punchId: row.id,
          kind: k,
          bytes,
          takenAt: now,
          faceResult: k === 'face' ? face.result : null,
          faceScore: k === 'face' ? face.score : null,
          realScore: k === 'face' ? checked.real : null,
        })),
      );

      const tz = tzOf(store, session);
      const people = await tx
        .select({ memberId: s.members.id, userId: s.members.userId, name: s.users.displayName })
        .from(s.members)
        .innerJoin(s.users, eq(s.users.id, s.members.userId))
        .where(inArray(s.members.id, [target, session.memberId]));
      const person = people.find((p) => p.memberId === target);
      const phoneOwner = people.find((p) => p.memberId === session.memberId);
      const vars = {
        name: person?.name ?? '—',
        owner: phoneOwner?.name ?? '—',
        store: store.name,
        time: rules.localTime(now, tz),
      };
      const flags: { template: string; title: string; key: string }[] = [];
      if (borrowed)
        flags.push({
          template: 'attendance.borrowedPhone',
          title: "Clocked on a colleague's phone",
          key: 'borrow',
        });
      if (newDevice)
        flags.push({
          template: 'attendance.newDevice',
          title: 'Clocked from a new phone',
          key: 'device',
        });
      if (flags.length > 0) {
        const managers = await findRecipientsByPermissionInStore(
          tx,
          session.orgId,
          'attendance.manage',
          store.id,
        );
        for (const f of flags) {
          await dispatch(tx, session.orgId, managers, {
            template: f.template,
            title: f.title,
            vars,
            deepLink: linkForStore('/admin', store.id),
            dedupKey: `attendance:${f.key}:${row.id}`,
          });
        }
      }
      // The person hears about a punch made in their name on another phone.
      if (borrowed && person) {
        await dispatch(tx, session.orgId, [person.userId], {
          template: kind === 'in' ? 'attendance.clockedInForYou' : 'attendance.clockedOutForYou',
          title: "Clocked on a colleague's phone",
          vars,
          deepLink: '/attendance',
          dedupKey: `attendance:you:${row.id}`,
        });
      }
      publish(session.orgId, store.id);
      return {
        id: row.id,
        face: face.result,
        liveness: live.result,
        newDevice,
        forName: borrowed ? (person?.name ?? null) : null,
        overtimeMinutes: overtime?.minutes ?? 0,
        kind,
        at: now.toISOString(),
        time: rules.localTime(now, tz),
      };
    });
  }),

  /** Roster + punches + per-day verdicts for one store and date range. */
  sheet: authedProcedure
    .input(AttendanceSheetInputSchema)
    .query(({ ctx, input }) => loadSheet(ctx, input)),

  shiftSave: idempotentMutation
    .input(AttendanceShiftSaveInputSchema)
    .mutation(async ({ ctx, input }) => {
      const session = ctx.session!;
      return ctx.withOrg(async (tx) => {
        const store = await authorize(tx, session, input.storeId, 'attendance.manage');
        await assertInStore(tx, session.orgId, store.id, input.memberId);
        const tz = tzOf(store, session);
        const { startsAt, endsAt } = rules.shiftWindow(input.date, input.start, input.end, tz);
        if (await overlaps(tx, input.memberId, startsAt, endsAt, input.shiftId))
          fail('CONFLICT', 'shiftOverlap');
        const values = {
          memberId: input.memberId,
          shiftDate: input.date,
          startsAt,
          endsAt,
          note: input.note || null,
        };
        if (input.shiftId) {
          const [row] = await tx
            .update(s.attendanceShifts)
            .set({ ...values, updatedAt: new Date() })
            .where(
              and(
                eq(s.attendanceShifts.id, input.shiftId),
                eq(s.attendanceShifts.storeId, store.id),
              ),
            )
            .returning({ id: s.attendanceShifts.id });
          if (!row) fail('NOT_FOUND', 'shiftNotFound');
          publish(session.orgId, store.id);
          return { id: row.id };
        }
        const [row] = await tx
          .insert(s.attendanceShifts)
          .values({
            ...values,
            orgId: session.orgId,
            storeId: store.id,
            createdByMemberId: session.memberId,
          })
          .returning({ id: s.attendanceShifts.id });
        publish(session.orgId, store.id);
        return { id: row!.id };
      });
    }),

  shiftDelete: idempotentMutation
    .input(AttendanceShiftDeleteInputSchema)
    .mutation(async ({ ctx, input }) => {
      const session = ctx.session!;
      return ctx.withOrg(async (tx) => {
        const store = await authorize(tx, session, input.storeId, 'attendance.manage');
        await tx
          .delete(s.attendanceShifts)
          .where(
            and(eq(s.attendanceShifts.id, input.shiftId), eq(s.attendanceShifts.storeId, store.id)),
          );
        publish(session.orgId, store.id);
        return { ok: true as const };
      });
    }),

  /** Copy one week's shifts onto another week; clashes are skipped. */
  copyWeek: idempotentMutation
    .input(AttendanceCopyWeekInputSchema)
    .mutation(async ({ ctx, input }) => {
      const session = ctx.session!;
      return ctx.withOrg(async (tx) => {
        const store = await authorize(tx, session, input.storeId, 'attendance.manage');
        if (input.fromWeek === input.toWeek) fail('BAD_REQUEST', 'sameWeek');
        const tz = tzOf(store, session);
        const offsetDays = Math.round(
          (Date.parse(`${input.toWeek}T00:00:00Z`) - Date.parse(`${input.fromWeek}T00:00:00Z`)) /
            DAY,
        );
        const source = await tx
          .select()
          .from(s.attendanceShifts)
          .where(
            and(
              eq(s.attendanceShifts.storeId, store.id),
              gte(s.attendanceShifts.shiftDate, input.fromWeek),
              lte(s.attendanceShifts.shiftDate, rules.nextDate(input.fromWeek, 6)),
            ),
          );
        const roster = new Set(
          (await storeRoster(tx, session.orgId, store.id)).map((m) => m.memberId),
        );
        let copied = 0;
        let skipped = 0;
        for (const x of source) {
          if (!roster.has(x.memberId)) {
            skipped++;
            continue;
          }
          const date = rules.nextDate(x.shiftDate, offsetDays);
          const w = rules.shiftWindow(
            date,
            rules.localTime(x.startsAt, tz),
            rules.localTime(x.endsAt, tz),
            tz,
          );
          if (await overlaps(tx, x.memberId, w.startsAt, w.endsAt)) {
            skipped++;
            continue;
          }
          await tx.insert(s.attendanceShifts).values({
            orgId: session.orgId,
            storeId: store.id,
            memberId: x.memberId,
            shiftDate: date,
            startsAt: w.startsAt,
            endsAt: w.endsAt,
            note: x.note,
            createdByMemberId: session.memberId,
          });
          copied++;
        }
        if (copied > 0) publish(session.orgId, store.id);
        return { copied, skipped };
      });
    }),

  /** A manager records a punch someone missed; the reason is kept. */
  manualPunch: idempotentMutation
    .input(AttendanceManualPunchInputSchema)
    .mutation(async ({ ctx, input }) => {
      const session = ctx.session!;
      return ctx.withOrg(async (tx) => {
        const store = await authorize(tx, session, input.storeId, 'attendance.manage');
        refuseOwn(session, input.memberId);
        await assertInStore(tx, session.orgId, store.id, input.memberId);
        const tz = tzOf(store, session);
        const at = rules.zonedTimeToUtc(input.date, input.time, tz);
        if (at.getTime() > Date.now() + 5 * 60_000) fail('BAD_REQUEST', 'futureTime');
        if (at.getTime() < Date.now() - MAX_SHEET_DAYS * DAY) fail('BAD_REQUEST', 'tooOld');
        const [row] = await tx
          .insert(s.attendancePunches)
          .values({
            orgId: session.orgId,
            storeId: store.id,
            memberId: input.memberId,
            kind: input.kind,
            punchedAt: at,
            source: 'manual',
            reason: input.reason,
            createdByMemberId: session.memberId,
          })
          .returning({ id: s.attendancePunches.id });
        // A manager entering a late clock-out vouches for it: approved.
        const policy = policyView(await loadPolicy(tx, store.id));
        const overtime =
          input.kind === 'out'
            ? await overtimeFor(tx, input.memberId, store.id, at, policy.overtimeAfterMinutes)
            : null;
        if (overtime) {
          await tx.insert(s.attendanceOvertime).values({
            orgId: session.orgId,
            storeId: store.id,
            memberId: input.memberId,
            shiftId: overtime.shiftId,
            punchId: row!.id,
            minutes: overtime.minutes,
            reason: input.reason,
            status: 'approved',
            decidedByMemberId: session.memberId,
            decidedAt: new Date(),
          });
        }
        publish(session.orgId, store.id);
        return { id: row!.id };
      });
    }),

  voidPunch: idempotentMutation
    .input(AttendanceVoidPunchInputSchema)
    .mutation(async ({ ctx, input }) => {
      const session = ctx.session!;
      return ctx.withOrg(async (tx) => {
        const store = await authorize(tx, session, input.storeId, 'attendance.manage');
        const punch = await tx.query.attendancePunches.findFirst({
          where: (p, { and: and2, eq: eq2 }) =>
            and2(eq2(p.id, input.punchId), eq2(p.storeId, store.id)),
        });
        if (!punch) fail('NOT_FOUND', 'punchNotFound');
        refuseOwn(session, punch.memberId);
        if (punch.voidedAt) fail('CONFLICT', 'alreadyVoided');
        await tx
          .update(s.attendancePunches)
          .set({
            voidedAt: new Date(),
            voidedByMemberId: session.memberId,
            voidReason: input.reason,
          })
          .where(eq(s.attendancePunches.id, punch.id));
        publish(session.orgId, store.id);
        return { ok: true as const };
      });
    }),

  /**
   * "Not them" (owner decision 2026-11-07): a colleague clocked on this
   * phone by the wrong face is taken back here, by the phone's own person,
   * within ATTENDANCE_UNDO_WINDOW_MS. The punch is voided, not deleted (the
   * sheet shows it struck through, with the reason), and the managers and
   * the person it was recorded for are told. For TAKEN_BACK_LEFT_OUT_MS
   * that colleague is no longer looked for on this phone (ATT-02).
   */
  punchUndo: idempotentMutation
    .input(AttendancePunchUndoInputSchema)
    .mutation(async ({ ctx, input }) => {
      const session = ctx.session!;
      return ctx.withOrg(async (tx) => {
        const store = await authorize(tx, session, input.storeId, 'attendance.clock');
        const punch = await tx.query.attendancePunches.findFirst({
          where: (p, { and: and2, eq: eq2 }) =>
            and2(eq2(p.id, input.punchId), eq2(p.storeId, store.id)),
        });
        if (!punch) fail('NOT_FOUND', 'punchNotFound');
        // Only a colleague's punch made on this person's phone.
        if (punch.viaMemberId !== session.memberId || punch.memberId === session.memberId) {
          fail('FORBIDDEN', 'undoNotYours');
        }
        if (punch.voidedAt) fail('CONFLICT', 'alreadyVoided');
        const now = new Date();
        if (now.getTime() - punch.punchedAt.getTime() > ATTENDANCE_UNDO_WINDOW_MS) {
          fail('BAD_REQUEST', 'undoTooLate');
        }
        await tx
          .update(s.attendancePunches)
          .set({
            voidedAt: now,
            voidedByMemberId: session.memberId,
            voidReason: WRONG_PERSON_REASON,
          })
          .where(eq(s.attendancePunches.id, punch.id));

        const people = await tx
          .select({ memberId: s.members.id, userId: s.members.userId, name: s.users.displayName })
          .from(s.members)
          .innerJoin(s.users, eq(s.users.id, s.members.userId))
          .where(inArray(s.members.id, [punch.memberId, session.memberId]));
        const person = people.find((p) => p.memberId === punch.memberId);
        const phoneOwner = people.find((p) => p.memberId === session.memberId);
        const vars = {
          name: person?.name ?? '—',
          owner: phoneOwner?.name ?? '—',
          store: store.name,
          time: rules.localTime(punch.punchedAt, tzOf(store, session)),
        };
        const managers = await findRecipientsByPermissionInStore(
          tx,
          session.orgId,
          'attendance.manage',
          store.id,
        );
        await dispatch(tx, session.orgId, managers, {
          template: 'attendance.punchUndone',
          title: 'A colleague punch was taken back',
          vars,
          deepLink: linkForStore('/admin', store.id),
          dedupKey: `attendance:undo:${punch.id}`,
        });
        if (person) {
          await dispatch(tx, session.orgId, [person.userId], {
            template: 'attendance.punchUndoneForYou',
            title: 'A punch in your name was taken back',
            vars,
            deepLink: '/attendance',
            dedupKey: `attendance:undo-you:${punch.id}`,
          });
        }
        publish(session.orgId, store.id);
        return { ok: true as const };
      });
    }),

  /** Switch clocking on or off for one member of the store. */
  memberSet: idempotentMutation
    .input(AttendanceMemberSetInputSchema)
    .mutation(async ({ ctx, input }) => {
      const session = ctx.session!;
      return ctx.withOrg(async (tx) => {
        const store = await authorize(tx, session, input.storeId, 'attendance.manage');
        await assertInStore(tx, session.orgId, store.id, input.memberId);
        const where = and(
          eq(s.memberPermissionOverrides.memberId, input.memberId),
          eq(s.memberPermissionOverrides.permissionKey, 'attendance.clock'),
          eq(s.memberPermissionOverrides.scopeType, 'global'),
          isNull(s.memberPermissionOverrides.scopeId),
        );
        await tx.delete(s.memberPermissionOverrides).where(where);
        // Switched off clocking: their enrolled face goes too.
        if (!input.enabled)
          await tx
            .delete(s.attendanceFaceEnrollments)
            .where(eq(s.attendanceFaceEnrollments.memberId, input.memberId));
        if (input.enabled) {
          const member = await tx.query.members.findFirst({
            where: (m, { eq: eq2 }) => eq2(m.id, session.memberId),
            columns: { userId: true },
          });
          await tx.insert(s.memberPermissionOverrides).values({
            memberId: input.memberId,
            permissionKey: 'attendance.clock',
            effect: 'allow',
            scopeType: 'global',
            scopeId: null,
            grantedBy: member?.userId ?? null,
          });
        }
        // Their session re-reads permissions, so the tab appears or goes.
        hub.publish(session.orgId, { type: 'people.changed', orgId: session.orgId });
        publish(session.orgId, store.id);
        return { enabled: input.enabled };
      });
    }),

  /** Unbind a member's phone (lost or replaced); the next punch binds again. */
  resetDevice: idempotentMutation
    .input(AttendanceResetDeviceInputSchema)
    .mutation(async ({ ctx, input }) => {
      const session = ctx.session!;
      return ctx.withOrg(async (tx) => {
        const store = await authorize(tx, session, input.storeId, 'attendance.manage');
        await assertInStore(tx, session.orgId, store.id, input.memberId);
        await tx
          .delete(s.attendanceDevices)
          .where(eq(s.attendanceDevices.memberId, input.memberId));
        publish(session.orgId, store.id);
        return { ok: true as const };
      });
    }),

  policyGet: authedProcedure
    .input(AttendancePolicyGetInputSchema)
    .query(({ ctx, input }) => loadPolicyView(ctx, input.storeId)),

  policySave: idempotentMutation
    .input(AttendancePolicySaveInputSchema)
    .mutation(async ({ ctx, input }) => {
      const session = ctx.session!;
      return ctx.withOrg(async (tx) => {
        const store = await authorize(tx, session, input.storeId, 'attendance.manage');
        const values = {
          requireDevice: input.requireDevice,
          requireGeo: input.requireGeo,
          geoLat: input.geo ? input.geo.lat.toFixed(6) : null,
          geoLng: input.geo ? input.geo.lng.toFixed(6) : null,
          geoRadiusM: input.geo?.radiusM ?? null,
          graceMinutes: input.graceMinutes,
          overtimeAfterMinutes: input.overtimeAfterMinutes,
          // Always on since 2026-11-06 (face only); kept true for the record.
          requirePhoto: true,
          requireFace: true,
          requireLiveness: true,
          requireScene: false,
          updatedByMemberId: session.memberId,
          updatedAt: new Date(),
        };
        await tx
          .insert(s.attendanceStorePolicies)
          .values({ storeId: store.id, orgId: session.orgId, ...values })
          .onConflictDoUpdate({ target: s.attendanceStorePolicies.storeId, set: values });
        publish(session.orgId, store.id);
        return { ok: true as const };
      });
    }),

  /** Approve or reject overtime; only approved overtime counts. */
  overtimeDecide: idempotentMutation
    .input(AttendanceOvertimeDecideInputSchema)
    .mutation(async ({ ctx, input }) => {
      const session = ctx.session!;
      return ctx.withOrg(async (tx) => {
        const store = await authorize(tx, session, input.storeId, 'attendance.manage');
        const overtime = await tx.query.attendanceOvertime.findFirst({
          where: (o, { and: and2, eq: eq2 }) =>
            and2(eq2(o.id, input.overtimeId), eq2(o.storeId, store.id)),
        });
        if (!overtime) fail('NOT_FOUND', 'overtimeNotFound');
        refuseOwn(session, overtime.memberId);
        const [row] = await tx
          .update(s.attendanceOvertime)
          .set({
            status: input.approve ? 'approved' : 'rejected',
            decidedByMemberId: session.memberId,
            decidedAt: new Date(),
            decisionNote: input.note || null,
          })
          .where(
            and(
              eq(s.attendanceOvertime.id, input.overtimeId),
              eq(s.attendanceOvertime.storeId, store.id),
            ),
          )
          .returning({ id: s.attendanceOvertime.id });
        if (!row) fail('NOT_FOUND', 'overtimeNotFound');
        publish(session.orgId, store.id);
        return { ok: true as const };
      });
    }),

  /** A person's daily wage from a date on; a later date is a raise, not a rewrite. */
  payRateSet: idempotentMutation
    .input(AttendancePayRateSetInputSchema)
    .mutation(async ({ ctx, input }) => {
      const session = ctx.session!;
      return ctx.withOrg(async (tx) => {
        const store = await authorize(tx, session, input.storeId, 'attendance.manage');
        refuseOwn(session, input.memberId);
        await assertInStore(tx, session.orgId, store.id, input.memberId);
        await tx
          .insert(s.attendancePayRates)
          .values({
            orgId: session.orgId,
            memberId: input.memberId,
            dailyWage: input.dailyWage,
            effectiveFrom: input.effectiveFrom,
            createdByMemberId: session.memberId,
          })
          .onConflictDoUpdate({
            target: [s.attendancePayRates.memberId, s.attendancePayRates.effectiveFrom],
            set: { dailyWage: input.dailyWage, createdByMemberId: session.memberId },
          });
        publish(session.orgId, store.id);
        return { ok: true as const };
      });
    }),

  /**
   * The daily close's wage rows from attendance: who worked that day and
   * what they are owed (daily wage less late / early). Rows that need a
   * manager first (missing punch, no shift, no wage) come back flagged,
   * without an amount.
   */
  wageSuggestions: authedProcedure
    .input(AttendanceWageSuggestionsInputSchema)
    .query(async ({ ctx, input }) => {
      const session = ctx.session!;
      return ctx.withOrg(async (tx) => {
        const store = await loadStore(tx, session, input.storeId);
        await assertActorAssignedToStore(tx, session.memberId, store.id, session.permissions);
        const perms = await effectivePermissionsForStore(
          tx,
          session.memberId,
          store.id,
          session.permissions,
        );
        if (!perms.has('settlement.record') && !perms.has('attendance.manage')) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'auth.errors.missingPermission',
            cause: { missingPermission: 'settlement.record' },
          });
        }
        const sheet = await buildSheet(tx, session, store, input.date, input.date);
        const name = new Map(sheet.members.map((m) => [m.memberId, m.name]));
        return sheet.days
          .filter((d) => d.date === input.date && d.pay.status !== 'inProgress')
          .map((d) => ({
            memberId: d.memberId,
            name: name.get(d.memberId) ?? '—',
            status: d.pay.status,
            dailyWage: d.dailyWage,
            lateMinutes: d.lateMinutes,
            earlyMinutes: d.earlyMinutes,
            missedMinutes: d.missedMinutes,
            deduction: centsToMoney(d.pay.deductionCents),
            amount: d.pay.netCents === null ? null : centsToMoney(d.pay.netCents),
          }));
      });
    }),

  /**
   * A short-lived link to the month's spreadsheet. The file itself comes
   * from `GET /files/attendance-month.xlsx`, so Telegram's download dialog
   * (or a browser) can fetch it without the app's token.
   */
  exportLink: authedProcedure
    .input(AttendanceExportLinkInputSchema)
    .mutation(async ({ ctx, input }) => {
      const session = ctx.session!;
      const store = await ctx.withOrg((tx) =>
        authorize(tx, session, input.storeId, 'attendance.manage'),
      );
      const token = await signExportToken({
        sub: session.userId,
        org: session.orgId,
        mid: session.memberId,
        storeId: input.storeId,
        month: input.month,
        locale: input.locale,
      });
      return {
        path: `/files/attendance-month.xlsx?t=${encodeURIComponent(token)}`,
        fileName: await exportFileName(input.locale, store.name, input.month),
      };
    }),

  /** A punch's photos for the store's managers (kept 90 days). */
  punchPhotos: authedProcedure
    .input(AttendancePunchPhotosInputSchema)
    .query(async ({ ctx, input }) => {
      const session = ctx.session!;
      return ctx.withOrg(async (tx) => {
        const store = await authorize(tx, session, input.storeId, 'attendance.manage');
        const rows = await tx
          .select({
            kind: s.attendancePhotos.kind,
            contentType: s.attendancePhotos.contentType,
            bytes: s.attendancePhotos.bytes,
            takenAt: s.attendancePhotos.takenAt,
          })
          .from(s.attendancePhotos)
          .where(
            and(
              eq(s.attendancePhotos.storeId, store.id),
              eq(s.attendancePhotos.punchId, input.punchId),
            ),
          );
        return rows
          .sort((a, b) => PHOTO_ORDER.indexOf(a.kind) - PHOTO_ORDER.indexOf(b.kind))
          .map((r) => ({
            kind: r.kind,
            src: `data:${r.contentType};base64,${Buffer.from(r.bytes).toString('base64')}`,
            takenAt: r.takenAt.toISOString(),
          }));
      });
    }),

  /**
   * The person enrolls their face (owner decisions 2026-11-06): the photos
   * the phone took by itself around a ring (Face ID style), each checked here for one clear, sharp,
   * well-lit real face of the same person, turned where it says. It then
   * waits for a store manager's approval; a new enrollment replaces one
   * still waiting.
   */
  faceEnroll: idempotentMutation
    .input(AttendanceFaceEnrollInputSchema)
    .mutation(async ({ ctx, input }) => {
      const session = ctx.session!;
      await ctx.withOrg(async (tx) => {
        await authorize(tx, session, input.storeId, 'attendance.clock');
        if (!(await hasFaceConsent(tx, session.memberId))) fail('BAD_REQUEST', 'consentRequired');
      });
      const checksStarted = performance.now();
      const poses = ENROLL_POSES.filter((p) => input.photos[p] !== undefined);
      const bytes: Partial<Record<EnrollPose, Buffer>> = {};
      for (const pose of poses) bytes[pose] = photoBytes(input.photos[pose]!);
      const results: Partial<Record<EnrollPose, FaceResult>> = {};
      for (const pose of poses) {
        const r = await faceFeature(bytes[pose]!);
        if (!r) fail('CONFLICT', 'faceCheckUnavailable');
        results[pose] = r;
      }
      const verdict = evaluateEnrollment(results);
      // How long the checks took, to tell a slow server from a slow link.
      ctx.log.info(
        {
          photos: poses.length,
          kb: Math.round(poses.reduce((a, p) => a + bytes[p]!.length, 0) / 1024),
          ms: Math.round(performance.now() - checksStarted),
          ok: verdict.ok,
          dropped: verdict.dropped.map((d) => `${d.pose}:${d.problem}`).join(',') || undefined,
        },
        'attendance enroll checked',
      );
      if (!verdict.ok) {
        const first = verdict.problems[0]!;
        fail('BAD_REQUEST', 'enrollRejected', {
          context: {
            pose: first.pose,
            problem: first.problem,
            problems: verdict.problems.map((x) => `${x.pose}:${x.problem}`).join(','),
          },
        });
      }
      return ctx.withOrg(async (tx) => {
        const store = await authorize(tx, session, input.storeId, 'attendance.clock');
        await tx
          .delete(s.attendanceFaceEnrollments)
          .where(
            and(
              eq(s.attendanceFaceEnrollments.memberId, session.memberId),
              ne(s.attendanceFaceEnrollments.status, 'approved'),
            ),
          );
        const [row] = await tx
          .insert(s.attendanceFaceEnrollments)
          .values({ orgId: session.orgId, memberId: session.memberId, storeId: store.id })
          .returning();
        await tx.insert(s.attendanceFaceSamples).values(
          verdict.kept.map((pose) => {
            const r = results[pose] as Extract<FaceResult, { found: true }>;
            return {
              orgId: session.orgId,
              enrollmentId: row!.id,
              pose,
              feature: r.feature,
              bytes: bytes[pose]!,
              realScore: r.real,
            };
          }),
        );
        const me = await tx
          .select({ userId: s.members.userId, name: s.users.displayName })
          .from(s.members)
          .innerJoin(s.users, eq(s.users.id, s.members.userId))
          .where(eq(s.members.id, session.memberId));
        const managers = (
          await findRecipientsByPermissionInStore(tx, session.orgId, 'attendance.manage', store.id)
        ).filter((u) => u !== me[0]?.userId);
        await dispatch(tx, session.orgId, managers, {
          template: 'attendance.faceEnrollPending',
          title: 'Face enrollment to approve',
          vars: { name: me[0]?.name ?? '—', store: store.name },
          deepLink: linkForStore('/admin', store.id),
          dedupKey: `attendance:enroll:${row!.id}`,
        });
        publish(session.orgId, store.id);
        return { id: row!.id, status: 'pending' as const };
      });
    }),

  /** A person's face enrollments (in use and waiting) with their photos, for a manager. */
  faceEnrollment: authedProcedure
    .input(AttendanceFaceMemberInputSchema)
    .query(async ({ ctx, input }) => {
      const session = ctx.session!;
      return ctx.withOrg(async (tx) => {
        const store = await authorize(tx, session, input.storeId, 'attendance.manage');
        await assertInStore(tx, session.orgId, store.id, input.memberId);
        const rows = await tx
          .select()
          .from(s.attendanceFaceEnrollments)
          .where(
            and(
              eq(s.attendanceFaceEnrollments.memberId, input.memberId),
              ne(s.attendanceFaceEnrollments.status, 'rejected'),
            ),
          )
          .orderBy(sql`${s.attendanceFaceEnrollments.createdAt} DESC`);
        const samples =
          rows.length === 0
            ? []
            : await tx
                .select({
                  enrollmentId: s.attendanceFaceSamples.enrollmentId,
                  pose: s.attendanceFaceSamples.pose,
                  bytes: s.attendanceFaceSamples.bytes,
                })
                .from(s.attendanceFaceSamples)
                .where(
                  inArray(
                    s.attendanceFaceSamples.enrollmentId,
                    rows.map((r) => r.id),
                  ),
                );
        const order = (p: string) => ENROLL_POSES.indexOf(p as EnrollPose);
        return rows.map((r) => ({
          id: r.id,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
          decidedAt: r.decidedAt?.toISOString() ?? null,
          photos: samples
            .filter((x) => x.enrollmentId === r.id)
            .sort((a, b) => order(a.pose) - order(b.pose))
            .map((x) => ({
              pose: x.pose,
              src: `data:image/jpeg;base64,${Buffer.from(x.bytes).toString('base64')}`,
            })),
        }));
      });
    }),

  /**
   * A manager approves a waiting enrollment (it replaces the one in use)
   * or sends it back with a reason (its photos are deleted). Nobody
   * approves their own face, except a super admin (owner, 2026-11-07:
   * there is nobody above them to ask).
   */
  faceEnrollDecide: idempotentMutation
    .input(AttendanceFaceEnrollDecideInputSchema)
    .mutation(async ({ ctx, input }) => {
      const session = ctx.session!;
      return ctx.withOrg(async (tx) => {
        const store = await authorize(tx, session, input.storeId, 'attendance.manage');
        const row = await tx.query.attendanceFaceEnrollments.findFirst({
          where: (e, { eq: eq2 }) => eq2(e.id, input.enrollmentId),
        });
        if (!row || row.status !== 'pending') fail('NOT_FOUND', 'enrollmentNotFound');
        await assertInStore(tx, session.orgId, store.id, row.memberId);
        if (row.memberId === session.memberId && !handlesOwn(session)) {
          fail('FORBIDDEN', 'enrollOwn');
        }
        const decided = {
          decidedByMemberId: session.memberId,
          decidedAt: new Date(),
          note: input.note || null,
        };
        if (input.approve) {
          await tx
            .delete(s.attendanceFaceEnrollments)
            .where(
              and(
                eq(s.attendanceFaceEnrollments.memberId, row.memberId),
                eq(s.attendanceFaceEnrollments.status, 'approved'),
              ),
            );
          await tx
            .update(s.attendanceFaceEnrollments)
            .set({ status: 'approved', ...decided })
            .where(eq(s.attendanceFaceEnrollments.id, row.id));
        } else {
          await tx
            .update(s.attendanceFaceEnrollments)
            .set({ status: 'rejected', ...decided })
            .where(eq(s.attendanceFaceEnrollments.id, row.id));
          await tx
            .delete(s.attendanceFaceSamples)
            .where(eq(s.attendanceFaceSamples.enrollmentId, row.id));
        }
        const person = await tx.query.members.findFirst({
          where: (m, { eq: eq2 }) => eq2(m.id, row.memberId),
          columns: { userId: true },
        });
        // A super admin who decided their own needs no message about it.
        if (person && row.memberId !== session.memberId) {
          await dispatch(tx, session.orgId, [person.userId], {
            template: input.approve
              ? 'attendance.faceEnrollApproved'
              : 'attendance.faceEnrollRejected',
            title: input.approve ? 'Face enrollment approved' : 'Face enrollment sent back',
            vars: { store: store.name, note: input.note ?? '' },
            deepLink: '/attendance',
            dedupKey: `attendance:enrolled:${row.id}`,
          });
        }
        publish(session.orgId, store.id);
        return { ok: true as const };
      });
    }),

  /** Delete a person's enrolled face; they enroll again before clocking. */
  faceEnrollReset: idempotentMutation
    .input(AttendanceFaceMemberInputSchema)
    .mutation(async ({ ctx, input }) => {
      const session = ctx.session!;
      return ctx.withOrg(async (tx) => {
        const store = await authorize(tx, session, input.storeId, 'attendance.manage');
        await assertInStore(tx, session.orgId, store.id, input.memberId);
        await tx
          .delete(s.attendanceFaceEnrollments)
          .where(eq(s.attendanceFaceEnrollments.memberId, input.memberId));
        publish(session.orgId, store.id);
        return { ok: true as const };
      });
    }),

  /** The person agrees to their face being used to check their punches. */
  faceConsentGive: idempotentMutation
    .input(AttendanceFaceConsentInputSchema)
    .mutation(async ({ ctx, input }) => {
      const session = ctx.session!;
      return ctx.withOrg(async (tx) => {
        const values = { orgId: session.orgId, version: input.version, consentedAt: new Date() };
        await tx
          .insert(s.attendanceFaceConsents)
          .values({ memberId: session.memberId, ...values })
          .onConflictDoUpdate({ target: s.attendanceFaceConsents.memberId, set: values });
        return { ok: true as const };
      });
    }),

  /**
   * Withdraw: the consent and the enrolled face are deleted. Stores that
   * check faces then refuse this person's punches until they agree again
   * (a manager can still add punches by hand).
   */
  faceConsentWithdraw: idempotentMutation.mutation(async ({ ctx }) => {
    const session = ctx.session!;
    return ctx.withOrg(async (tx) => {
      await tx
        .delete(s.attendanceFaceConsents)
        .where(eq(s.attendanceFaceConsents.memberId, session.memberId));
      await tx
        .delete(s.attendanceFaceEnrollments)
        .where(eq(s.attendanceFaceEnrollments.memberId, session.memberId));
      return { ok: true as const };
    });
  }),

  /**
   * 待核对: the store's flagged punches of the last two weeks nobody has
   * looked at yet (face mismatch, liveness failed, a colleague's phone, a
   * new phone), and how much overtime waits for a decision.
   */
  reviewQueue: authedProcedure
    .input(AttendanceReviewQueueInputSchema)
    .query(async ({ ctx, input }) => {
      const session = ctx.session!;
      return ctx.withOrg(async (tx) => {
        const store = await authorize(tx, session, input.storeId, 'attendance.manage');
        const tz = tzOf(store, session);
        const since = new Date(Date.now() - REVIEW_DAYS * DAY);
        const rows = await tx
          .select({
            id: s.attendancePunches.id,
            memberId: s.attendancePunches.memberId,
            kind: s.attendancePunches.kind,
            at: s.attendancePunches.punchedAt,
            liveness: s.attendancePunches.liveness,
            viaMemberId: s.attendancePunches.viaMemberId,
            newDevice: s.attendancePunches.newDevice,
            faceResult: s.attendancePhotos.faceResult,
            faceScore: s.attendancePhotos.faceScore,
            faceLikeMemberId: s.attendancePhotos.faceLikeMemberId,
          })
          .from(s.attendancePunches)
          .leftJoin(
            s.attendancePhotos,
            and(
              eq(s.attendancePhotos.punchId, s.attendancePunches.id),
              eq(s.attendancePhotos.kind, 'face'),
            ),
          )
          .leftJoin(
            s.attendancePunchReviews,
            eq(s.attendancePunchReviews.punchId, s.attendancePunches.id),
          )
          .where(
            and(
              eq(s.attendancePunches.storeId, store.id),
              isNull(s.attendancePunches.voidedAt),
              isNull(s.attendancePunchReviews.punchId),
              gte(s.attendancePunches.punchedAt, since),
              sql`(${s.attendancePunches.liveness} = 'fail'
                OR ${s.attendancePunches.viaMemberId} IS NOT NULL
                OR ${s.attendancePunches.newDevice}
                OR ${s.attendancePhotos.faceResult} = 'mismatch')`,
            ),
          )
          .orderBy(sql`${s.attendancePunches.punchedAt} DESC`)
          .limit(REVIEW_LIMIT);
        const ids = [
          ...new Set(
            rows.flatMap((r) => [r.memberId, r.viaMemberId, r.faceLikeMemberId]).filter(Boolean),
          ),
        ] as string[];
        const people =
          ids.length === 0
            ? []
            : await tx
                .select({ memberId: s.members.id, name: s.users.displayName })
                .from(s.members)
                .innerJoin(s.users, eq(s.users.id, s.members.userId))
                .where(inArray(s.members.id, ids));
        const nameOf = new Map(people.map((p) => [p.memberId, p.name ?? '—']));
        const [pending] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(s.attendanceOvertime)
          .innerJoin(s.attendancePunches, eq(s.attendancePunches.id, s.attendanceOvertime.punchId))
          .where(
            and(
              eq(s.attendanceOvertime.storeId, store.id),
              eq(s.attendanceOvertime.status, 'pending'),
              isNull(s.attendancePunches.voidedAt),
            ),
          );
        // Face enrollments waiting for a manager, of this store's people.
        const roster = await storeRoster(tx, session.orgId, store.id);
        const rosterName = new Map(roster.map((m) => [m.memberId, m.displayName]));
        const waiting =
          roster.length === 0
            ? []
            : await tx
                .select({
                  id: s.attendanceFaceEnrollments.id,
                  memberId: s.attendanceFaceEnrollments.memberId,
                  createdAt: s.attendanceFaceEnrollments.createdAt,
                })
                .from(s.attendanceFaceEnrollments)
                .where(
                  and(
                    inArray(s.attendanceFaceEnrollments.memberId, [...rosterName.keys()]),
                    eq(s.attendanceFaceEnrollments.status, 'pending'),
                  ),
                )
                .orderBy(asc(s.attendanceFaceEnrollments.createdAt));
        return {
          enrollments: waiting.map((e) => ({
            id: e.id,
            memberId: e.memberId,
            name: rosterName.get(e.memberId) ?? '—',
            own: e.memberId === session.memberId && !handlesOwn(session),
            date: dateInTz(e.createdAt, tz),
            time: rules.localTime(e.createdAt, tz),
          })),
          punches: rows.map((r) => ({
            id: r.id,
            memberId: r.memberId,
            name: nameOf.get(r.memberId) ?? '—',
            kind: r.kind,
            at: r.at.toISOString(),
            date: dateInTz(r.at, tz),
            time: rules.localTime(r.at, tz),
            face: r.faceResult ?? null,
            faceScore: r.faceScore ?? null,
            faceLikeName: r.faceLikeMemberId ? (nameOf.get(r.faceLikeMemberId) ?? '—') : null,
            liveness: r.liveness,
            viaName: r.viaMemberId ? (nameOf.get(r.viaMemberId) ?? '—') : null,
            newDevice: r.newDevice,
            own: r.memberId === session.memberId && !handlesOwn(session),
          })),
          overtimePending: pending?.n ?? 0,
        };
      });
    }),

  /** A manager looked at a flagged punch and lets it stand. */
  reviewPunch: idempotentMutation
    .input(AttendanceReviewPunchInputSchema)
    .mutation(async ({ ctx, input }) => {
      const session = ctx.session!;
      return ctx.withOrg(async (tx) => {
        const store = await authorize(tx, session, input.storeId, 'attendance.manage');
        const punch = await tx.query.attendancePunches.findFirst({
          where: (p, { and: and2, eq: eq2 }) =>
            and2(eq2(p.id, input.punchId), eq2(p.storeId, store.id)),
        });
        if (!punch) fail('NOT_FOUND', 'punchNotFound');
        refuseOwn(session, punch.memberId);
        await tx
          .insert(s.attendancePunchReviews)
          .values({
            punchId: punch.id,
            orgId: session.orgId,
            storeId: store.id,
            reviewedByMemberId: session.memberId,
          })
          .onConflictDoNothing();
        publish(session.orgId, store.id);
        return { ok: true as const };
      });
    }),
});
