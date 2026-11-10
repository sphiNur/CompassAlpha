/**
 * The attendance suites' shared code (review TEST1-17, 2026-11): a
 * workspace for each test, the stub face model, and the steps the tests
 * take (enrol a face, clock with a challenge, void punches). The suites
 * are attendance-punch, -pay, -face, -liveness and -reminders.
 */
import { afterAll, beforeAll, beforeEach, expect } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, schema as s } from '@compass/db';
import { appRouter } from '../../trpc/router';
import { setFaceEngineForTests } from '../../services/face';
import { signLivenessToken } from '../../services/face/liveness';
import type { SessionContext } from '../../trpc/context';
import { SHOULD_RUN } from './pg';
import { callerFor } from './ctx';
import { seedMember } from './fixtures';
import { errorOf } from './errors';

export type Caller = ReturnType<typeof appRouter.createCaller>;

export interface Fixture {
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
let current: Fixture | null = null;

/** The current test's workspace (see attendanceSuite). */
export function fixture(): Fixture {
  if (!current) throw new Error('attendance fixture missing');
  return current;
}

export const TZ = 'Asia/Tashkent';
export const DEVICE = 'device-aaaaaaaaaaaaaaaa';
export const OTHER_DEVICE = 'device-bbbbbbbbbbbbbbbb';
export const SHOP = { lat: 41.311081, lng: 69.240562 };

/** A fake JPEG whose text says what the stub face model sees. */
export const jpeg = (tag: string) =>
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

export const enrollPhotos = (who: string, over: Partial<Record<string, string>> = {}) => ({
  front: jpeg(over.front ?? `${who}:front`),
  left: jpeg(over.left ?? `${who}:left`),
  right: jpeg(over.right ?? `${who}:right`),
  up: jpeg(over.up ?? `${who}:up`),
  down: jpeg(over.down ?? `${who}:down`),
  front2: jpeg(over.front2 ?? `${who}:front2`),
});

/** Agree, enroll `who`'s face and have the manager approve it. */
export async function enrollApproved(caller: Caller, who: string) {
  const f = fixture();
  await caller.attendance.faceConsentGive({ version: 1 });
  const e = await caller.attendance.faceEnroll({ storeId: f.storeId, photos: enrollPhotos(who) });
  await f.manager.attendance.faceEnrollDecide({
    storeId: f.storeId,
    enrollmentId: e.id,
    approve: true,
  });
}

/** A token with no turns asked: a passive punch (one face photo). */
export async function passiveToken(memberId: string) {
  const f = fixture();
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
export async function clock(
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
  const f = fixture();
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

/**
 * The store's rules with neither a bound phone nor a place asked for, and
 * the defaults otherwise. The face and liveness checks are always on.
 */
export function anyPhoneAnywhere(storeId: string) {
  return {
    storeId,
    requireDevice: false,
    requireGeo: false,
    geo: null,
    graceMinutes: 5,
    overtimeAfterMinutes: 30,
  };
}

/** Who was sent a bot message from `template` in this workspace, oldest first. */
export async function botRecipients(template: string): Promise<string[]> {
  const f = fixture();
  const rows = await getDb(undefined, { system: 'maintenance' })
    .select({ to: s.notifications.recipientUserId })
    .from(s.notifications)
    .where(
      and(
        eq(s.notifications.orgId, f.orgId),
        eq(s.notifications.channel, 'bot'),
        eq(s.notifications.template, template),
      ),
    )
    .orderBy(s.notifications.createdAt);
  return rows.map((row) => row.to);
}

/** Void everyone's open punches, so in / out starts over. */
export async function resetPunches(...memberIds: string[]) {
  const db = getDb(undefined, { system: 'maintenance' });
  for (const id of memberIds) {
    await db.execute(
      sql`UPDATE inventory.attendance_punches SET voided_at = now(), voided_by_member_id = member_id, void_reason = 'test reset' WHERE member_id = ${id} AND voided_at IS NULL`,
    );
  }
}

export async function expectError(p: Promise<unknown>, message: string) {
  expect((await errorOf(() => p))?.message).toBe(message);
}

/**
 * A workspace of the test's own (review NEW-RAND-01, 2026-11): two
 * stores, a manager, Ali (staff) and Bob (a colleague) in the first, an
 * outsider in the other. Nobody is switched on for clocking yet. The
 * tests used to share one workspace, each starting from what the ones
 * before had left: Ali switched on with an approved face, a bound phone,
 * the pay test's shift, the notifications sent so far.
 */
async function attendanceOrg(): Promise<Fixture> {
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({
      slug: `attendance-test-${suffix}`,
      name: 'Attendance Test',
      localeDefault: 'en',
      timezone: TZ,
    })
    .returning();
  const person = async (name: string) => {
    const who = await seedMember(db, org!.id, { name });
    return { userId: who.userId, memberId: who.memberId };
  };
  const mgr = await person('Att Manager');
  const staff = await person('Att Staff');
  const outsider = await person('Att Outsider');
  const colleague = await person('Att Colleague');
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
  return {
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
    colleague: () => callerFor(session(colleague, ['attendance.clock'])),
    manager: callerFor(session(mgr, ['attendance.manage'])),
    superAdmin: () =>
      callerFor({ ...session(mgr, ['attendance.manage']), roleSlugs: new Set(['super_admin']) }),
    staff: () => callerFor(session(staff, ['attendance.clock'])),
  };
}

/**
 * Call once at the top of a suite. It stubs the face model for the file
 * and makes a new workspace before each test (fixture()).
 */
export function attendanceSuite(): void {
  afterAll(() => setFaceEngineForTests(null));
  beforeAll(() => {
    if (SHOULD_RUN) stubFaces();
  });
  beforeEach(async () => {
    if (SHOULD_RUN) current = await attendanceOrg();
  });
}

/** Ali switched on for clocking, with an approved face. */
export async function staffReady() {
  const f = fixture();
  await f.manager.attendance.memberSet({ storeId: f.storeId, memberId: f.staffId, enabled: true });
  await enrollApproved(f.staff(), 'Ali');
}

/** A refused call's key and the placeholders it sent. */
export async function refusal(p: Promise<unknown>) {
  const err = await errorOf(() => p);
  const cause = err?.cause as { context?: Record<string, unknown> } | undefined;
  return { message: err?.message ?? null, context: cause?.context ?? null };
}
