import { beforeAll, describe, expect, test } from 'bun:test';
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
import { purgeOldAttendancePhotos } from '../services/attendancePhotoRetention';
import { setFaceEngineForTests } from '../services/face';
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

interface Fixture {
  orgId: string;
  storeId: string;
  otherStoreId: string;
  staffId: string;
  staffUserId: string;
  managerUserId: string;
  outsiderId: string;
  colleagueId: string;
  colleagueUserId: string;
  colleague: () => ReturnType<typeof appRouter.createCaller>;
  manager: ReturnType<typeof appRouter.createCaller>;
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

async function expectError(p: Promise<unknown>, message: string) {
  let err: unknown = null;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect((err as Error | null)?.message).toBe(message);
}

beforeAll(async () => {
  if (!SHOULD_RUN) return;
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
    managerUserId: mgr.userId,
    outsiderId: outsider.memberId,
    colleagueId: colleague.memberId,
    colleagueUserId: colleague.userId,
    colleague: () => appRouter.createCaller(buildCtx(session(colleague, ['attendance.clock']))),
    manager: appRouter.createCaller(buildCtx(session(mgr, ['attendance.manage']))),
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
    const first = await f
      .staff()
      .attendance.punch({ storeId: f.storeId, kind: 'in', deviceId: DEVICE });
    expect(first.kind).toBe('in');
    await expectError(
      f.staff().attendance.punch({ storeId: f.storeId, kind: 'in', deviceId: DEVICE }),
      'attendance.errors.alreadyClockedIn',
    );
    await expectError(
      f.staff().attendance.punch({ storeId: f.storeId, kind: 'out', deviceId: OTHER_DEVICE }),
      'attendance.errors.otherDevice',
    );
    expect((await f.staff().attendance.me({ deviceId: OTHER_DEVICE })).device).toEqual({
      bound: true,
      matches: false,
    });
    await f.staff().attendance.punch({ storeId: f.storeId, kind: 'out', deviceId: DEVICE });
    await expectError(
      f.staff().attendance.punch({ storeId: f.storeId, kind: 'out', deviceId: DEVICE }),
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
      f
        .staff()
        .attendance.punch({ storeId: f.storeId, kind: 'in', deviceId: OTHER_DEVICE, location });
    await expectError(punch(null), 'attendance.errors.locationRequired');
    await expectError(punch({ ...SHOP, accuracy: 900 }), 'attendance.errors.locationInaccurate');
    await expectError(
      punch({ lat: SHOP.lat + 0.01, lng: SHOP.lng, accuracy: 10 }),
      'attendance.errors.outsideArea',
    );
    const ok = await punch({ lat: SHOP.lat + 0.0005, lng: SHOP.lng, accuracy: 15 });
    expect(ok.kind).toBe('in');
    await f.staff().attendance.punch({
      storeId: f.storeId,
      kind: 'out',
      deviceId: OTHER_DEVICE,
      location: { ...SHOP, accuracy: 5 },
    });
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
      f.staff().attendance.punch({ storeId: f.storeId, kind: 'out', deviceId: OTHER_DEVICE }),
      'attendance.errors.overtimeReasonRequired',
    );
    const out = await f.staff().attendance.punch({
      storeId: f.storeId,
      kind: 'out',
      deviceId: OTHER_DEVICE,
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
    const month = todayInTz(TZ, new Date()).slice(0, 7);
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
});

describe.skipIf(!SHOULD_RUN)('attendance photos', () => {
  test('a store can ask for a face and a place photo; managers see them; 90 days', async () => {
    const f = fx!;
    const db = getDb(undefined, { system: 'maintenance' });
    await db.execute(
      sql`UPDATE inventory.attendance_punches SET voided_at = now(), voided_by_member_id = member_id, void_reason = 'test reset' WHERE member_id = ${f.staffId} AND voided_at IS NULL`,
    );
    const rules = {
      storeId: f.storeId,
      requireDevice: false,
      requireGeo: false,
      geo: null,
      graceMinutes: 5,
      overtimeAfterMinutes: 30,
    };
    await f.manager.attendance.policySave({ ...rules, requirePhoto: true });
    expect((await f.staff().attendance.me({})).stores[0]!.rules.requirePhoto).toBe(true);
    const punch = { storeId: f.storeId, kind: 'in' as const, deviceId: OTHER_DEVICE };
    await expectError(f.staff().attendance.punch(punch), 'attendance.errors.photoRequired');
    const notJpeg = Buffer.from('not a photo at all').toString('base64');
    await expectError(
      f.staff().attendance.punch({ ...punch, photos: { face: notJpeg, scene: notJpeg } }),
      'attendance.errors.photoInvalid',
    );
    const jpeg = (tag: string) =>
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag)]).toString('base64');
    const done = await f.staff().attendance.punch({
      ...punch,
      photos: { face: jpeg('face'), scene: jpeg('scene') },
    });

    const date = dateInTz(new Date(done.at), TZ);
    const sheet = await f.manager.attendance.sheet({ storeId: f.storeId, from: date, to: date });
    expect(sheet.punches.find((p) => p.id === done.id)!.photos.sort()).toEqual(['face', 'scene']);
    const photos = await f.manager.attendance.punchPhotos({ storeId: f.storeId, punchId: done.id });
    expect(photos.map((p) => p.kind)).toEqual(['face', 'scene']);
    expect(photos[0]!.src).toBe(`data:image/jpeg;base64,${jpeg('face')}`);
    await expectError(
      f.staff().attendance.punchPhotos({ storeId: f.storeId, punchId: done.id }),
      'auth.errors.missingPermission',
    );

    // Kept 90 days.
    expect(await purgeOldAttendancePhotos(db)).toBe(0);
    await db.execute(
      sql`UPDATE inventory.attendance_photos SET taken_at = now() - interval '91 days' WHERE punch_id = ${done.id}`,
    );
    expect(await purgeOldAttendancePhotos(db)).toBe(2);
    expect(
      await f.manager.attendance.punchPhotos({ storeId: f.storeId, punchId: done.id }),
    ).toEqual([]);

    await f.manager.attendance.policySave({ ...rules, requireDevice: true, requirePhoto: false });
  });
});

describe.skipIf(!SHOULD_RUN)('attendance face check', () => {
  test('first face registers; later ones match or are flagged; managers are told', async () => {
    const f = fx!;
    const db = getDb(undefined, { system: 'maintenance' });
    const reset = () =>
      db.execute(
        sql`UPDATE inventory.attendance_punches SET voided_at = now(), voided_by_member_id = member_id, void_reason = 'test reset' WHERE member_id = ${f.staffId} AND voided_at IS NULL`,
      );
    await reset();
    // A stub model: the photo's text says whose face it is.
    const unit = (i: number) => Array.from({ length: 128 }, (_, j) => (j === i ? 1 : 0));
    setFaceEngineForTests(async (bytes) => {
      const tag = Buffer.from(bytes).toString('latin1');
      if (tag.includes('nobody')) return { found: false };
      if (tag.includes('boom')) throw new Error('model down');
      return {
        found: true,
        score: 0.95,
        feature: unit(tag.includes('Bob') ? 1 : 0),
        yaw: 0,
        real: 0.9,
      };
    });
    const rules = {
      storeId: f.storeId,
      requireDevice: false,
      requireGeo: false,
      geo: null,
      graceMinutes: 5,
      overtimeAfterMinutes: 30,
      requirePhoto: true,
    };
    await f.manager.attendance.policySave({ ...rules, requireFace: true });
    const jpeg = (tag: string) =>
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag)]).toString('base64');
    const punch = (kind: 'in' | 'out', who: string) =>
      f.staff().attendance.punch({
        storeId: f.storeId,
        kind,
        deviceId: OTHER_DEVICE,
        photos: { face: jpeg(who), scene: jpeg('shop') },
        // The pay test's shift ended earlier today: a clock-out is overtime.
        overtimeReason: kind === 'out' ? 'face test' : undefined,
      });

    await expectError(punch('in', 'nobody'), 'attendance.errors.faceNotFound');
    expect((await punch('in', 'Ali')).face).toBe('enrolled');
    expect((await punch('out', 'Ali')).face).toBe('match');
    const bob = await punch('in', 'Bob');
    expect(bob.face).toBe('mismatch');

    const date = dateInTz(new Date(bob.at), TZ);
    let sheet = await f.manager.attendance.sheet({ storeId: f.storeId, from: date, to: date });
    expect(sheet.requireFace).toBe(true);
    expect(sheet.punches.find((p) => p.id === bob.id)!.face).toEqual({
      result: 'mismatch',
      score: 0,
    });
    expect(sheet.members.find((m) => m.memberId === f.staffId)!.faceRefAt).not.toBeNull();
    const told = await db
      .select({ to: s.notifications.recipientUserId })
      .from(s.notifications)
      .where(
        and(
          eq(s.notifications.orgId, f.orgId),
          eq(s.notifications.template, 'attendance.faceMismatch'),
          eq(s.notifications.channel, 'bot'),
        ),
      );
    expect(told.map((r) => r.to)).toEqual([f.managerUserId]);

    // The manager decides Bob's photo is the right face after all.
    await f.manager.attendance.faceRefSet({ storeId: f.storeId, punchId: bob.id });
    expect((await punch('out', 'Bob')).face).toBe('match');
    expect(
      (await f.manager.attendance.faceRef({ storeId: f.storeId, memberId: f.staffId }))!.src,
    ).toBe(`data:image/jpeg;base64,${jpeg('Bob')}`);

    // The model being down never stops a punch; it is marked unchecked.
    expect((await punch('in', 'boom')).face).toBe('unchecked');

    await expectError(
      f.staff().attendance.faceRefClear({ storeId: f.storeId, memberId: f.staffId }),
      'auth.errors.missingPermission',
    );
    await f.manager.attendance.faceRefClear({ storeId: f.storeId, memberId: f.staffId });
    expect(await f.manager.attendance.faceRef({ storeId: f.storeId, memberId: f.staffId })).toBe(
      null,
    );
    sheet = await f.manager.attendance.sheet({ storeId: f.storeId, from: date, to: date });
    expect(sheet.members.find((m) => m.memberId === f.staffId)!.faceRefAt).toBeNull();

    setFaceEngineForTests(null);
    await reset();
    await f.manager.attendance.policySave({
      ...rules,
      requireDevice: true,
      requirePhoto: false,
      requireFace: false,
    });
  });
});

describe.skipIf(!SHOULD_RUN)('attendance liveness and borrowed phones', () => {
  test('turns and a real face pass; prints, flat turns and reused challenges do not', async () => {
    const f = fx!;
    const db = getDb(undefined, { system: 'maintenance' });
    const reset = () =>
      db.execute(
        sql`UPDATE inventory.attendance_punches SET voided_at = now(), voided_by_member_id = member_id, void_reason = 'test reset' WHERE member_id IN (${f.staffId}, ${f.colleagueId}) AND voided_at IS NULL`,
      );
    await reset();
    await db.delete(s.attendanceFaceRefs).where(eq(s.attendanceFaceRefs.orgId, f.orgId));
    await f.manager.attendance.memberSet({
      storeId: f.storeId,
      memberId: f.colleagueId,
      enabled: true,
    });
    // Stub model. Tag "<who>:<pose>": Ali or Bob; front, left, right, print
    // (a photo held up: real-face score low), flat (no head turn).
    const unit = (i: number) => Array.from({ length: 128 }, (_, j) => (j === i ? 1 : 0));
    setFaceEngineForTests(async (bytes) => {
      const tag = Buffer.from(bytes).toString('latin1');
      const yaw = tag.includes(':left') ? 0.5 : tag.includes(':right') ? -0.5 : 0;
      return {
        found: true,
        score: 0.95,
        feature: unit(tag.includes('Bob') ? 1 : 0),
        yaw,
        real: tag.includes('print') ? 0.05 : 0.95,
      };
    });
    const rules = {
      storeId: f.storeId,
      requireDevice: false,
      requireGeo: false,
      geo: null,
      graceMinutes: 5,
      overtimeAfterMinutes: 30,
      requirePhoto: true,
      requireFace: true,
    };
    await f.manager.attendance.policySave({ ...rules, requireLiveness: true });
    const jpeg = (tag: string) =>
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag)]).toString('base64');
    type Caller = ReturnType<typeof appRouter.createCaller>;
    const punch = async (
      caller: Caller,
      kind: 'in' | 'out',
      who: string,
      opts: {
        left?: string;
        right?: string;
        forMemberId?: string;
        token?: string;
        accept?: boolean;
        device?: string;
      } = {},
    ) => {
      const token =
        opts.token ??
        (
          await caller.attendance.livenessChallenge({
            storeId: f.storeId,
            forMemberId: opts.forMemberId,
          })
        ).token;
      return caller.attendance.punch({
        storeId: f.storeId,
        kind,
        deviceId: opts.device ?? OTHER_DEVICE,
        photos: { face: jpeg(`${who}:front`), scene: jpeg('shop') },
        liveness: {
          token,
          left: jpeg(opts.left ?? `${who}:left`),
          right: jpeg(opts.right ?? `${who}:right`),
        },
        acceptLivenessFail: opts.accept,
        forMemberId: opts.forMemberId,
        overtimeReason: kind === 'out' ? 'liveness test' : undefined,
      });
    };

    await expectError(
      f.staff().attendance.punch({
        storeId: f.storeId,
        kind: 'in',
        deviceId: OTHER_DEVICE,
        photos: { face: jpeg('Ali:front'), scene: jpeg('shop') },
      }),
      'attendance.errors.livenessRequired',
    );
    const challenge = await f.staff().attendance.livenessChallenge({ storeId: f.storeId });
    expect([...challenge.steps].sort()).toEqual(['left', 'right']);
    const first = await punch(f.staff(), 'in', 'Ali', { token: challenge.token });
    expect([first.liveness, first.face]).toEqual(['pass', 'enrolled']);
    // One challenge, one punch.
    await expectError(
      punch(f.staff(), 'out', 'Ali', { token: challenge.token }),
      'attendance.errors.livenessExpired',
    );
    // Another member's challenge does not fit.
    const theirs = await f.colleague().attendance.livenessChallenge({ storeId: f.storeId });
    await expectError(
      punch(f.staff(), 'out', 'Ali', { token: theirs.token }),
      'attendance.errors.livenessExpired',
    );
    await expectError(
      punch(f.staff(), 'out', 'Ali', { left: 'Ali:print', right: 'Ali:print' }),
      'attendance.errors.livenessFailed',
    );
    await expectError(
      punch(f.staff(), 'out', 'Ali', { left: 'Ali:flat', right: 'Ali:flat' }),
      'attendance.errors.livenessFailed',
    );
    await expectError(
      punch(f.staff(), 'out', 'Ali', { left: 'Bob:left', right: 'Bob:right' }),
      'attendance.errors.livenessFailed',
    );
    // After two tries the person clocks anyway, flagged.
    const flagged = await punch(f.staff(), 'out', 'Ali', {
      left: 'Ali:flat',
      right: 'Ali:flat',
      accept: true,
    });
    expect(flagged.liveness).toBe('fail');
    const date = dateInTz(new Date(flagged.at), TZ);
    let sheet = await f.manager.attendance.sheet({ storeId: f.storeId, from: date, to: date });
    expect(sheet.requireLiveness).toBe(true);
    const flaggedRow = sheet.punches.find((p) => p.id === flagged.id)!;
    expect([flaggedRow.liveness, flaggedRow.face?.result]).toEqual(['fail', 'unchecked']);
    expect([...flaggedRow.photos].sort()).toEqual(['face', 'left', 'right', 'scene']);

    // A borrowed phone: Bob (the colleague) clocks on Ali's (staff's) phone.
    await expectError(
      f.staff().attendance.livenessChallenge({ storeId: f.storeId, forMemberId: f.outsiderId }),
      'attendance.errors.notColleague',
    );
    let list = await f.staff().attendance.colleagues({ storeId: f.storeId });
    expect(list.members.map((m) => [m.memberId, m.faceOnFile])).toEqual([[f.colleagueId, false]]);
    await expectError(
      punch(f.staff(), 'in', 'Bob', { forMemberId: f.colleagueId }),
      'attendance.errors.borrowNoFace',
    );
    // Bob registers his face on his own phone first.
    const own = await punch(f.colleague(), 'in', 'Bob', { device: DEVICE });
    expect(own.face).toBe('enrolled');
    list = await f.staff().attendance.colleagues({ storeId: f.storeId });
    expect(list.members[0]!.faceOnFile).toBe(true);
    // Ali cannot clock Bob out with Ali's own face, nor without a live check.
    await expectError(
      punch(f.staff(), 'out', 'Ali', { forMemberId: f.colleagueId }),
      'attendance.errors.borrowFaceMismatch',
    );
    await expectError(
      punch(f.staff(), 'out', 'Bob', {
        forMemberId: f.colleagueId,
        left: 'Bob:print',
        right: 'Bob:print',
        accept: true,
      }),
      'attendance.errors.livenessFailed',
    );
    const borrowed = await punch(f.staff(), 'out', 'Bob', { forMemberId: f.colleagueId });
    expect([borrowed.face, borrowed.liveness]).toEqual(['match', 'pass']);
    sheet = await f.manager.attendance.sheet({ storeId: f.storeId, from: date, to: date });
    const row = sheet.punches.find((p) => p.id === borrowed.id)!;
    expect([row.memberId, row.viaName]).toEqual([f.colleagueId, 'Att Staff']);

    // A new phone: refused without the face check, let through with it.
    await f.manager.attendance.policySave({ ...rules, requireDevice: true, requireLiveness: true });
    await expectError(
      punch(f.staff(), 'in', 'Ali', { device: DEVICE, left: 'Ali:flat', accept: true }),
      'attendance.errors.otherDevice',
    );
    const moved = await punch(f.staff(), 'in', 'Ali', { device: DEVICE });
    expect([moved.newDevice, moved.face]).toEqual([true, 'match']);

    const told = await db
      .select({ to: s.notifications.recipientUserId, template: s.notifications.template })
      .from(s.notifications)
      .where(and(eq(s.notifications.orgId, f.orgId), eq(s.notifications.channel, 'bot')));
    const to = (template: string) => told.filter((r) => r.template === template).map((r) => r.to);
    expect(to('attendance.livenessFailed')).toEqual([f.managerUserId]);
    expect(to('attendance.borrowedPhone')).toEqual([f.managerUserId]);
    expect(to('attendance.clockedOutForYou')).toEqual([f.colleagueUserId]);
    expect(to('attendance.newDevice')).toEqual([f.managerUserId]);

    setFaceEngineForTests(null);
    await reset();
    await f.manager.attendance.memberSet({
      storeId: f.storeId,
      memberId: f.colleagueId,
      enabled: false,
    });
    await f.manager.attendance.policySave({
      ...rules,
      requireDevice: true,
      requirePhoto: false,
      requireFace: false,
      requireLiveness: false,
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
