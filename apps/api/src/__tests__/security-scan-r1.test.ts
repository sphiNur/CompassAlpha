/**
 * Claude Security scan, 2026-10-31 (server findings):
 *
 *   F1 / D22  an admin cannot rename (or lock the name of) someone who
 *             also belongs to another organisation; the placeholder
 *             rename on invite follows the same rule.
 *   F5 / D21  dev login counts as local only for a direct connection
 *             from loopback / the LAN with no proxy headers.
 *   F7        suspending or removing a member closes their sockets.
 *   F8        the invite paths need a global org admin (global rank) for
 *             an org-tier role.
 *   F9        mirroring roles on a store transfer runs the D8 key check.
 *   F10       names refuse control characters; ops scripts print them
 *             escaped.
 *
 * F2 lives in purchase-delivery-r2.test.ts (it needs runs), F6 in
 * apps/worker/src/markdown.test.ts, F11 in scripts/__tests__/backup.test.ts.
 *
 * The PG half is skipped when DATABASE_URL is unset OR SKIP_PG_TESTS=1.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, printable, schema as s, withOrgContext } from '@compass/db';
import { CompleteOnboardingInputSchema, hasControlChars } from '@compass/contracts';
import { appRouter } from '../trpc/router';
import { createContext, type RequestContext } from '../trpc/context';
import { isLocalDevPeer, isLocalPeerAddress } from '../services/devLocality';
import { hub, WS_CLOSE_EVICTED, WS_CLOSE_MEMBERSHIP_ENDED } from '../realtime/hub';
import { SHOULD_RUN } from './helpers/pg';
import { callerFor, gateCaller } from './helpers/ctx';
import { errorOf } from './helpers/errors';
import { seedMember, seedOwnedOrg, seedUser, sessionOf, type MemberSpec } from './helpers/fixtures';

// ---------- F5 / D21 ------------------------------------------------------

describe('dev login locality (F5 / D21)', () => {
  const none = () => undefined;
  const headers = (h: Record<string, string>) => (name: string) => h[name];

  test('loopback and private LAN peers are local', () => {
    for (const ip of [
      '127.0.0.1',
      '127.8.9.10',
      '::1',
      '10.0.0.7',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.23',
      'fc00::1',
      'fd12:3456::9',
      '::ffff:192.168.1.23',
      '::ffff:127.0.0.1',
    ]) {
      expect([ip, isLocalPeerAddress(ip)]).toEqual([ip, true]);
    }
  });

  test('public, link-local and malformed peers are not', () => {
    for (const ip of [
      '8.8.8.8',
      '172.15.0.1',
      '172.32.0.1',
      '192.169.0.1',
      '169.254.1.1',
      'fe80::1',
      'fc::1',
      '2001:db8::1',
      '::ffff:8.8.8.8',
      'localhost',
      '',
      null,
      undefined,
    ]) {
      expect([ip, isLocalPeerAddress(ip)]).toEqual([ip, false]);
    }
  });

  test('any proxy header makes a local peer non-local (cloudflared, nginx)', () => {
    expect(isLocalDevPeer('127.0.0.1', none)).toBe(true);
    for (const name of ['cf-connecting-ip', 'cf-ray', 'x-forwarded-for']) {
      expect(isLocalDevPeer('127.0.0.1', headers({ [name]: '127.0.0.1' }))).toBe(false);
    }
  });

  /** auth.loginModes through the real createContext, as the server builds it. */
  async function localRequest(peerIp: string | null, h: Record<string, string>) {
    const hono = { req: { header: (name: string) => h[name.toLowerCase()] }, env: { peerIp } };
    const ctx = await createContext(null, hono as RequestContext['hono']);
    const modes = await appRouter.createCaller(ctx).auth.loginModes();
    return modes.environment.localRequest;
  }

  test('the Fine phone on the Wi-Fi still counts as local', async () => {
    expect(await localRequest('192.168.1.40', { 'x-forwarded-host': 'localhost' })).toBe(true);
    expect(await localRequest('127.0.0.1', {})).toBe(true);
  });

  test('Host / Origin / X-Forwarded-Host no longer make a request local', async () => {
    const spoofed = {
      host: 'localhost:3000',
      origin: 'http://localhost',
      'x-forwarded-host': 'localhost',
    };
    expect(await localRequest('203.0.113.9', spoofed)).toBe(false);
    expect(await localRequest(null, spoofed)).toBe(false);
  });

  test('a request through cloudflared (peer 127.0.0.1, cf-* headers) is refused', async () => {
    expect(
      await localRequest('127.0.0.1', {
        'cf-connecting-ip': '127.0.0.1',
        'cf-ray': '8f00-AMS',
        'x-forwarded-host': 'localhost',
      }),
    ).toBe(false);
    expect(await localRequest('127.0.0.1', { 'x-forwarded-for': '127.0.0.1' })).toBe(false);
  });
});

// ---------- F7 (hub level) ------------------------------------------------

describe('hub.closeMember (F7)', () => {
  test("closes only that member's sockets in that org, with the membership code", () => {
    const org = randomUUID();
    const otherOrg = randomUUID();
    const closed: Array<[string, number]> = [];
    const sink = (label: string, orgId: string, memberId: string) =>
      hub.subscribe(
        orgId,
        () => {},
        (code) => closed.push([label, code]),
        memberId,
      );
    const unsubs = [
      sink('a1', org, 'member-a'),
      sink('a2', org, 'member-a'),
      sink('b', org, 'member-b'),
      sink('a-elsewhere', otherOrg, 'member-a'),
    ];
    hub.closeMember(org, 'member-a');
    expect(closed.sort()).toEqual([
      ['a1', WS_CLOSE_MEMBERSHIP_ENDED],
      ['a2', WS_CLOSE_MEMBERSHIP_ENDED],
    ]);
    expect(hub.size(org)).toBe(1);
    expect(hub.size(otherOrg)).toBe(1);
    expect(WS_CLOSE_MEMBERSHIP_ENDED).not.toBe(WS_CLOSE_EVICTED);
    for (const u of unsubs) u();
    expect(hub.size(org)).toBe(0);
  });
});

// ---------- F10 (no database) ---------------------------------------------

describe('control characters in names (F10)', () => {
  const ESC = '\u001b';

  test('hasControlChars catches C0, DEL and C1, not ordinary text', () => {
    for (const bad of [`${ESC}[1A`, 'a\nb', 'tab\there', 'del\u007f', 'csi\u009b2K', '\u0000']) {
      expect([bad, hasControlChars(bad)]).toEqual([bad, true]);
    }
    for (const ok of ['Chorsu bozori', 'Ташкент', '门店 1', 'Doʻkon № 2', 'Café — 50%']) {
      expect([ok, hasControlChars(ok)]).toEqual([ok, false]);
    }
  });

  test('printable shows control characters as \\uXXXX and leaves the rest', () => {
    expect(printable(`Store${ESC}[1A${ESC}[2Kfake`)).toBe('Store\\u001b[1A\\u001b[2Kfake');
    expect(printable('Ташкент 门店\u009b')).toBe('Ташкент 门店\\u009b');
    expect(printable(null)).toBe('');
    expect(printable(42)).toBe('42');
  });

  test('onboarding name refuses an escape sequence', () => {
    expect(CompleteOnboardingInputSchema.safeParse({ displayName: `A${ESC}[2K` }).success).toBe(
      false,
    );
    expect(CompleteOnboardingInputSchema.safeParse({ displayName: 'Aziz' }).success).toBe(true);
  });

  test('store / supplier / SKU / member names answer BAD_REQUEST before the handler', async () => {
    const caller = gateCaller({
      userId: randomUUID(),
      memberId: randomUUID(),
      orgId: randomUUID(),
      orgTimezone: 'UTC',
      writeAccess: true,
      permissions: new Set(['users.manage', 'org.admin', 'catalog.manage', 'stores.manage']),
      roleSlugs: new Set(),
    });
    const bad = `Shop${ESC}[1A${ESC}[2K`;
    const attempts: Array<() => Promise<unknown>> = [
      () => caller.admin.storeCreate({ name: bad }),
      () => caller.admin.storeCreate({ name: 'Shop', code: `A${ESC}` }),
      () => caller.admin.supplierCreate({ name: bad }),
      () => caller.admin.skuCreate({ names: { en: bad }, unit: 'kg' }),
      () => caller.admin.skuCreate({ names: { en: 'Rice' }, unit: 'kg', code: `R${ESC}` }),
      () => caller.admin.memberSetDisplayName({ memberId: randomUUID(), displayName: bad }),
    ];
    for (const attempt of attempts) {
      const err = await errorOf(attempt);
      expect(err?.code).toBe('BAD_REQUEST');
      expect(err?.message).not.toContain('reached the handler');
    }
  });
});

// ---------- PG half -------------------------------------------------------

describe.skipIf(!SHOULD_RUN)('admin guards from the security scan (PG-gated)', () => {
  const db = SHOULD_RUN ? getDb(undefined, { system: 'maintenance' }) : (null as never);
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const orgIds: string[] = [];
  const userIds: string[] = [];

  /** Org X (the acting admin's) and org Y (somebody else's). */
  let orgX = '';
  let orgY = '';
  let ownerX: { userId: string; memberId: string } = { userId: '', memberId: '' };
  let storeX1 = '';
  let storeX2 = '';
  const roleX: Record<string, string> = {};

  async function callerAs(orgId: string, userId: string, memberId: string) {
    return callerFor(await sessionOf(orgId, { userId, memberId }));
  }

  /** A new user, removed after the suite. */
  async function makeUser(displayName: string) {
    const user = await seedUser(db, displayName);
    userIds.push(user.id);
    return user;
  }

  /** `userId` as a member of `orgId`, assigned and bound as `options` say. */
  async function makeMember(
    orgId: string,
    userId: string,
    options: Pick<MemberSpec, 'stores' | 'roles'> = {},
  ) {
    return (await seedMember(db, orgId, { userId, ...options })).memberId;
  }

  async function makeOrg(label: string) {
    const org = await seedOwnedOrg(db, `Scan ${label}`);
    orgIds.push(org.orgId);
    userIds.push(org.owner.userId);
    return org;
  }

  async function nameOf(userId: string) {
    const [u] = await db
      .select({ displayName: s.users.displayName, locked: s.users.displayNameLocked })
      .from(s.users)
      .where(eq(s.users.id, userId));
    return u!;
  }

  beforeAll(async () => {
    const x = await makeOrg('X');
    const y = await makeOrg('Y');
    orgX = x.orgId;
    orgY = y.orgId;
    ownerX = x.owner;
    for (const label of ['X1', 'X2']) {
      const [store] = await db
        .insert(s.stores)
        .values({ orgId: orgX, name: `Store ${label}`, code: `${label}-${suffix.slice(-6)}` })
        .returning();
      if (label === 'X1') storeX1 = store!.id;
      else storeX2 = store!.id;
    }
    Object.assign(roleX, x.roleIds);
  });

  afterAll(async () => {
    for (const id of orgIds) await db.delete(s.organizations).where(eq(s.organizations.id, id));
    for (const id of userIds) await db.delete(s.users).where(eq(s.users.id, id));
  });

  // ---- F1 / D22

  test('F1: an admin cannot rename or lock someone another organisation also has', async () => {
    const shared = await makeUser('Shared Person');
    const memberX = await makeMember(orgX, shared.id, {
      roles: [{ roleId: roleX.staff!, storeId: storeX1 }],
    });
    await makeMember(orgY, shared.id);
    const admin = await callerAs(orgX, ownerX.userId, ownerX.memberId);
    const err = await errorOf(() =>
      admin.admin.memberSetDisplayName({ memberId: memberX, displayName: 'Y Owner' }),
    );
    expect(err?.code).toBe('FORBIDDEN');
    expect(err?.message).toBe('admin.errors.displayNameSharedWithOtherOrg');
    expect(await nameOf(shared.id)).toEqual({ displayName: 'Shared Person', locked: false });

    // The person themself still can, from either organisation.
    const self = await callerAs(orgX, shared.id, memberX);
    // (staff hold no users.manage: the self-rename path is auth.completeOnboarding)
    await self.auth.completeOnboarding({ displayName: 'Shared Renamed' });
    expect((await nameOf(shared.id)).displayName).toBe('Shared Renamed');
  });

  test('F1: an admin who is in two organisations may still rename themself', async () => {
    const both = await makeUser('Two Org Admin');
    const memberX = await makeMember(orgX, both.id, { roles: [{ roleId: roleX.admin! }] });
    await makeMember(orgY, both.id);
    const self = await callerAs(orgX, both.id, memberX);
    await self.admin.memberSetDisplayName({ memberId: memberX, displayName: 'Admin Renamed' });
    expect(await nameOf(both.id)).toEqual({ displayName: 'Admin Renamed', locked: true });
  });

  test('F1: a member of this organisation alone is renamed as before', async () => {
    const local = await makeUser('Only Here');
    const memberX = await makeMember(orgX, local.id, {
      roles: [{ roleId: roleX.staff!, storeId: storeX1 }],
    });
    const admin = await callerAs(orgX, ownerX.userId, ownerX.memberId);
    await admin.admin.memberSetDisplayName({ memberId: memberX, displayName: 'Fixed Typo' });
    expect(await nameOf(local.id)).toEqual({ displayName: 'Fixed Typo', locked: true });
  });

  test('F1: the invite placeholder rename skips someone another organisation has', async () => {
    const admin = await callerAs(orgX, ownerX.userId, ownerX.memberId);

    const elsewhere = await makeUser(`tg:${suffix}1`);
    await makeMember(orgY, elsewhere.id);
    await admin.admin.memberInviteByTgId({
      tgUserId: elsewhere.tgUserId.toString(),
      displayName: 'Planted Name',
      roleSlug: 'staff',
      storeIds: [storeX1],
    });
    expect((await nameOf(elsewhere.id)).displayName).toBe(`tg:${suffix}1`);

    const fresh = await makeUser(`tg:${suffix}2`);
    await admin.admin.memberInviteByTgId({
      tgUserId: fresh.tgUserId.toString(),
      displayName: 'Useful Name',
      roleSlug: 'staff',
      storeIds: [storeX1],
    });
    expect((await nameOf(fresh.id)).displayName).toBe('Useful Name');
  });

  // ---- F7

  test("F7: suspending or removing a member closes that member's sockets", async () => {
    const admin = await callerAs(orgX, ownerX.userId, ownerX.memberId);
    for (const action of ['suspend', 'remove'] as const) {
      const person = await makeUser(`Socket ${action}`);
      const memberId = await makeMember(orgX, person.id, {
        roles: [{ roleId: roleX.staff!, storeId: storeX1 }],
      });
      const codes: number[] = [];
      const unsub = hub.subscribe(orgX, () => {}, (code) => codes.push(code), memberId);
      const bystander: number[] = [];
      const unsubOwner = hub.subscribe(
        orgX,
        () => {},
        (code) => bystander.push(code),
        ownerX.memberId,
      );
      if (action === 'suspend') {
        await admin.admin.memberSetStatus({ memberId, status: 'suspended' });
      } else {
        await admin.admin.memberRemove({ memberId });
      }
      expect(codes).toEqual([WS_CLOSE_MEMBERSHIP_ENDED]);
      expect(bystander).toEqual([]);
      unsub();
      unsubOwner();
    }
  });

  // ---- F8

  test('F8: a store-scoped super_admin binding cannot invite an org admin', async () => {
    const legacy = await makeUser('Legacy Scoped Super');
    const legacyMember = await makeMember(orgX, legacy.id, {
      roles: [
        { roleId: roleX.super_admin!, storeId: storeX1 },
        { roleId: roleX.super_admin!, storeId: storeX2 },
      ],
    });
    const caller = await callerAs(orgX, legacy.id, legacyMember);

    const err = await errorOf(() =>
      caller.admin.memberInviteByTgId({
        tgUserId: legacy.tgUserId.toString(),
        roleSlug: 'admin',
        storeIds: [],
      }),
    );
    expect(err?.code).toBe('FORBIDDEN');
    expect(err?.message).toBe('auth.errors.missingPermission');
    const linkErr = await errorOf(() =>
      caller.admin.memberInviteCreate({ roleSlug: 'admin', storeIds: [], expiresInDays: 7 }),
    );
    expect(linkErr?.code).toBe('FORBIDDEN');
    expect(linkErr?.message).toBe('auth.errors.missingPermission');
    const bindings = await withOrgContext(db, orgX, (tx) =>
      tx
        .select({ scopeType: s.memberRoleBindings.scopeType })
        .from(s.memberRoleBindings)
        .where(eq(s.memberRoleBindings.memberId, legacyMember)),
    );
    expect(bindings.every((b) => b.scopeType === 'store')).toBe(true);
  });

  test('F8: a global org admin is ranked by global bindings only', async () => {
    // Global admin (80) plus a legacy store-scoped super_admin (100): the
    // store binding must not let them hand out admin (80) org-wide.
    const mixed = await makeUser('Admin With Scoped Super');
    const mixedMember = await makeMember(orgX, mixed.id, {
      roles: [{ roleId: roleX.admin! }, { roleId: roleX.super_admin!, storeId: storeX1 }],
    });
    const caller = await callerAs(orgX, mixed.id, mixedMember);
    const target = await makeUser('Would Be Admin');
    const err = await errorOf(() =>
      caller.admin.memberInviteByTgId({
        tgUserId: target.tgUserId.toString(),
        roleSlug: 'admin',
        storeIds: [],
      }),
    );
    expect(err?.code).toBe('FORBIDDEN');
    expect(err?.message).toBe('auth.errors.cannotGrantEqualOrHigher');

    // The owner (global super_admin) still invites an admin.
    const owner = await callerAs(orgX, ownerX.userId, ownerX.memberId);
    const out = await owner.admin.memberInviteByTgId({
      tgUserId: target.tgUserId.toString(),
      roleSlug: 'admin',
      storeIds: [],
    });
    expect(out.created).toBe(true);
    const link = await owner.admin.memberInviteCreate({
      roleSlug: 'admin',
      storeIds: [],
      expiresInDays: 7,
    });
    expect(link.token).toStartWith('inv_');
  });

  // ---- F9

  test('F9: a transfer does not mirror a custom role whose keys the actor lacks there', async () => {
    const owner = await callerAs(orgX, ownerX.userId, ownerX.memberId);
    // Custom role C (rank 25) carries reports.view.
    const { id: customRoleId } = await owner.admin.roleCreate({
      slug: `scan-c-${suffix}`,
      name: 'Scan C',
      rank: 25,
      permissionKeys: ['reports.view'],
    });
    // The actor manages both stores: manager (holds reports.view) in X1,
    // a custom manager-like role without reports.view in X2.
    const { id: noReportsRoleId } = await owner.admin.roleCreate({
      slug: `scan-m-${suffix}`,
      name: 'Scan M',
      rank: 50,
      permissionKeys: ['users.manage'],
    });
    const actor = await makeUser('Two Store Manager');
    const actorMember = await makeMember(orgX, actor.id, {
      stores: [storeX1, storeX2],
      roles: [
        { roleId: roleX.manager!, storeId: storeX1 },
        { roleId: noReportsRoleId, storeId: storeX2 },
      ],
    });
    const target = await makeUser('Carries C');
    const targetMember = await makeMember(orgX, target.id, {
      stores: [storeX1],
      roles: [{ roleId: customRoleId, storeId: storeX1 }],
    });

    const caller = await callerAs(orgX, actor.id, actorMember);
    const err = await errorOf(() =>
      caller.admin.memberTransferStore({
        memberId: targetMember,
        fromStoreId: storeX1,
        toStoreId: storeX2,
        mirrorRoles: true,
      }),
    );
    expect(err?.code).toBe('FORBIDDEN');
    expect(err?.message).toBe('auth.errors.cannotGrantMissingPermission');
    const inX2 = await withOrgContext(db, orgX, (tx) =>
      tx
        .select({ scopeId: s.memberRoleBindings.scopeId })
        .from(s.memberRoleBindings)
        .where(eq(s.memberRoleBindings.memberId, targetMember)),
    );
    expect(inX2.map((b) => b.scopeId)).toEqual([storeX1]);

    // Without mirroring the move itself still works.
    const moved = await caller.admin.memberTransferStore({
      memberId: targetMember,
      fromStoreId: storeX1,
      toStoreId: storeX2,
      mirrorRoles: false,
    });
    expect(moved.ok).toBe(true);
  });
});
