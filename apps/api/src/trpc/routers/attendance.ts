/**
 * Attendance: clock in / out, the shift roster and the attendance sheet
 * (owner request 2026-11-05).
 *
 * - `attendance.clock` is switched on per member (a global allow override,
 *   `memberSet`); it is checked here for the concrete store, together with
 *   the member's assignment to that store.
 * - `attendance.manage` (store managers and up) plans shifts, reads the
 *   sheet, adds or voids punches with a reason and sets the store's rules.
 * - A self punch must pass the store's rules: the bound phone, the
 *   location radius and the store network's public address. The time is
 *   the server's; offline punches are not accepted.
 * - Punches are never deleted; a correction voids one (trigger-enforced).
 */
import { createHash } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { TRPCError } from '@trpc/server';
import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, ne, sql } from 'drizzle-orm';
import type { DB } from '@compass/db';
import { schema as s } from '@compass/db';
import {
  AttendanceCopyWeekInputSchema,
  AttendanceManualPunchInputSchema,
  AttendanceMeInputSchema,
  AttendanceMemberSetInputSchema,
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
import { env } from '../../env';
import { hub } from '../../realtime/hub';
import {
  assertActorAssignedToStore,
  effectivePermissionsForStore,
  getActorStoreIds,
} from '../../services/storeScope';
import { storeTimeZone } from '../../services/timeZone';
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

/** One literal address or CIDR range, normalised; null when invalid. */
export function parseIpRule(
  raw: string,
): { address: string; prefix: number | null; family: 'ipv4' | 'ipv6' } | null {
  const [addr, prefixRaw, extra] = raw.trim().split('/');
  if (!addr || extra !== undefined) return null;
  const v = isIP(addr);
  if (v === 0) return null;
  const family = v === 4 ? 'ipv4' : 'ipv6';
  if (prefixRaw === undefined) return { address: addr.toLowerCase(), prefix: null, family };
  if (!/^\d{1,3}$/.test(prefixRaw)) return null;
  const prefix = Number(prefixRaw);
  if (prefix > (v === 4 ? 32 : 128) || prefix < (v === 4 ? 8 : 16)) return null;
  return { address: addr.toLowerCase(), prefix, family };
}

export function ipAllowed(ip: string | null | undefined, rulesList: readonly string[]): boolean {
  if (!ip) return false;
  const v = isIP(ip);
  if (v === 0) return false;
  const list = new BlockList();
  for (const raw of rulesList) {
    const rule = parseIpRule(raw);
    if (!rule) continue;
    if (rule.prefix === null) list.addAddress(rule.address, rule.family);
    else list.addSubnet(rule.address, rule.prefix, rule.family);
  }
  return list.check(ip, v === 4 ? 'ipv4' : 'ipv6');
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
    requireIp: p?.requireIp ?? false,
    graceMinutes: p?.graceMinutes ?? 5,
  };
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
async function loadSheet(ctx: RequestContext, input: z.infer<typeof AttendanceSheetInputSchema>) {
  const session = ctx.session!;
  return ctx.withOrg(async (tx) => {
    const store = await authorize(tx, session, input.storeId, 'attendance.manage');
    const tz = tzOf(store, session);
    const days =
      (Date.parse(`${input.to}T00:00:00Z`) - Date.parse(`${input.from}T00:00:00Z`)) / DAY + 1;
    if (days > MAX_SHEET_DAYS) fail('BAD_REQUEST', 'rangeTooLong');
    const fromAt = new Date(rules.zonedTimeToUtc(input.from, '00:00', tz).getTime() - DAY);
    const toAt = new Date(
      rules.zonedTimeToUtc(rules.nextDate(input.to), '00:00', tz).getTime() + DAY,
    );
    const now = new Date();
    const [roster, policy, shifts, punches, devices] = await Promise.all([
      storeRoster(tx, session.orgId, store.id),
      loadPolicy(tx, store.id),
      tx
        .select()
        .from(s.attendanceShifts)
        .where(
          and(
            eq(s.attendanceShifts.storeId, store.id),
            gte(s.attendanceShifts.shiftDate, rules.nextDate(input.from, -1)),
            lte(s.attendanceShifts.shiftDate, input.to),
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
    ]);
    const memberIds = new Set([
      ...roster.map((m) => m.memberId),
      ...shifts.map((x) => x.memberId),
      ...punches.map((x) => x.memberId),
    ]);
    const enabled = await clockEnabled(tx, [...memberIds]);
    const names = new Map(roster.map((m) => [m.memberId, m.displayName]));
    const missingNames = [...memberIds].filter((id) => !names.has(id));
    const actorIds = punches
      .flatMap((p) => [p.createdByMemberId, p.voidedByMemberId])
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
      .filter((d) => d.date >= input.from && d.date <= input.to);
    const rosterIds = new Set(roster.map((m) => m.memberId));
    return {
      timezone: tz,
      today: todayInTz(tz, now),
      graceMinutes: view.graceMinutes,
      members: [...memberIds]
        .map((id) => ({
          memberId: id,
          name: names.get(id) ?? '—',
          inStore: rosterIds.has(id),
          enabled: enabled.has(id),
          deviceBoundAt: deviceBound.get(id)?.toISOString() ?? null,
        }))
        .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name)),
      shifts: shifts.filter((x) => x.shiftDate >= input.from).map((x) => shiftView(x, tz)),
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
        createdByName: p.source === 'manual' ? (names.get(p.createdByMemberId) ?? null) : null,
        voided: p.voidedAt
          ? {
              at: p.voidedAt.toISOString(),
              byName: p.voidedByMemberId ? (names.get(p.voidedByMemberId) ?? null) : null,
              reason: p.voidReason ?? '',
            }
          : null,
      })),
      days: summaries,
    };
  });
}

export type AttendanceSheetData = Awaited<ReturnType<typeof loadSheet>>;

async function loadPolicyView(ctx: RequestContext, storeId: string) {
  const session = ctx.session!;
  return ctx.withOrg(async (tx) => {
    const store = await authorize(tx, session, storeId, 'attendance.manage');
    const row = await loadPolicy(tx, store.id);
    return {
      ...policyView(row),
      allowedIps: row?.allowedIps ?? [],
      /** The address this request came from, to add the store's network. */
      yourIp: ctx.trustedIp ?? null,
      /** False until the Worker passes the real client address. */
      ipReliable: !!env.CLIENT_IP_PROXY_KEY,
    };
  });
}

export type AttendancePolicyData = Awaited<ReturnType<typeof loadPolicyView>>;

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
            requireIp: view.requireIp,
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

  punch: idempotentMutation.input(AttendancePunchInputSchema).mutation(async ({ ctx, input }) => {
    const session = ctx.session!;
    return ctx.withOrg(async (tx) => {
      const store = await authorize(tx, session, input.storeId, 'attendance.clock');
      // One punch at a time per member: the alternation check below reads
      // what the previous punch wrote.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${'attendance:' + session.memberId}))`,
      );
      const policy = policyView(await loadPolicy(tx, store.id));
      const now = new Date();

      // Device: the first punch binds the phone.
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
        fail('FORBIDDEN', 'otherDevice');
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

      const ip = ctx.trustedIp ?? null;
      if (policy.requireIp) {
        const row = await loadPolicy(tx, store.id);
        if (!ipAllowed(ip, row?.allowedIps ?? [])) fail('FORBIDDEN', 'networkNotAllowed');
      }

      const recent = await tx
        .select({ kind: s.attendancePunches.kind, at: s.attendancePunches.punchedAt })
        .from(s.attendancePunches)
        .where(
          and(
            eq(s.attendancePunches.memberId, session.memberId),
            eq(s.attendancePunches.storeId, store.id),
            isNull(s.attendancePunches.voidedAt),
            gte(s.attendancePunches.punchedAt, new Date(now.getTime() - 2 * DAY)),
          ),
        );
      const expected = rules.nextPunchKind(recent, now);
      if (input.kind !== expected) {
        fail('CONFLICT', input.kind === 'in' ? 'alreadyClockedIn' : 'notClockedIn');
      }

      const [row] = await tx
        .insert(s.attendancePunches)
        .values({
          orgId: session.orgId,
          storeId: store.id,
          memberId: session.memberId,
          kind: input.kind,
          punchedAt: now,
          source: 'self',
          geoLat: input.location ? input.location.lat.toFixed(6) : null,
          geoLng: input.location ? input.location.lng.toFixed(6) : null,
          geoAccuracyM: input.location ? Math.round(input.location.accuracy) : null,
          distanceM,
          clientIp: ip,
          createdByMemberId: session.memberId,
        })
        .returning();
      publish(session.orgId, store.id);
      const tz = tzOf(store, session);
      return {
        id: row!.id,
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
        const ips: string[] = [];
        for (const raw of input.allowedIps) {
          const rule = parseIpRule(raw);
          if (!rule) fail('BAD_REQUEST', 'badIp', { context: { value: raw.slice(0, 64) } });
          const text = rule.prefix === null ? rule.address : `${rule.address}/${rule.prefix}`;
          if (!ips.includes(text)) ips.push(text);
        }
        const values = {
          requireDevice: input.requireDevice,
          requireGeo: input.requireGeo,
          geoLat: input.geo ? input.geo.lat.toFixed(6) : null,
          geoLng: input.geo ? input.geo.lng.toFixed(6) : null,
          geoRadiusM: input.geo?.radiusM ?? null,
          requireIp: input.requireIp,
          allowedIps: ips,
          graceMinutes: input.graceMinutes,
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
});
