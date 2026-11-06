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
 */
import { createHash } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, ne, sql } from 'drizzle-orm';
import type { DB } from '@compass/db';
import { schema as s } from '@compass/db';
import {
  AttendanceColleaguesInputSchema,
  AttendanceCopyWeekInputSchema,
  AttendanceLivenessChallengeInputSchema,
  AttendanceExportLinkInputSchema,
  AttendanceManualPunchInputSchema,
  AttendanceMeInputSchema,
  AttendanceMemberSetInputSchema,
  AttendanceOvertimeDecideInputSchema,
  AttendancePunchPhotosInputSchema,
  AttendanceFaceRefInputSchema,
  AttendanceFaceRefSetInputSchema,
  AttendancePayRateSetInputSchema,
  AttendanceWageSuggestionsInputSchema,
  AttendancePolicyGetInputSchema,
  AttendancePolicySaveInputSchema,
  AttendancePunchInputSchema,
  AttendanceResetDeviceInputSchema,
  AttendanceSheetInputSchema,
  AttendanceShiftDeleteInputSchema,
  AttendanceShiftSaveInputSchema,
  AttendanceVoidPunchInputSchema,
} from '@compass/contracts';
import { z } from 'zod';
import { attendance as rules, dateInTz, todayInTz } from '@compass/domain';
import { hub } from '../../realtime/hub';
import {
  assertActorAssignedToStore,
  effectivePermissionsForStore,
  getActorStoreIds,
} from '../../services/storeScope';
import { storeTimeZone } from '../../services/timeZone';
import { cosine, faceFeature, MATCH_THRESHOLD, type FaceResult } from '../../services/face';
import {
  evaluateLiveness,
  signLivenessToken,
  verifyLivenessToken,
  type LivenessVerdict,
} from '../../services/face/liveness';
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
};
type StoreRow = typeof s.stores.$inferSelect;
type PolicyRow = typeof s.attendanceStorePolicies.$inferSelect;

const DAY = 24 * 3600_000;
/** The longest range the sheet reads at once. */
const MAX_SHEET_DAYS = 62;
/** A phone fix this coarse cannot place anyone inside a store. */
const MAX_ACCURACY_M = 300;
/** Slack for the phone's own uncertainty, capped. */
const MAX_ACCURACY_SLACK_M = 50;

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
    requirePhoto: p?.requirePhoto ?? false,
    requireFace: (p?.requirePhoto ?? false) && (p?.requireFace ?? false),
    requireLiveness:
      (p?.requirePhoto ?? false) && (p?.requireFace ?? false) && (p?.requireLiveness ?? false),
  };
}

type FaceVerdict = {
  result: 'match' | 'mismatch' | 'enrolled' | 'unchecked';
  score: number | null;
};

/**
 * The face photo against `memberId`'s reference. `enrolled` = no reference
 * yet: this face becomes it once the punch is written. `checked` is the
 * worker's answer; null = the check could not run.
 */
async function faceCompare(
  tx: DB,
  memberId: string,
  checked: FaceResult | null,
): Promise<FaceVerdict> {
  if (!checked || !checked.found) return { result: 'unchecked', score: null };
  const ref = await tx.query.attendanceFaceRefs.findFirst({
    where: (r, { eq: eq2 }) => eq2(r.memberId, memberId),
  });
  if (!ref) return { result: 'enrolled', score: null };
  const score = cosine(ref.feature, checked.feature);
  return { result: score >= MATCH_THRESHOLD ? 'match' : 'mismatch', score };
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
    tx
      .select()
      .from(s.attendanceOvertime)
      .where(
        and(
          eq(s.attendanceOvertime.storeId, store.id),
          gte(s.attendanceOvertime.createdAt, fromAt),
          lte(s.attendanceOvertime.createdAt, new Date(toAt.getTime() + DAY)),
        ),
      ),
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
  for (const ph of photoRows) {
    photoKinds.set(ph.punchId, [...(photoKinds.get(ph.punchId) ?? []), ph.kind]);
    if (ph.faceResult) faceOf.set(ph.punchId, { result: ph.faceResult, score: ph.faceScore });
  }
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
  const faceRefs = await tx
    .select({ memberId: s.attendanceFaceRefs.memberId, setAt: s.attendanceFaceRefs.setAt })
    .from(s.attendanceFaceRefs)
    .where(eq(s.attendanceFaceRefs.orgId, session.orgId));
  const faceRefAt = new Map(faceRefs.map((r) => [r.memberId, r.setAt]));
  const view = policyView(policy);
  const summaries = rules
    .summarize({
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
    })
    .filter((d) => d.date >= from && d.date <= to);
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
      date: dateInTz(punchById.get(o.punchId)!.punchedAt, tz),
      minutes: o.minutes,
      reason: o.reason,
      status: o.status,
      decidedByName: o.decidedByMemberId ? (names.get(o.decidedByMemberId) ?? null) : null,
      decisionNote: o.decisionNote,
    }));
  return {
    timezone: tz,
    today: todayInTz(tz, now),
    graceMinutes: view.graceMinutes,
    requireFace: view.requireFace,
    requireLiveness: view.requireLiveness,
    members: [...memberIds]
      .map((id) => ({
        memberId: id,
        name: names.get(id) ?? '—',
        inStore: rosterIds.has(id),
        enabled: enabled.has(id),
        deviceBoundAt: deviceBound.get(id)?.toISOString() ?? null,
        faceRefAt: faceRefAt.get(id)?.toISOString() ?? null,
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
      time: rules.localTime(p.punchedAt, tz),
      source: p.source,
      reason: p.reason,
      distanceM: p.distanceM,
      photos: photoKinds.get(p.id) ?? [],
      face: (faceOf.get(p.id) ?? null) as {
        result: 'match' | 'mismatch' | 'enrolled' | 'unchecked';
        score: number | null;
      } | null,
      liveness: p.liveness,
      livenessScore: p.livenessScore,
      viaName: p.viaMemberId ? (names.get(p.viaMemberId) ?? '—') : null,
      newDevice: p.newDevice,
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
      };
    });
  }),

  /**
   * A fresh liveness challenge: the turn order the phone must prompt, in a
   * signed token good for one punch and three minutes. `forMemberId` when
   * clocking a colleague in on this phone.
   */
  livenessChallenge: authedProcedure
    .input(AttendanceLivenessChallengeInputSchema)
    .mutation(async ({ ctx, input }) => {
      const session = ctx.session!;
      const target = input.forMemberId ?? session.memberId;
      await ctx.withOrg(async (tx) => {
        const store = await authorize(tx, session, input.storeId, 'attendance.clock');
        if (target !== session.memberId) await assertColleague(tx, session, store.id, target);
      });
      return signLivenessToken({
        org: session.orgId,
        mid: target,
        by: session.memberId,
        storeId: input.storeId,
      });
    }),

  /**
   * Colleagues who can clock in on this phone (owner request 2026-11-06:
   * a forgotten or broken phone is no excuse): same store, clocking on,
   * a reference face on file, with the store's face check on.
   */
  colleagues: authedProcedure
    .input(AttendanceColleaguesInputSchema)
    .query(async ({ ctx, input }) => {
      const session = ctx.session!;
      return ctx.withOrg(async (tx) => {
        const store = await authorize(tx, session, input.storeId, 'attendance.clock');
        const policy = policyView(await loadPolicy(tx, store.id));
        if (!policy.requireFace) return { available: false, members: [] };
        const roster = (await storeRoster(tx, session.orgId, store.id)).filter(
          (m) => m.memberId !== session.memberId,
        );
        const enabled = await clockEnabled(
          tx,
          roster.map((m) => m.memberId),
        );
        const refs =
          roster.length === 0
            ? []
            : await tx
                .select({ memberId: s.attendanceFaceRefs.memberId })
                .from(s.attendanceFaceRefs)
                .where(
                  inArray(
                    s.attendanceFaceRefs.memberId,
                    roster.map((m) => m.memberId),
                  ),
                );
        const withFace = new Set(refs.map((r) => r.memberId));
        const now = new Date();
        const recent =
          roster.length === 0
            ? []
            : await tx
                .select({
                  memberId: s.attendancePunches.memberId,
                  kind: s.attendancePunches.kind,
                  at: s.attendancePunches.punchedAt,
                })
                .from(s.attendancePunches)
                .where(
                  and(
                    inArray(
                      s.attendancePunches.memberId,
                      roster.map((m) => m.memberId),
                    ),
                    eq(s.attendancePunches.storeId, store.id),
                    isNull(s.attendancePunches.voidedAt),
                    gte(s.attendancePunches.punchedAt, new Date(now.getTime() - 2 * DAY)),
                  ),
                );
        return {
          available: true,
          members: roster
            .filter((m) => enabled.has(m.memberId))
            .map((m) => ({
              memberId: m.memberId,
              name: m.displayName,
              faceOnFile: withFace.has(m.memberId),
              nextKind: rules.nextPunchKind(
                recent.filter((r) => r.memberId === m.memberId),
                now,
              ),
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        };
      });
    }),

  punch: idempotentMutation.input(AttendancePunchInputSchema).mutation(async ({ ctx, input }) => {
    const session = ctx.session!;
    const target = input.forMemberId ?? session.memberId;
    const borrowed = target !== session.memberId;
    // The face and liveness checks (~0.5 s a frame) run before the
    // transaction, not inside it.
    const pre = policyView(await ctx.withOrg((tx) => loadPolicy(tx, input.storeId)));
    if (borrowed && !pre.requireFace) fail('FORBIDDEN', 'borrowNeedsFace');
    let checked: FaceResult | null = null;
    if (input.photos && pre.requireFace) {
      checked = await faceFeature(photoBytes(input.photos.face));
      if (checked && !checked.found) fail('BAD_REQUEST', 'faceNotFound');
    }
    // A borrowed phone always asks for liveness: nobody else vouches for it.
    let live: LivenessVerdict | null = null;
    let nonce: string | null = null;
    if (pre.requireLiveness || borrowed) {
      if (!input.photos || !input.liveness) fail('BAD_REQUEST', 'livenessRequired');
      const claims = await verifyLivenessToken(input.liveness.token);
      if (
        !claims ||
        claims.org !== session.orgId ||
        claims.by !== session.memberId ||
        claims.mid !== target ||
        claims.storeId !== input.storeId
      ) {
        fail('BAD_REQUEST', 'livenessExpired');
      }
      nonce = claims.nonce;
      const left = await faceFeature(photoBytes(input.liveness.left));
      const right = await faceFeature(photoBytes(input.liveness.right));
      live = evaluateLiveness(checked, left, right);
      if (live.result === 'fail' && (borrowed || !input.acceptLivenessFail)) {
        fail('BAD_REQUEST', 'livenessFailed', { context: { failures: live.failures } });
      }
      if (live.result === 'unchecked' && borrowed) fail('BAD_REQUEST', 'faceCheckUnavailable');
    }
    return ctx.withOrg(async (tx) => {
      const store = await authorize(tx, session, input.storeId, 'attendance.clock');
      if (borrowed) await assertColleague(tx, session, store.id, target);
      // One punch at a time per member: the alternation check below reads
      // what the previous punch wrote.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'attendance:' + target}))`);
      const policy = policyView(await loadPolicy(tx, store.id));
      const now = new Date();
      // Face + surroundings, taken on the spot (owner request 2026-11-05).
      if (policy.requirePhoto && !input.photos) fail('BAD_REQUEST', 'photoRequired');
      if (borrowed && !policy.requireFace) fail('FORBIDDEN', 'borrowNeedsFace');
      const photos = input.photos
        ? { face: photoBytes(input.photos.face), scene: photoBytes(input.photos.scene) }
        : null;

      // A failed liveness check never becomes, or is compared as, a reference.
      const face: FaceVerdict | null =
        photos && policy.requireFace
          ? live?.result === 'fail'
            ? { result: 'unchecked', score: null }
            : await faceCompare(tx, target, checked)
          : null;
      if (borrowed && face?.result !== 'match') {
        if (face?.result === 'unchecked') fail('BAD_REQUEST', 'faceCheckUnavailable');
        fail('FORBIDDEN', face?.result === 'enrolled' ? 'borrowNoFace' : 'borrowFaceMismatch');
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
        } else if (device.deviceHash !== hash && policy.requireDevice) {
          // A lost or broken phone is no excuse (owner, 2026-11-06): with
          // the face (and liveness) confirmed, the new phone clocks too,
          // marked for the managers, who rebind it with "reset device".
          const confirmed =
            face?.result === 'match' && (!policy.requireLiveness || live?.result === 'pass');
          if (!confirmed) fail('FORBIDDEN', 'otherDevice');
          newDevice = true;
        }
      }

      let distanceM: number | null = null;
      if (policy.requireGeo && policy.geo) {
        const loc = input.location;
        if (!loc) fail('BAD_REQUEST', 'locationRequired');
        if (loc.accuracy > MAX_ACCURACY_M) {
          fail('BAD_REQUEST', 'locationInaccurate', {
            context: { accuracy: Math.round(loc.accuracy) },
          });
        }
        distanceM = Math.round(rules.distanceMeters(loc, policy.geo));
        const slack = Math.min(loc.accuracy, MAX_ACCURACY_SLACK_M);
        if (distanceM > policy.geo.radiusM + slack) {
          fail('FORBIDDEN', 'outsideArea', {
            context: { distance: distanceM, radius: policy.geo.radiusM },
          });
        }
      } else if (input.location && policy.geo) {
        distanceM = Math.round(rules.distanceMeters(input.location, policy.geo));
      }

      const recent = await tx
        .select({ kind: s.attendancePunches.kind, at: s.attendancePunches.punchedAt })
        .from(s.attendancePunches)
        .where(
          and(
            eq(s.attendancePunches.memberId, target),
            eq(s.attendancePunches.storeId, store.id),
            isNull(s.attendancePunches.voidedAt),
            gte(s.attendancePunches.punchedAt, new Date(now.getTime() - 2 * DAY)),
          ),
        );
      const expected = rules.nextPunchKind(recent, now);
      if (input.kind !== expected) {
        fail('CONFLICT', input.kind === 'in' ? 'alreadyClockedIn' : 'notClockedIn');
      }

      // Well past the shift's end: the person says why, and it waits for a
      // manager's approval before it counts (owner decision 2026-11-05).
      const overtime =
        input.kind === 'out'
          ? await overtimeFor(tx, target, store.id, now, policy.overtimeAfterMinutes)
          : null;
      if (overtime && !input.overtimeReason) {
        fail('BAD_REQUEST', 'overtimeReasonRequired', { context: { minutes: overtime.minutes } });
      }

      const inserted = await tx
        .insert(s.attendancePunches)
        .values({
          orgId: session.orgId,
          storeId: store.id,
          memberId: target,
          kind: input.kind,
          punchedAt: now,
          source: 'self',
          geoLat: input.location ? input.location.lat.toFixed(6) : null,
          geoLng: input.location ? input.location.lng.toFixed(6) : null,
          geoAccuracyM: input.location ? Math.round(input.location.accuracy) : null,
          distanceM,
          createdByMemberId: session.memberId,
          liveness: live?.result ?? null,
          livenessScore: live?.score ?? null,
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
      if (photos) {
        if (face?.result === 'enrolled') {
          await tx.insert(s.attendanceFaceRefs).values({
            memberId: target,
            orgId: session.orgId,
            feature: (checked as Extract<FaceResult, { found: true }>).feature,
            bytes: photos.face,
            sourcePunchId: row.id,
            setByMemberId: target,
          });
        }
        const frames: { kind: 'face' | 'scene' | 'left' | 'right'; bytes: Buffer }[] = [
          { kind: 'face', bytes: photos.face },
          { kind: 'scene', bytes: photos.scene },
        ];
        if (input.liveness && live) {
          frames.push(
            { kind: 'left', bytes: photoBytes(input.liveness.left) },
            { kind: 'right', bytes: photoBytes(input.liveness.right) },
          );
        }
        await tx.insert(s.attendancePhotos).values(
          frames.map(({ kind, bytes }) => ({
            orgId: session.orgId,
            storeId: store.id,
            memberId: target,
            punchId: row.id,
            kind,
            bytes,
            takenAt: now,
            faceResult: kind === 'face' ? (face?.result ?? null) : null,
            faceScore: kind === 'face' ? (face?.score ?? null) : null,
          })),
        );
      }

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
      if (face?.result === 'mismatch')
        flags.push({
          template: 'attendance.faceMismatch',
          title: 'Face does not match',
          key: 'face',
        });
      if (live?.result === 'fail')
        flags.push({
          template: 'attendance.livenessFailed',
          title: 'Liveness check failed',
          key: 'live',
        });
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
          template:
            input.kind === 'in' ? 'attendance.clockedInForYou' : 'attendance.clockedOutForYou',
          title: "Clocked on a colleague's phone",
          vars,
          deepLink: '/attendance',
          dedupKey: `attendance:you:${row.id}`,
        });
      }
      publish(session.orgId, store.id);
      return {
        id: row.id,
        face: face?.result ?? null,
        liveness: live?.result ?? null,
        newDevice,
        overtimeMinutes: overtime?.minutes ?? 0,
        kind: input.kind,
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
        // Switched off clocking: their reference face goes too.
        if (!input.enabled)
          await tx
            .delete(s.attendanceFaceRefs)
            .where(eq(s.attendanceFaceRefs.memberId, input.memberId));
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
          requirePhoto: input.requirePhoto,
          requireFace: input.requirePhoto && input.requireFace,
          requireLiveness: input.requirePhoto && input.requireFace && input.requireLiveness,
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

  /** A member's reference face, for the manager to check. */
  faceRef: authedProcedure.input(AttendanceFaceRefInputSchema).query(async ({ ctx, input }) => {
    const session = ctx.session!;
    return ctx.withOrg(async (tx) => {
      const store = await authorize(tx, session, input.storeId, 'attendance.manage');
      await assertInStore(tx, session.orgId, store.id, input.memberId);
      const ref = await tx.query.attendanceFaceRefs.findFirst({
        where: (r, { eq: eq2 }) => eq2(r.memberId, input.memberId),
        columns: { bytes: true, setAt: true },
      });
      return ref
        ? {
            src: `data:image/jpeg;base64,${Buffer.from(ref.bytes).toString('base64')}`,
            setAt: ref.setAt.toISOString(),
          }
        : null;
    });
  }),

  /** Make a punch's face photo the member's reference face. */
  faceRefSet: idempotentMutation
    .input(AttendanceFaceRefSetInputSchema)
    .mutation(async ({ ctx, input }) => {
      const session = ctx.session!;
      const photo = await ctx.withOrg(async (tx) => {
        const store = await authorize(tx, session, input.storeId, 'attendance.manage');
        const [row] = await tx
          .select({ memberId: s.attendancePhotos.memberId, bytes: s.attendancePhotos.bytes })
          .from(s.attendancePhotos)
          .where(
            and(
              eq(s.attendancePhotos.storeId, store.id),
              eq(s.attendancePhotos.punchId, input.punchId),
              eq(s.attendancePhotos.kind, 'face'),
            ),
          );
        if (!row) fail('NOT_FOUND', 'photoNotFound');
        return row;
      });
      const checked = await faceFeature(new Uint8Array(photo.bytes));
      if (!checked) fail('CONFLICT', 'faceCheckUnavailable');
      if (!checked.found) fail('BAD_REQUEST', 'faceNotFound');
      return ctx.withOrg(async (tx) => {
        const store = await authorize(tx, session, input.storeId, 'attendance.manage');
        const values = {
          orgId: session.orgId,
          feature: checked.feature,
          bytes: Buffer.from(photo.bytes),
          sourcePunchId: input.punchId,
          setByMemberId: session.memberId,
          setAt: new Date(),
        };
        await tx
          .insert(s.attendanceFaceRefs)
          .values({ memberId: photo.memberId, ...values })
          .onConflictDoUpdate({ target: s.attendanceFaceRefs.memberId, set: values });
        publish(session.orgId, store.id);
        return { ok: true as const };
      });
    }),

  /** Forget a member's reference face; their next punch enrolls again. */
  faceRefClear: idempotentMutation
    .input(AttendanceFaceRefInputSchema)
    .mutation(async ({ ctx, input }) => {
      const session = ctx.session!;
      return ctx.withOrg(async (tx) => {
        const store = await authorize(tx, session, input.storeId, 'attendance.manage');
        await assertInStore(tx, session.orgId, store.id, input.memberId);
        await tx
          .delete(s.attendanceFaceRefs)
          .where(eq(s.attendanceFaceRefs.memberId, input.memberId));
        publish(session.orgId, store.id);
        return { ok: true as const };
      });
    }),
});
