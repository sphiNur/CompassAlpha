import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { getDb, schema as s, withOrgContext } from '@compass/db';
import { todayInTz } from '@compass/domain';
import { loadCatalog } from '@compass/i18n/catalogs';
import { logger } from '../infra/log';
import { appRouter } from '../trpc/router';
import type { RequestContext, SessionContext } from '../trpc/context';
import { ipAllowed, parseIpRule } from '../trpc/routers/attendance';

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

describe('store network rules', () => {
  test('addresses and ranges', () => {
    expect(parseIpRule('203.0.113.7')).toEqual({
      address: '203.0.113.7',
      prefix: null,
      family: 'ipv4',
    });
    expect(parseIpRule('203.0.113.0/24')?.prefix).toBe(24);
    expect(parseIpRule('203.0.113.0/4')).toBeNull(); // too wide
    expect(parseIpRule('wifi-name')).toBeNull();
    expect(parseIpRule('1.2.3.4/24/1')).toBeNull();
    expect(ipAllowed('203.0.113.9', ['203.0.113.0/24'])).toBe(true);
    expect(ipAllowed('203.0.114.9', ['203.0.113.0/24'])).toBe(false);
    expect(ipAllowed('2001:db8:1::5', ['2001:db8:1::/48'])).toBe(true);
    expect(ipAllowed(null, ['203.0.113.0/24'])).toBe(false);
    expect(ipAllowed('203.0.113.9', [])).toBe(false);
  });

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
  outsiderId: string;
  manager: ReturnType<typeof appRouter.createCaller>;
  staff: (ip?: string | null) => ReturnType<typeof appRouter.createCaller>;
}
let fx: Fixture | null = null;

function buildCtx(session: SessionContext, trustedIp: string | null = null): RequestContext {
  const db = getDb(undefined, { system: 'maintenance' });
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hono: {} as any,
    db,
    log: logger,
    traceId: `attendance-test-${Date.now()}`,
    ip: null,
    trustedIp,
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
  ]);
  await db.insert(s.memberStoreAssignments).values([
    { memberId: mgr.memberId, storeId: store!.id },
    { memberId: staff.memberId, storeId: store!.id },
    { memberId: outsider.memberId, storeId: other!.id },
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
    outsiderId: outsider.memberId,
    manager: appRouter.createCaller(buildCtx(session(mgr, ['attendance.manage']))),
    staff: (ip = null) =>
      appRouter.createCaller(buildCtx(session(staff, ['attendance.clock']), ip)),
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

  test('location and store network rules', async () => {
    const f = fx!;
    const base = {
      storeId: f.storeId,
      requireDevice: true,
      requireGeo: true,
      geo: { ...SHOP, radiusM: 100 },
      requireIp: true,
      allowedIps: ['203.0.113.0/24', '203.0.113.0/24'],
      graceMinutes: 5,
    };
    await expectError(
      f.manager.attendance.policySave({ ...base, allowedIps: ['shop-wifi'] }),
      'attendance.errors.badIp',
    );
    await f.manager.attendance.policySave(base);
    const policy = await f.manager.attendance.policyGet({ storeId: f.storeId });
    expect(policy.allowedIps).toEqual(['203.0.113.0/24']);

    const punch = (
      ip: string | null,
      location: { lat: number; lng: number; accuracy: number } | null,
    ) =>
      f
        .staff(ip)
        .attendance.punch({ storeId: f.storeId, kind: 'in', deviceId: OTHER_DEVICE, location });
    await expectError(punch('203.0.113.9', null), 'attendance.errors.locationRequired');
    await expectError(
      punch('203.0.113.9', { ...SHOP, accuracy: 900 }),
      'attendance.errors.locationInaccurate',
    );
    await expectError(
      punch('203.0.113.9', { lat: SHOP.lat + 0.01, lng: SHOP.lng, accuracy: 10 }),
      'attendance.errors.outsideArea',
    );
    await expectError(
      punch('198.51.100.1', { ...SHOP, accuracy: 10 }),
      'attendance.errors.networkNotAllowed',
    );
    await expectError(
      punch(null, { ...SHOP, accuracy: 10 }),
      'attendance.errors.networkNotAllowed',
    );
    const ok = await punch('203.0.113.9', { lat: SHOP.lat + 0.0005, lng: SHOP.lng, accuracy: 15 });
    expect(ok.kind).toBe('in');
    await f.staff('203.0.113.9').attendance.punch({
      storeId: f.storeId,
      kind: 'out',
      deviceId: OTHER_DEVICE,
      location: { ...SHOP, accuracy: 5 },
    });
    await f.manager.attendance.policySave({
      ...base,
      requireGeo: false,
      geo: null,
      requireIp: false,
      allowedIps: [],
    });
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
