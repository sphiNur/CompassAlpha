/**
 * Review TEST2-01 (2026-11-12): the attendance tables, faces among them,
 * kept to their own workspace row by row.
 *
 * rls-catalog.test.ts proves that every table has row-level security
 * forced and only the tenant policy; rls-isolation.test.ts proves, for the
 * tables it seeds, that the policies keep each workspace's rows to itself.
 * Neither seeded the twelve attendance tables, which hold face photos,
 * face features and where people were when they clocked in. Here each
 * gets one row in each of two workspaces: a workspace sees its own row
 * and not the other's, and with neither a workspace nor the system
 * context set, nobody sees either.
 *
 * Skipped as rls-isolation.test.ts is: without a database, and with a
 * role that bypasses row-level security (an error in CI).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { closeDb, getDb, schema as s } from '@compass/db';
import { SHOULD_RUN } from './helpers/pg';
import { freshTgId } from './helpers/telegram';
import { cleanUpAfterAll, noteOrg, noteUser } from './helpers/cleanup';
import { countUnderEachContext, rlsSuiteRuns } from './helpers/rls';

cleanUpAfterAll();

const RUN_RLS = await rlsSuiteRuns('rls-attendance');

/** One workspace's attendance rows, by the key each table is checked on. */
interface Tenant {
  orgId: string;
  memberId: string;
  storeId: string;
  shiftId: string;
  punchId: string;
  payRateId: string;
  overtimeId: string;
  photoId: string;
  enrollmentId: string;
  sampleId: string;
  frameId: string;
}

const tenants: Tenant[] = [];

/** A workspace with one person, one store and a row in every attendance table. */
async function seedTenant(label: string): Promise<Tenant> {
  const db = getDb(undefined, { system: 'maintenance' });
  const [org] = await db
    .insert(s.organizations)
    .values({
      slug: `rls-att-${Date.now()}-${label}`,
      name: `RLS attendance ${label}`,
      localeDefault: 'en',
      timezone: 'UTC',
    })
    .returning({ id: s.organizations.id });
  const orgId = noteOrg(org!.id);
  const [user] = await db
    .insert(s.users)
    .values({ displayName: label, tgUserId: freshTgId() })
    .returning({ id: s.users.id });
  noteUser(user!.id);
  const [member] = await db
    .insert(s.members)
    .values({ orgId, userId: user!.id })
    .returning({ id: s.members.id });
  const memberId = member!.id;
  const [store] = await db
    .insert(s.stores)
    .values({ orgId, name: `Store ${label}`, code: `ATT-${label}` })
    .returning({ id: s.stores.id });
  const storeId = store!.id;

  const at = new Date('2026-11-12T04:00:00Z');
  // What the tables' checks ask for: a 64-character device hash, a
  // 128-number face feature, a 32-byte frame hash.
  const image = Buffer.from([0xff, 0xd8, 0xff]);
  const feature = Array.from({ length: 128 }, () => 0.1);
  await db.insert(s.attendanceStorePolicies).values({ storeId, orgId });
  await db.insert(s.attendanceDevices).values({ memberId, orgId, deviceHash: label.repeat(64) });
  const [shift] = await db
    .insert(s.attendanceShifts)
    .values({
      orgId,
      storeId,
      memberId,
      shiftDate: '2026-11-12',
      startsAt: at,
      endsAt: new Date('2026-11-12T13:00:00Z'),
    })
    .returning({ id: s.attendanceShifts.id });
  const [punch] = await db
    .insert(s.attendancePunches)
    .values({
      orgId,
      storeId,
      memberId,
      kind: 'in',
      punchedAt: at,
      source: 'manual',
      reason: 'RLS test',
      createdByMemberId: memberId,
    })
    .returning({ id: s.attendancePunches.id });
  const punchId = punch!.id;
  const [payRate] = await db
    .insert(s.attendancePayRates)
    .values({ orgId, memberId, dailyWage: '100.00', effectiveFrom: '2026-11-01' })
    .returning({ id: s.attendancePayRates.id });
  const [overtime] = await db
    .insert(s.attendanceOvertime)
    .values({ orgId, storeId, memberId, punchId, minutes: 30 })
    .returning({ id: s.attendanceOvertime.id });
  const [photo] = await db
    .insert(s.attendancePhotos)
    .values({ orgId, storeId, memberId, punchId, kind: 'face', bytes: image })
    .returning({ id: s.attendancePhotos.id });
  const [enrollment] = await db
    .insert(s.attendanceFaceEnrollments)
    .values({ orgId, memberId, storeId })
    .returning({ id: s.attendanceFaceEnrollments.id });
  const enrollmentId = enrollment!.id;
  const [sample] = await db
    .insert(s.attendanceFaceSamples)
    .values({ orgId, enrollmentId, pose: 'front', feature, bytes: image })
    .returning({ id: s.attendanceFaceSamples.id });
  await db.insert(s.attendancePunchReviews).values({ punchId, orgId, storeId });
  const [frame] = await db
    .insert(s.attendancePunchFrames)
    .values({
      orgId,
      memberId,
      punchId,
      kind: 'face',
      sha256: Buffer.alloc(32, label.charCodeAt(0)),
      feature,
    })
    .returning({ id: s.attendancePunchFrames.id });
  await db.insert(s.attendanceFaceConsents).values({ memberId, orgId, version: 1 });
  return {
    orgId,
    memberId,
    storeId,
    shiftId: shift!.id,
    punchId,
    payRateId: payRate!.id,
    overtimeId: overtime!.id,
    photoId: photo!.id,
    enrollmentId,
    sampleId: sample!.id,
    frameId: frame!.id,
  };
}

beforeAll(async () => {
  if (!RUN_RLS) return;
  tenants.push(await seedTenant('A'), await seedTenant('B'));
});

afterAll(async () => {
  if (SHOULD_RUN) await closeDb();
});

/** Each attendance table, and which of a tenant's keys picks its row. */
const TABLES: ReadonlyArray<[table: string, column: string, key: keyof Tenant]> = [
  ['inventory.attendance_store_policies', 'store_id', 'storeId'],
  ['inventory.attendance_devices', 'member_id', 'memberId'],
  ['inventory.attendance_shifts', 'id', 'shiftId'],
  ['inventory.attendance_punches', 'id', 'punchId'],
  ['inventory.attendance_pay_rates', 'id', 'payRateId'],
  ['inventory.attendance_overtime', 'id', 'overtimeId'],
  ['inventory.attendance_photos', 'id', 'photoId'],
  ['inventory.attendance_face_enrollments', 'id', 'enrollmentId'],
  ['inventory.attendance_face_samples', 'id', 'sampleId'],
  ['inventory.attendance_punch_reviews', 'punch_id', 'punchId'],
  ['inventory.attendance_punch_frames', 'id', 'frameId'],
  ['inventory.attendance_face_consents', 'member_id', 'memberId'],
];

describe.skipIf(!RUN_RLS)('RLS: attendance rows stay in their workspace (PG-gated)', () => {
  test('the list is every attendance table', async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    // pg_class, as rls-catalog.test.ts reads it: information_schema hides
    // the tables the role has no grant on.
    const r = await db.execute(sql`
      SELECT n.nspname || '.' || c.relname AS t
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND n.nspname = 'inventory'
        AND starts_with(c.relname, 'attendance_')
    `);
    const rows = (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as {
      t: string;
    }[];
    expect(rows.map((row) => row.t).sort()).toEqual(TABLES.map(([table]) => table).sort());
  });

  for (const [table, column, key] of TABLES) {
    test(table, async () => {
      const [a, b] = tenants;
      if (!a || !b) throw new Error('fixture missing');
      const r = await countUnderEachContext(
        table,
        `${column} IN ('${a[key]}', '${b[key]}')`,
        a.orgId,
        b.orgId,
      );
      expect(r).toEqual({ aSeen: 1, bSeen: 1, totalSeen: 2 });
    });
  }
});
