import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, schema as s, withOrgContext } from '@compass/db';
import { attendance, dateInTz, todayInTz } from '@compass/domain';
import { loadCatalog } from '@compass/i18n/catalogs';
import { Hono } from 'hono';
import { logger } from '../infra/log';
import { attendanceMonthExport } from '../http/attendanceExport';
import { appRouter } from '../trpc/router';
import { scanAttendanceReminders } from '../services/attendanceReminders';
import {
  purgeOldAttendancePhotos,
  purgeOldFramePrints,
} from '../services/attendancePhotoRetention';
import { setFaceEngineForTests } from '../services/face';
import { signLivenessToken } from '../services/face/liveness';
import type { RequestContext, SessionContext } from '../trpc/context';

(function loadEnv() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate) && existsSync(resolve(dir, 'pnpm-workspace.yaml'))) {
      for (const raw of readFileSync(candidate, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const idx = line.indexOf('=');
        if (idx < 0) continue;
        const key = line.slice(0, idx).trim();
        const value = line
          .slice(idx + 1)
          .trim()
          .replace(/^"(.*)"$/, '$1');
        if (!(key in process.env)) process.env[key] = value;
      }
      return;
    }
    dir = resolve(dir, '..');
  }
})();

const SHOULD_RUN = !!process.env.DATABASE_URL && process.env.SKIP_PG_TESTS !== '1';

describe('attendance copy', () => {
  test('every attendance error has a sentence in every language', async () => {
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../trpc/routers/attendance.ts'),
      'utf8',
    );
    const keys = [...src.matchAll(/fail\(\s*'[A-Z_]+',\s*'([A-Za-z]+)'/g)].map(
      (m) => `attendance.errors.${m[1]}`,
    );
    expect(keys.length).toBeGreaterThan(10);
    for (const locale of ['en', 'zh', 'ru', 'uz'] as const) {
      const catalog = await loadCatalog(locale);
      for (const key of keys)
        expect([locale, key, typeof catalog[key]]).toEqual([locale, key, 'string']);
    }
  });
});

type Caller = ReturnType<typeof appRouter.createCaller>;

interface Fixture {
  orgId: string;
  storeId: string;
  otherStoreId: string;
  staffId: string;
  staffUserId: string;
  managerId: string;
  managerUserId: string;
  outsiderId: string;
  colleagueId: string;
  colleagueUserId: string;
  colleague: () => ReturnType<typeof appRouter.createCaller>;
  manager: ReturnType<typeof appRouter.createCaller>;
  /** The manager, also a super admin. */
  superAdmin: () => ReturnType<typeof appRouter.createCaller>;
  staff: () => ReturnType<typeof appRouter.createCaller>;
}
let fx: Fixture | null = null;

function buildCtx(session: SessionContext): RequestContext {
  const db = getDb(undefined, { system: 'maintenance' });
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hono: {} as any,
    db,
    log: logger,
    traceId: `attendance-test-${Date.now()}`,
    ip: null,
    userAgent: null,
    idempotencyKey: null,
    session,
    async withOrg(fn, options) {
      return withOrgContext(db, session.orgId, fn, options);
    },
  };
}

const TZ = 'Asia/Tashkent';
const DEVICE = 'device-aaaaaaaaaaaaaaaa';
const OTHER_DEVICE = 'device-bbbbbbbbbbbbbbbb';
const SHOP = { lat: 41.311081, lng: 69.240562 };

/** A fake JPEG whose text says what the stub face model sees. */
const jpeg = (tag: string) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag)]).toString('base64');
const unit = (i: number) => Array.from({ length: 128 }, (_, j) => (j === i ? 1 : 0));
/**
 * A picture taken now, not one sent before: tag "...#n" leans the face a
 * little towards its own direction, so two punches never give the same
 * picture (a frame sent again is refused, 2026-11-07).
 */
const taken = (f: number[], tag: string) => {
  const n = /#(\d+)/.exec(tag)?.[1];
  if (n === undefined) return f;
  const lean = Array.from({ length: 128 }, (_, j) => (j === 3 + (Number(n) % 90) ? 0.1 : 0));
  const v = f.map((x, j) => x + lean[j]!);
  const norm = Math.sqrt(v.reduce((t, x) => t + x * x, 0));
  return v.map((x) => x / norm);
};
let frameSeq = 0;
/** Tag ":half": a picture only somewhat like the person (score ~0.4), leaning towards Dan. */
const half = (f: number[]) => f.map((x, j) => x * 0.4 + (j === 110 ? 0.917 : 0));
/** A blink or an open mouth: the same person, a slightly different picture. */
const moved = (f: number[], yes: boolean) =>
  yes ? f.map((x, j) => (j === 100 ? 0.31 : x * 0.95)) : f;
/**
 * The stub face model. Tag "<who>:<pose>[:print|:dark|:half]": Ali (the staff
 * member), Bob (the colleague), Cat or Dan (strangers); left / right turn the
 * head; print = a photo held up (low real-face score); unsure = a real-face
 * score between the lines; flat = no turn;
 * dark = a dark photo; "nobody" = no face; "boom" = the model is down.
 */
function stubFaces() {
  setFaceEngineForTests(async (bytes) => {
    const tag = Buffer.from(bytes).toString('latin1');
    if (tag.includes('nobody')) return { found: false };
    if (tag.includes('boom')) throw new Error('model down');
    const yaw = tag.includes(':left') ? 0.5 : tag.includes(':right') ? -0.5 : 0;
    return {
      found: true,
      score: 0.95,
      feature: moved(
        taken(
          (tag.includes(':half') ? half : (f: number[]) => f)(
            unit(tag.includes('Bob') ? 1 : tag.includes('Cat') ? 2 : tag.includes('Dan') ? 110 : 0),
          ),
          tag,
        ),
        tag.includes(':blink') || tag.includes(':mouth'),
      ),
      yaw,
      real: tag.includes('print') ? 0.05 : tag.includes('unsure') ? 0.6 : 0.95,
      quality: {
        faces: 1,
        size: 0.35,
        light: tag.includes('dark') ? 20 : 120,
        sharp: 200,
        pitch: 0.5,
      },
    };
  });
}

const enrollPhotos = (who: string, over: Partial<Record<string, string>> = {}) => ({
  front: jpeg(over.front ?? `${who}:front`),
  left: jpeg(over.left ?? `${who}:left`),
  right: jpeg(over.right ?? `${who}:right`),
  up: jpeg(over.up ?? `${who}:up`),
  down: jpeg(over.down ?? `${who}:down`),
  front2: jpeg(over.front2 ?? `${who}:front2`),
});

/** Agree, enroll `who`'s face and have the manager approve it. */
async function enrollApproved(caller: Caller, who: string) {
  const f = fx!;
  await caller.attendance.faceConsentGive({ version: 1 });
  const e = await caller.attendance.faceEnroll({ storeId: f.storeId, photos: enrollPhotos(who) });
  await f.manager.attendance.faceEnrollDecide({
    storeId: f.storeId,
    enrollmentId: e.id,
    approve: true,
  });
}

/** A token with no turns asked: a passive punch (one face photo). */
async function passiveToken(memberId: string) {
  const f = fx!;
  return (
    await signLivenessToken({
      org: f.orgId,
      mid: memberId,
      by: memberId,
      storeId: f.storeId,
      steps: [],
    })
  ).token;
}

/** A face punch: a challenge with the turns (unless `token`), then the photos. */
async function clock(
  caller: Caller,
  opts: {
    kind?: 'in' | 'out';
    who?: string;
    /** The straight frame's tag, when it is not `who`'s face. */
    face?: string;
    device?: string;
    location?: { lat: number; lng: number; accuracy: number } | null;
    overtimeReason?: string;
    left?: string;
    right?: string;
    blink?: string | null;
    mouth?: string | null;
    token?: string;
    identify?: boolean;
    scene?: string;
    /** Send the pictures of punch `seq` (again); null = pictures without a number. */
    seq?: number | null;
  } = {},
) {
  const f = fx!;
  const who = opts.who ?? 'Ali';
  // This punch's own pictures (see `taken`).
  const n = opts.seq === undefined ? ++frameSeq : opts.seq;
  const shot = (tag: string) => jpeg(n === null ? tag : `${tag}#${n}`);
  const token =
    opts.token ??
    (
      await caller.attendance.livenessChallenge({
        storeId: f.storeId,
        identify: opts.identify,
        force: true,
      })
    ).token;
  return caller.attendance.punch({
    storeId: f.storeId,
    kind: opts.identify ? undefined : (opts.kind ?? 'in'),
    identify: opts.identify,
    deviceId: opts.device ?? OTHER_DEVICE,
    location: opts.location,
    photos: {
      face: shot(opts.face ?? `${who}:front`),
      scene: opts.scene ? jpeg(opts.scene) : undefined,
    },
    liveness: {
      token,
      left: shot(opts.left ?? `${who}:left`),
      right: shot(opts.right ?? `${who}:right`),
      blink: opts.blink === null ? undefined : shot(opts.blink ?? `${who}:blink`),
      mouth: opts.mouth === null ? undefined : shot(opts.mouth ?? `${who}:mouth`),
    },
    overtimeReason: opts.overtimeReason,
  });
}

/** Void everyone's open punches, so in / out starts over. */
async function resetPunches(...memberIds: string[]) {
  const db = getDb(undefined, { system: 'maintenance' });
  for (const id of memberIds) {
    await db.execute(
      sql`UPDATE inventory.attendance_punches SET voided_at = now(), voided_by_member_id = member_id, void_reason = 'test reset' WHERE member_id = ${id} AND voided_at IS NULL`,
    );
  }
}

async function expectError(p: Promise<unknown>, message: string) {
  let err: unknown = null;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect((err as Error | null)?.message).toBe(message);
}

afterAll(() => setFaceEngineForTests(null));

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  stubFaces();
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  const tg = (n: number) => BigInt(`${Date.now()}`.slice(-10) + String(n).padStart(2, '0'));
  const [org] = await db
    .insert(s.organizations)
    .values({
      slug: `attendance-test-${suffix}`,
      name: 'Attendance Test',
      localeDefault: 'en',
      timezone: TZ,
    })
    .returning();
  const person = async (name: string, n: number) => {
    const [u] = await db
      .insert(s.users)
      .values({ displayName: name, tgUserId: tg(n) })
      .returning();
    const [m] = await db
      .insert(s.members)
      .values({ orgId: org!.id, userId: u!.id, status: 'active' })
      .returning();
    return { userId: u!.id, memberId: m!.id };
  };
  const mgr = await person('Att Manager', 1);
  const staff = await person('Att Staff', 2);
  const outsider = await person('Att Outsider', 3);
  const colleague = await person('Att Colleague', 4);
  const [store] = await db
    .insert(s.stores)
    .values({ orgId: org!.id, name: 'Att Store' })
    .returning();
  const [other] = await db
    .insert(s.stores)
    .values({ orgId: org!.id, name: 'Other Store' })
    .returning();
  await db
    .insert(s.permissions)
    .values([
      { key: 'attendance.clock', description: 't' },
      { key: 'attendance.manage', description: 't' },
    ])
    .onConflictDoNothing();
  const [mgrRole] = await db
    .insert(s.roles)
    .values({ orgId: org!.id, slug: `att-manager-${suffix}`, name: 'Manager', rank: 60 })
    .returning();
  const [staffRole] = await db
    .insert(s.roles)
    .values({ orgId: org!.id, slug: `att-staff-${suffix}`, name: 'Staff', rank: 20 })
    .returning();
  await db
    .insert(s.rolePermissions)
    .values({ roleId: mgrRole!.id, permissionKey: 'attendance.manage' });
  await db.insert(s.memberRoleBindings).values([
    { memberId: mgr.memberId, roleId: mgrRole!.id, scopeType: 'store', scopeId: store!.id },
    { memberId: staff.memberId, roleId: staffRole!.id, scopeType: 'store', scopeId: store!.id },
    { memberId: outsider.memberId, roleId: staffRole!.id, scopeType: 'store', scopeId: other!.id },
    { memberId: colleague.memberId, roleId: staffRole!.id, scopeType: 'store', scopeId: store!.id },
  ]);
  await db.insert(s.memberStoreAssignments).values([
    { memberId: mgr.memberId, storeId: store!.id },
    { memberId: staff.memberId, storeId: store!.id },
    { memberId: outsider.memberId, storeId: other!.id },
    { memberId: colleague.memberId, storeId: store!.id },
  ]);
  const session = (p: { userId: string; memberId: string }, perms: string[]): SessionContext => ({
    userId: p.userId,
    memberId: p.memberId,
    orgId: org!.id,
    orgTimezone: TZ,
    writeAccess: true,
    permissions: new Set(perms),
    roleSlugs: new Set(),
  });
  fx = {
    orgId: org!.id,
    storeId: store!.id,
    otherStoreId: other!.id,
    staffId: staff.memberId,
    staffUserId: staff.userId,
    managerId: mgr.memberId,
    managerUserId: mgr.userId,
    outsiderId: outsider.memberId,
    colleagueId: colleague.memberId,
    colleagueUserId: colleague.userId,
    colleague: () => appRouter.createCaller(buildCtx(session(colleague, ['attendance.clock']))),
    manager: appRouter.createCaller(buildCtx(session(mgr, ['attendance.manage']))),
    superAdmin: () =>
      appRouter.createCaller(
        buildCtx({ ...session(mgr, ['attendance.manage']), roleSlugs: new Set(['super_admin']) }),
      ),
    staff: () => appRouter.createCaller(buildCtx(session(staff, ['attendance.clock']))),
  };
});

describe.skipIf(!SHOULD_RUN)('attendance', () => {
  test('clocking needs the member switch', async () => {
    const f = fx!;
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
    const f = fx!;
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
    const f = fx!;
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
    const f = fx!;
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
    await f.manager.attendance.policySave({ ...base, requireGeo: false, geo: null });
  });

  test('roster, sheet, manual punch and void', async () => {
    const f = fx!;
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
    const f = fx!;
    const db = getDb(undefined, { system: 'maintenance' });
    const [row] = await db
      .select({ id: s.attendancePunches.id })
      .from(s.attendancePunches)
      .where(eq(s.attendancePunches.memberId, f.staffId))
      .limit(1);
    await expect(
      (async () => db.delete(s.attendancePunches).where(eq(s.attendancePunches.id, row!.id)))(),
    ).rejects.toThrow();
    await expect(
      (async () =>
        db
          .update(s.attendancePunches)
          .set({ punchedAt: sql`now() - interval '1 hour'` })
          .where(eq(s.attendancePunches.id, row!.id)))(),
    ).rejects.toThrow();
  });

  test('copy a week skips clashes', async () => {
    const f = fx!;
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

describe.skipIf(!SHOULD_RUN)('attendance pay and overtime', () => {
  /** The pay test's shift date, which the export test reads back. */
  let payDate = '';
  test('late is deducted; a late clock-out needs a reason and an approval', async () => {
    const f = fx!;
    const db = getDb(undefined, { system: 'maintenance' });
    await db.execute(
      sql`UPDATE inventory.attendance_punches SET voided_at = now(), voided_by_member_id = member_id, void_reason = 'test reset' WHERE member_id = ${f.staffId} AND voided_at IS NULL`,
    );
    const now = new Date();
    const start = new Date(now.getTime() - 5 * 3600_000);
    const end = new Date(now.getTime() - 3600_000);
    const date = dateInTz(start, TZ);
    payDate = date;
    const hhmm = (d: Date) => attendance.localTime(d, TZ);
    await f.manager.attendance.shiftSave({
      storeId: f.storeId,
      memberId: f.staffId,
      date,
      start: hhmm(start),
      end: hhmm(end),
    });
    await f.manager.attendance.payRateSet({
      storeId: f.storeId,
      memberId: f.staffId,
      dailyWage: '100000',
      effectiveFrom: '2020-01-01',
    });
    // Clocked in 20 minutes late (the manager enters it).
    const lateIn = new Date(start.getTime() + 20 * 60_000);
    await f.manager.attendance.manualPunch({
      storeId: f.storeId,
      memberId: f.staffId,
      kind: 'in',
      date: dateInTz(lateIn, TZ),
      time: hhmm(lateIn),
      reason: 'phone was flat',
    });
    // Clocking out an hour after the end needs a reason …
    await expectError(
      clock(f.staff(), { kind: 'out', device: OTHER_DEVICE }),
      'attendance.errors.overtimeReasonRequired',
    );
    const out = await clock(f.staff(), {
      kind: 'out',
      device: OTHER_DEVICE,
      overtimeReason: 'Stocktake after closing',
    });
    expect(out.overtimeMinutes).toBeGreaterThanOrEqual(59);

    let sheet = await f.manager.attendance.sheet({ storeId: f.storeId, from: date, to: date });
    const ot = sheet.overtime.find((o) => o.punchId === out.id)!;
    expect(ot.status).toBe('pending');
    expect(ot.reason).toBe('Stocktake after closing');
    const day = sheet.days.find((d) => d.memberId === f.staffId && d.date === date)!;
    expect(day.lateMinutes).toBe(20);
    // 240 planned minutes, 20 late → 100000 × 20 / 240 = 8333.33
    expect(day.pay).toEqual({
      status: 'payable',
      wageCents: 10_000_000,
      deductionCents: 833_333,
      netCents: 9_166_667,
    });

    await f.manager.attendance.overtimeDecide({
      storeId: f.storeId,
      overtimeId: ot.id,
      approve: false,
      note: 'Stayed for dinner',
    });
    sheet = await f.manager.attendance.sheet({ storeId: f.storeId, from: date, to: date });
    expect(sheet.overtime.find((o) => o.id === ot.id)!.status).toBe('rejected');

    const wages = await f.manager.attendance.wageSuggestions({ storeId: f.storeId, date });
    expect(wages.find((w) => w.memberId === f.staffId)).toMatchObject({
      status: 'payable',
      amount: '91666.67',
      deduction: '8333.33',
      lateMinutes: 20,
    });
    await expectError(
      f.staff().attendance.wageSuggestions({ storeId: f.storeId, date }),
      'auth.errors.missingPermission',
    );
  });

  test('the month exports as an xlsx behind a signed link', async () => {
    const f = fx!;
    // The month of the pay test's shift. "This month" missed it on the
    // first of a month between midnight and 05:00 in Tashkent, when that
    // shift began the day before (review TEST1-08).
    const month = payDate.slice(0, 7);
    await expectError(
      f.staff().attendance.exportLink({ storeId: f.storeId, month, locale: 'en' }),
      'auth.errors.missingPermission',
    );
    const link = await f.manager.attendance.exportLink({ storeId: f.storeId, month, locale: 'zh' });
    expect(link.path).toStartWith('/files/attendance-month.xlsx?t=');
    expect(link.fileName).toEndWith(`-${month}.xlsx`);
    const http = new Hono().get('/files/attendance-month.xlsx', attendanceMonthExport);
    const res = await http.request(link.path);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('spreadsheetml');
    expect(res.headers.get('content-disposition')).toContain("filename*=UTF-8''");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]); // "PK"
    // Stored (uncompressed) zip: the sheet XML is readable as is.
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('每日明细');
    expect(text).toContain('91666.67');
    expect(text).toContain('Stocktake after closing');

    const bad = await http.request('/files/attendance-month.xlsx?t=nope');
    expect(bad.status).toBe(410);
  });

  test("an overnight clock-out and its overtime count for the shift's day, also when entered later", async () => {
    const f = fx!;
    // Ten days ago, entered by a manager now: the overtime row is created
    // today, its clock-out is ten days old.
    const day = attendance.nextDate(todayInTz(TZ, new Date()), -10);
    const nextDay = attendance.nextDate(day);
    await f.manager.attendance.shiftSave({
      storeId: f.storeId,
      memberId: f.staffId,
      date: day,
      start: '20:00',
      end: '23:00',
    });
    await f.manager.attendance.manualPunch({
      storeId: f.storeId,
      memberId: f.staffId,
      kind: 'in',
      date: day,
      time: '20:00',
      reason: 'Overnight test',
    });
    const out = await f.manager.attendance.manualPunch({
      storeId: f.storeId,
      memberId: f.staffId,
      kind: 'out',
      date: nextDay,
      time: '00:30',
      reason: 'Overnight test',
    });

    const sheet = await f.manager.attendance.sheet({ storeId: f.storeId, from: day, to: day });
    const punch = sheet.punches.find((p) => p.id === out.id)!;
    expect({ date: punch.date, day: punch.day }).toEqual({ date: nextDay, day });
    const row = sheet.days.find((d) => d.memberId === f.staffId && d.date === day)!;
    expect(row.punchIds).toContain(out.id);
    expect(row.workedMinutes).toBe(270);
    // It used to be in no sheet: loaded by when the record was made, and
    // dated by the clock-out's own day. A manager's entry approves it.
    expect(sheet.overtime.find((o) => o.punchId === out.id)).toMatchObject({
      date: day,
      minutes: 90,
      status: 'approved',
    });
    const next = await f.manager.attendance.sheet({
      storeId: f.storeId,
      from: nextDay,
      to: nextDay,
    });
    expect(next.overtime.find((o) => o.punchId === out.id)).toBeUndefined();

    // The month's file puts the clock-out and its overtime on that row.
    const link = await f.manager.attendance.exportLink({
      storeId: f.storeId,
      month: day.slice(0, 7),
      locale: 'en',
    });
    const http = new Hono().get('/files/attendance-month.xlsx', attendanceMonthExport);
    const text = new TextDecoder().decode(
      new Uint8Array(await (await http.request(link.path)).arrayBuffer()),
    );
    const daily = text.slice(text.lastIndexOf('<sheetData>'));
    const dayRow = [...daily.matchAll(/<row r="\d+">[\s\S]*?<\/row>/g)]
      .map((m) => m[0])
      .find((r) => r.includes(`>${day}<`) && r.includes('00:30'));
    expect(dayRow).toBeDefined();
    expect(dayRow).toContain(`00:30 (${nextDay}) (manual)`);
    expect(dayRow).toContain('>90<');
  });
});

describe.skipIf(!SHOULD_RUN)('attendance photos', () => {
  test('the face only, no place photo (2026-11-07); managers see it; 90 days', async () => {
    const f = fx!;
    const db = getDb(undefined, { system: 'maintenance' });
    await resetPunches(f.staffId);
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

    await f.manager.attendance.policySave({ ...rules, requireDevice: true });
    await resetPunches(f.staffId);
  });
});

describe.skipIf(!SHOULD_RUN)('attendance face enrollment', () => {
  test('six checked photos, approved by a manager; only that face clocks', async () => {
    const f = fx!;
    const db = getDb(undefined, { system: 'maintenance' });
    await resetPunches(f.staffId);
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
    let refused: unknown = null;
    try {
      await enroll({ up: 'Ali:up:dark', left: 'Ali:flat' });
    } catch (e) {
      refused = e;
    }
    expect(
      (refused as { cause?: { context?: { problems?: string } } }).cause?.context?.problems,
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

    const told = await db
      .select({ to: s.notifications.recipientUserId, template: s.notifications.template })
      .from(s.notifications)
      .where(and(eq(s.notifications.orgId, f.orgId), eq(s.notifications.channel, 'bot')));
    const to = (template: string) => [
      ...new Set(told.filter((r) => r.template === template).map((r) => r.to)),
    ];
    expect(to('attendance.faceEnrollPending')).toEqual([f.managerUserId]);
    expect(to('attendance.faceEnrollRejected')).toEqual([f.staffUserId]);
    expect(to('attendance.faceEnrollApproved')).toEqual([f.staffUserId]);
    await resetPunches(f.staffId);
  });
});

describe.skipIf(!SHOULD_RUN)('attendance liveness and borrowed phones', () => {
  test('turns and a real face pass; prints, flat turns and reused challenges do not', async () => {
    const f = fx!;
    const db = getDb(undefined, { system: 'maintenance' });
    await resetPunches(f.staffId, f.colleagueId);
    await f.manager.attendance.memberSet({
      storeId: f.storeId,
      memberId: f.colleagueId,
      enabled: true,
    });
    const rules = {
      storeId: f.storeId,
      requireDevice: false,
      requireGeo: false,
      geo: null,
      graceMinutes: 5,
      overtimeAfterMinutes: 30,
    };
    await f.manager.attendance.policySave(rules);
    // The pay test's shift ended earlier today: a clock-out is overtime.
    const why = 'liveness test';

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
      clock(f.staff(), { kind: 'out', token: challenge.token, overtimeReason: why }),
      'attendance.errors.livenessExpired',
    );
    // Another member's challenge does not fit.
    const theirs = await f.colleague().attendance.livenessChallenge({
      storeId: f.storeId,
      force: true,
    });
    await expectError(
      clock(f.staff(), { kind: 'out', token: theirs.token, overtimeReason: why }),
      'attendance.errors.livenessExpired',
    );
    // Face only: a failed check is refused, never recorded.
    for (const [left, right] of [
      ['Ali:print', 'Ali:print'],
      ['Ali:flat', 'Ali:flat'],
      ['Bob:left', 'Bob:right'],
    ] as const) {
      await expectError(
        clock(f.staff(), { kind: 'out', left, right, overtimeReason: why }),
        'attendance.errors.livenessFailed',
      );
    }
    const date = dateInTz(new Date(first.at), TZ);
    let sheet = await f.manager.attendance.sheet({ storeId: f.storeId, from: date, to: date });
    expect(
      sheet.punches.filter((p) => p.memberId === f.staffId && !p.voided).map((p) => p.id),
    ).toEqual([first.id]);

    // A borrowed phone: Bob (the colleague) clocks on Ali's (staff's) phone.
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
    sheet = await f.manager.attendance.sheet({ storeId: f.storeId, from: date, to: date });
    const row = sheet.punches.find((p) => p.id === borrowed.id)!;
    expect([row.memberId, row.viaName]).toEqual([f.colleagueId, 'Att Staff']);
    expect([...row.photos].sort()).toEqual(['face', 'left', 'right']);

    // One face photo, plainly real: no turns (the server did not ask).
    const passive = await clock(f.staff(), {
      kind: 'out',
      token: await passiveToken(f.staffId),
      overtimeReason: why,
    });
    expect([passive.liveness, passive.face]).toEqual(['passive', 'match']);
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

    // 待核对: the flagged punches, until a manager lets one stand.
    let queue = await f.manager.attendance.reviewQueue({ storeId: f.storeId });
    expect(queue.punches.map((p) => p.id)).toContain(borrowed.id);
    expect(queue.punches.map((p) => p.id)).not.toContain(passive.id);
    await expectError(
      f.staff().attendance.reviewQueue({ storeId: f.storeId }),
      'auth.errors.missingPermission',
    );
    await f.manager.attendance.reviewPunch({ storeId: f.storeId, punchId: borrowed.id });
    queue = await f.manager.attendance.reviewQueue({ storeId: f.storeId });
    expect(queue.punches.map((p) => p.id)).not.toContain(borrowed.id);

    // A new phone: the turns first, then it clocks, flagged.
    await f.manager.attendance.policySave({ ...rules, requireDevice: true });
    await expectError(
      clock(f.staff(), { device: DEVICE, token: await passiveToken(f.staffId) }),
      'attendance.errors.livenessNeeded',
    );
    const moved = await clock(f.staff(), { device: DEVICE });
    expect([moved.newDevice, moved.face]).toEqual([true, 'match']);

    const told = await db
      .select({ to: s.notifications.recipientUserId, template: s.notifications.template })
      .from(s.notifications)
      .where(and(eq(s.notifications.orgId, f.orgId), eq(s.notifications.channel, 'bot')));
    const to = (template: string) => told.filter((r) => r.template === template).map((r) => r.to);
    expect(to('attendance.borrowedPhone')).toEqual([f.managerUserId]);
    expect(to('attendance.clockedInForYou')).toEqual([f.colleagueUserId]);
    expect(to('attendance.newDevice')).toEqual([f.managerUserId]);
    expect(to('attendance.livenessFailed')).toEqual([]);

    // Withdrawing the consent deletes the enrolled face.
    await f.colleague().attendance.faceConsentWithdraw();
    expect(
      await db
        .select()
        .from(s.attendanceFaceEnrollments)
        .where(eq(s.attendanceFaceEnrollments.memberId, f.colleagueId)),
    ).toEqual([]);

    await resetPunches(f.staffId, f.colleagueId);
    await f.manager.attendance.memberSet({
      storeId: f.storeId,
      memberId: f.colleagueId,
      enabled: false,
    });
  });
});

describe.skipIf(!SHOULD_RUN)('attendance blink and open mouth (2026-11-07)', () => {
  test('every punch: both movements, real, the same person, not a copy', async () => {
    const f = fx!;
    await resetPunches(f.staffId);
    await f.manager.attendance.policySave({
      storeId: f.storeId,
      requireDevice: false,
      requireGeo: false,
      geo: null,
      graceMinutes: 5,
      overtimeAfterMinutes: 30,
    });
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
    let refused: unknown = null;
    try {
      await clock(f.staff(), { token: await token(), blink: 'Ali:front', mouth: 'Cat:mouth' });
    } catch (e) {
      refused = e;
    }
    // Either order: the server picks the order of the movements.
    expect(
      (refused as { cause?: { context?: { failures?: string } } }).cause?.context?.failures
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
      overtimeReason: 'blink test',
    });
    expect(out.kind).toBe('out');
    await resetPunches(f.staffId);
  });
});

describe.skipIf(!SHOULD_RUN)('attendance review fixes (2026-11-07)', () => {
  const rules = (storeId: string) => ({
    storeId,
    requireDevice: false,
    requireGeo: false,
    geo: null,
    graceMinutes: 5,
    overtimeAfterMinutes: 30,
  });
  const turns = async () =>
    (await fx!.staff().attendance.livenessChallenge({ storeId: fx!.storeId, force: true })).token;

  test('a printed straight frame does not pass on the strength of live movements', async () => {
    const f = fx!;
    await resetPunches(f.staffId);
    await f.manager.attendance.policySave(rules(f.storeId));
    // Mean real-face over the frames was 0.65 and went through.
    await expectError(
      clock(f.staff(), { token: await turns(), face: 'Ali:front:print' }),
      'attendance.errors.livenessFailed',
    );
  });

  test('the movements must be the enrolled person, not someone like the photo', async () => {
    const f = fx!;
    let refused: unknown = null;
    try {
      await clock(f.staff(), {
        token: await turns(),
        face: 'Ali:front:half',
        blink: 'Dan:blink',
        mouth: 'Dan:mouth',
        left: 'Dan:left',
        right: 'Dan:right',
      });
    } catch (e) {
      refused = e;
    }
    expect((refused as Error | null)?.message).toBe('attendance.errors.livenessFailed');
    expect((refused as { cause?: { context?: unknown } }).cause?.context).toEqual({
      failures: 'otherPerson',
    });
  });

  test('pictures sent before are refused: an earlier punch, an enrollment photo', async () => {
    const f = fx!;
    await resetPunches(f.staffId);
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
    const out = await clock(f.staff(), {
      kind: 'out',
      token: await passiveToken(f.staffId),
      overtimeReason: 'review test',
    });
    expect(out.kind).toBe('out');
    await resetPunches(f.staffId);
  });

  test("a colleague's face only somewhat like them is not enough to clock them", async () => {
    const f = fx!;
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
  });

  test('a manager does not change their own attendance or wage; a super admin does', async () => {
    const f = fx!;
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

  test('withdrawing face consent works in a read-only workspace', async () => {
    const f = fx!;
    const readOnly = appRouter.createCaller(
      buildCtx({
        userId: f.colleagueUserId,
        memberId: f.colleagueId,
        orgId: f.orgId,
        orgTimezone: TZ,
        writeAccess: false,
        permissions: new Set(['attendance.clock']),
        roleSlugs: new Set(),
      }),
    );
    await expectError(
      readOnly.attendance.faceConsentGive({ version: 1 }),
      'subscription.errors.readOnly',
    );
    await readOnly.attendance.faceConsentWithdraw();
    const me = await f.colleague().attendance.me({});
    expect(me.faceConsent).toBeNull();
    expect(me.face?.status ?? 'none').toBe('none');
  });

  test('a member with attendance is suspended, not removed; the records stay', async () => {
    const f = fx!;
    const admin = appRouter.createCaller(
      buildCtx({
        userId: f.managerUserId,
        memberId: f.managerId,
        orgId: f.orgId,
        orgTimezone: TZ,
        writeAccess: true,
        permissions: new Set(['org.admin', 'users.manage', 'attendance.manage']),
        roleSlugs: new Set(),
      }),
    );
    await expectError(
      admin.admin.memberRemove({ memberId: f.staffId }),
      'admin.errors.memberHasAttendance',
    );
    const db = getDb(undefined, { system: 'maintenance' });
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

/** A refused call's key and the placeholders it sent. */
async function refusal(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    const err = e as { message?: string; cause?: { context?: Record<string, unknown> } };
    return { message: err.message ?? null, context: err.cause?.context ?? null };
  }
  return { message: null, context: null };
}

describe.skipIf(!SHOULD_RUN)('attendance straight-on punch (2026-11-07)', () => {
  test('the challenge says when a clock-out will need a reason', async () => {
    const f = fx!;
    await resetPunches(f.staffId);
    await f.manager.attendance.policySave({
      storeId: f.storeId,
      requireDevice: false,
      requireGeo: false,
      geo: null,
      graceMinutes: 5,
      overtimeAfterMinutes: 30,
    });
    // Next is a clock-in: nothing to ask.
    const toIn = await f.staff().attendance.livenessChallenge({ storeId: f.storeId });
    expect(toIn.overtimeMinutes).toBe(0);
    // Clocked in at the start of the shift that ended an hour ago (the pay test's).
    const start = new Date(Date.now() - 5 * 3600_000);
    await f.manager.attendance.manualPunch({
      storeId: f.storeId,
      memberId: f.staffId,
      kind: 'in',
      date: dateInTz(start, TZ),
      time: attendance.localTime(start, TZ),
      reason: 'test',
    });
    const toOut = await f.staff().attendance.livenessChallenge({ storeId: f.storeId });
    expect(toOut.overtimeMinutes).toBeGreaterThanOrEqual(59);
    // A colleague's is known only once their face is.
    const colleague = await f.staff().attendance.livenessChallenge({
      storeId: f.storeId,
      identify: true,
    });
    expect(colleague.overtimeMinutes).toBe(0);
    await resetPunches(f.staffId);
  });

  test('a colleague: named in the overtime question, not clocked twice, "not them" for two minutes', async () => {
    const f = fx!;
    const db = getDb(undefined, { system: 'maintenance' });
    await resetPunches(f.staffId, f.colleagueId);
    await f.manager.attendance.memberSet({
      storeId: f.storeId,
      memberId: f.colleagueId,
      enabled: true,
    });
    await enrollApproved(f.colleague(), 'Bob');
    // Bob's shift ended an hour ago; he clocked in at its start.
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

    // On Ali's phone, Bob's clock-out past the shift: the question says whose.
    const asked = await refusal(clock(f.staff(), { who: 'Bob', identify: true }));
    expect(asked.message).toBe('attendance.errors.overtimeReasonRequired');
    expect(asked.context?.name).toBe('Att Colleague');
    expect(Number(asked.context?.minutes)).toBeGreaterThanOrEqual(59);
    const out = await clock(f.staff(), { who: 'Bob', identify: true, overtimeReason: 'stocktake' });
    expect([out.kind, out.forName]).toEqual(['out', 'Att Colleague']);

    // Found again within two minutes, on any phone: the same punch, not his next.
    const again = await refusal(
      clock(f.staff(), { who: 'Bob', identify: true, overtimeReason: 'stocktake' }),
    );
    expect(again.message).toBe('attendance.errors.justPunched');
    expect(again.context).toMatchObject({ lastKind: 'out', name: 'Att Colleague' });
    expect(String(again.context?.time)).toMatch(/^\d{2}:\d{2}$/);
    // On his own phone the kind is his to say; the refusal says when he did.
    const own = await refusal(clock(f.colleague(), { who: 'Bob', kind: 'out', device: DEVICE }));
    expect(own.message).toBe('attendance.errors.notClockedIn');
    expect(own.context?.lastKind).toBe('out');

    // "Not them": only the phone that made it, only once.
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
    const date = dateInTz(new Date(out.at), TZ);
    const sheet = await f.manager.attendance.sheet({ storeId: f.storeId, from: date, to: date });
    const row = sheet.punches.find((p) => p.id === out.id)!;
    expect([row.voided?.reason, row.voided?.byName]).toEqual([
      'attendance.voidReason.wrongPerson',
      'Att Staff',
    ]);
    // Its overtime is no longer waiting for anyone.
    expect(sheet.overtime.filter((o) => o.punchId === out.id && o.status === 'pending')).toEqual(
      [],
    );
    const told = await db
      .select({ to: s.notifications.recipientUserId, template: s.notifications.template })
      .from(s.notifications)
      .where(and(eq(s.notifications.orgId, f.orgId), eq(s.notifications.channel, 'bot')));
    const to = (template: string) => told.filter((r) => r.template === template).map((r) => r.to);
    expect(to('attendance.punchUndone')).toEqual([f.managerUserId]);
    expect(to('attendance.punchUndoneForYou')).toEqual([f.colleagueUserId]);

    // Taken back, the right face clocks: the voided punch holds nothing up.
    const right = await clock(f.staff(), {
      who: 'Bob',
      identify: true,
      overtimeReason: 'stocktake',
    });
    expect(right.kind).toBe('out');

    // After two minutes it is the manager's to void.
    const [old] = await db
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

    await resetPunches(f.staffId, f.colleagueId);
    await f.colleague().attendance.faceConsentWithdraw();
    await f.manager.attendance.memberSet({
      storeId: f.storeId,
      memberId: f.colleagueId,
      enabled: false,
    });
  });
});

describe.skipIf(!SHOULD_RUN)('attendance reminders', () => {
  test('missed clock-in reminds the person, then the managers, once each', async () => {
    const f = fx!;
    const db = getDb(undefined, { system: 'maintenance' });
    const now = new Date();
    // A shift that began 40 minutes ago, after every punch the other tests made.
    await db.insert(s.attendanceShifts).values({
      orgId: f.orgId,
      storeId: f.storeId,
      memberId: f.staffId,
      shiftDate: todayInTz(TZ, now),
      startsAt: new Date(now.getTime() - 40 * 60_000),
      endsAt: new Date(now.getTime() + 4 * 3600_000),
    });
    await db.execute(
      sql`UPDATE inventory.attendance_punches SET voided_at = now(), voided_by_member_id = member_id, void_reason = 'test reset' WHERE member_id = ${f.staffId} AND voided_at IS NULL`,
    );
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
