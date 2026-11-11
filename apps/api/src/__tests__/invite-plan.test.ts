/**
 * Review ADM1-12 (2026-11-13): an invite link and an invite by Telegram ID
 * give the same stores and role bindings for the same request. They were
 * worked out in two copies that had drifted (routers/admin/invitePlan.ts
 * now decides both). The link keeps them on the invite until it is
 * opened; the Telegram ID path writes them at once.
 *
 * Skipped when DATABASE_URL is unset OR SKIP_PG_TESTS=1.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { desc, eq } from 'drizzle-orm';
import { getDb, schema as s, withOrgContext } from '@compass/db';
import { SHOULD_RUN } from './helpers/pg';
import { callerFor } from './helpers/ctx';
import { errorOf } from './helpers/errors';
import { freshTgId } from './helpers/telegram';
import { seedOwnedOrg, type OwnedOrg } from './helpers/fixtures';
import { cleanUpAfterAll } from './helpers/cleanup';

cleanUpAfterAll();

type Caller = ReturnType<typeof callerFor>;
/** A binding as both paths describe it: role, and where. */
type Binding = { roleId: string; scopeId: string | null };
type Given = { storeIds: string[]; bindings: Binding[] };
type Request = { roleSlug?: string; storeIds: string[] };

const byScope = (a: Binding, b: Binding) =>
  (a.scopeId ?? '').localeCompare(b.scopeId ?? '') || a.roleId.localeCompare(b.roleId);

describe.skipIf(!SHOULD_RUN)('invite plan (PG-gated)', () => {
  const db = getDb(undefined, { system: 'maintenance' });
  let org: OwnedOrg;
  let owner: Caller;
  let storeA = '';
  let storeB = '';
  let archived = '';

  beforeAll(async () => {
    org = await seedOwnedOrg(db, `Invite plan ${Date.now()}`);
    owner = callerFor(org.session);
    const suffix = Date.now().toString().slice(-6);
    const [a, b, c] = await db
      .insert(s.stores)
      .values([
        // A store whose default role is handed on to people invited without one.
        {
          orgId: org.orgId,
          name: 'Plan A',
          code: `PA-${suffix}`,
          defaultRoleId: org.roleIds.staff,
        },
        // An admin-tier default is never handed out that way.
        {
          orgId: org.orgId,
          name: 'Plan B',
          code: `PB-${suffix}`,
          defaultRoleId: org.roleIds.admin,
        },
        { orgId: org.orgId, name: 'Plan C', code: `PC-${suffix}`, isActive: false },
      ])
      .returning({ id: s.stores.id });
    storeA = a!.id;
    storeB = b!.id;
    archived = c!.id;
  });

  /** What a link made for `request` holds. */
  async function byLink(request: Request): Promise<Given> {
    await owner.admin.memberInviteCreate({ ...request, expiresInDays: 7 });
    const [invite] = await withOrgContext(db, org.orgId, (tx) =>
      tx
        .select({ storeIds: s.memberInvites.storeIds, grants: s.memberInvites.grants })
        .from(s.memberInvites)
        .where(eq(s.memberInvites.orgId, org.orgId))
        .orderBy(desc(s.memberInvites.createdAt))
        .limit(1),
    );
    return {
      storeIds: [...invite!.storeIds].sort(),
      bindings: invite!.grants.map(({ roleId, scopeId }) => ({ roleId, scopeId })).sort(byScope),
    };
  }

  /** What a new person invited by Telegram ID with `request` got. */
  async function byTelegramId(request: Request): Promise<Given> {
    const { memberId } = await owner.admin.memberInviteByTgId({
      ...request,
      tgUserId: freshTgId().toString(),
    });
    return withOrgContext(db, org.orgId, async (tx) => {
      const stores = await tx
        .select({ storeId: s.memberStoreAssignments.storeId })
        .from(s.memberStoreAssignments)
        .where(eq(s.memberStoreAssignments.memberId, memberId));
      const bindings = await tx
        .select({ roleId: s.memberRoleBindings.roleId, scopeId: s.memberRoleBindings.scopeId })
        .from(s.memberRoleBindings)
        .where(eq(s.memberRoleBindings.memberId, memberId));
      return { storeIds: stores.map((r) => r.storeId).sort(), bindings: bindings.sort(byScope) };
    });
  }

  test('a picked store role: one binding in each store, the same both ways', async () => {
    const request = { roleSlug: 'cashier', storeIds: [storeA, storeB, storeA] };
    const want: Given = {
      storeIds: [storeA, storeB].sort(),
      bindings: [
        { roleId: org.roleIds.cashier!, scopeId: storeA },
        { roleId: org.roleIds.cashier!, scopeId: storeB },
      ].sort(byScope),
    };
    expect(await byLink(request)).toEqual(want);
    expect(await byTelegramId(request)).toEqual(want);
  });

  test("no role picked: each store's default, never an admin-tier one, the same both ways", async () => {
    const request = { storeIds: [storeA, storeB] };
    const want: Given = {
      storeIds: [storeA, storeB].sort(),
      bindings: [{ roleId: org.roleIds.staff!, scopeId: storeA }],
    };
    expect(await byLink(request)).toEqual(want);
    expect(await byTelegramId(request)).toEqual(want);
  });

  test('an archived store is refused both ways, before anyone is created', async () => {
    const request = { roleSlug: 'cashier', storeIds: [storeA, archived] };
    const tgUserId = freshTgId();
    const viaLink = await errorOf(() =>
      owner.admin.memberInviteCreate({ ...request, expiresInDays: 7 }),
    );
    const viaTelegram = await errorOf(() =>
      owner.admin.memberInviteByTgId({ ...request, tgUserId: tgUserId.toString() }),
    );
    expect(viaLink?.message).toBeTruthy();
    expect([viaTelegram?.code, viaTelegram?.message]).toEqual([viaLink?.code, viaLink?.message]);
    const users = await db
      .select({ id: s.users.id })
      .from(s.users)
      .where(eq(s.users.tgUserId, tgUserId));
    expect(users).toEqual([]);
  });
});
