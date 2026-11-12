/**
 * The session a signed-in person's client receives (auth.me, and every
 * sign-in and refresh): who they are, the organisation they are in, their
 * other memberships, and what they may do in each of its stores.
 *
 * Review COREAPI-09 (2026-11-12): out of the auth router, which every
 * sign-in path shares it with.
 */
import { TRPCError } from '@trpc/server';
import { and, asc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { inSystem, schema as s, withOrgContext, type DB } from '@compass/db';
import type { Session } from '@compass/contracts';
import { detectLocale } from '@compass/i18n';
import { isPlatformAdmin } from './platformAdmin';
import {
  adminScopeOf,
  adminStoresOf,
  effectivePermissionsForStore,
  flatEffectivePermissions,
} from './storeScope';
import { readSubscriptionState, type SubscriptionState } from './subscription';

/**
 * Everything the client needs to know about who is signed in. Read inside
 * the member's own organisation: by this point the tenant is known, so
 * nothing here has a reason to see another one.
 */
export function buildSessionPayload(
  db: DB,
  userId: string,
  memberId: string,
  orgId: string,
): Promise<Session> {
  return Promise.all([listUserMemberships(db, userId), isPlatformAdmin(db, userId)]).then(
    ([memberships, platformAdmin]) =>
      withOrgContext(db, orgId, async (tx) => {
        const subscription = await readSubscriptionState(tx, orgId);
        return readSessionPayload(
          tx,
          userId,
          memberId,
          orgId,
          memberships,
          platformAdmin,
          subscription,
        );
      }),
  );
}

/**
 * The membership list is the one deliberately cross-tenant read a
 * signed-in user is allowed to perform: it returns only organisations
 * where that exact user has an active membership, and only summary
 * fields needed by the workspace switcher.
 */
async function listUserMemberships(db: DB, userId: string): Promise<Session['memberships']> {
  return inSystem(db, 'auth', async (tx) => {
    const rows = await tx
      .select({
        orgId: s.organizations.id,
        orgSlug: s.organizations.slug,
        orgName: s.organizations.name,
        memberId: s.members.id,
        status: s.members.status,
        joinedAt: s.members.joinedAt,
      })
      .from(s.members)
      .innerJoin(s.organizations, eq(s.organizations.id, s.members.orgId))
      .where(
        and(
          eq(s.members.userId, userId),
          eq(s.members.status, 'active'),
          isNull(s.organizations.deletedAt),
        ),
      )
      .orderBy(asc(s.members.joinedAt));
    return rows.map((row) => ({
      ...row,
      joinedAt: row.joinedAt.toISOString(),
    }));
  });
}

async function readSessionPayload(
  db: DB,
  userId: string,
  memberId: string,
  orgId: string,
  memberships: Session['memberships'],
  platformAdmin: boolean,
  subscription: SubscriptionState,
): Promise<Session> {
  const user = await db.query.users.findFirst({ where: (u, { eq: eq2 }) => eq2(u.id, userId) });
  const org = await db.query.organizations.findFirst({
    where: (o, { eq: eq2 }) => eq2(o.id, orgId),
  });
  const member = await db.query.members.findFirst({
    where: (m, { eq: eq2 }) => eq2(m.id, memberId),
  });
  if (!user || !org || !member) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'auth.errors.sessionStale' });
  }
  // Permissions and roles first — we need to know whether the member
  // is an admin (bypass) before we decide which stores they see.
  // Bindings now also expose scopeType + scopeId so we can compute
  // per-store rank (C1, 2026-05-06) and per-store admin set (C2).
  const bindings = await db
    .select({
      role: s.roles,
      scopeType: s.memberRoleBindings.scopeType,
      scopeId: s.memberRoleBindings.scopeId,
    })
    .from(s.memberRoleBindings)
    .innerJoin(s.roles, eq(s.roles.id, s.memberRoleBindings.roleId))
    .where(
      and(
        eq(s.memberRoleBindings.memberId, memberId),
        or(isNull(s.memberRoleBindings.expiresAt), gt(s.memberRoleBindings.expiresAt, new Date())),
      ),
    );
  // `super_admin` is used by a handful of destructive maintenance gates;
  // it is meaningful only from a global role binding.
  const roleSlugs = bindings
    .filter((b) => b.role.slug !== 'super_admin' || b.scopeType === 'global')
    .map((b) => b.role.slug);
  const roleIds = bindings.map((b) => b.role.id);
  // Highest rank held by this member. Used by the FE to gate role
  // grant UI: an admin can only see + offer roles strictly below
  // their own rank. The server enforces the same rule on grantRole;
  // this is purely UX.
  const myMaxRank = bindings.reduce((m, b) => (b.role.rank > m ? b.role.rank : m), 0);
  // C1 (2026-05-06): per-store rank, store-scoped bindings only.
  // The FE combines this with `myMaxRank` (which already includes
  // global rank) to get effective rank in a given store via
  //   max(globalMax, storeRanks[storeId] ?? 0)
  // We don't pre-mix global rank in here so the FE can tell a
  // "store-scoped manager-of-A" apart from a "global admin who also
  // has manager-of-A" when displaying the org chart.
  const storeRanks: Record<string, number> = {};
  for (const b of bindings) {
    if (b.scopeType === 'store' && b.scopeId) {
      const cur = storeRanks[b.scopeId] ?? 0;
      if (b.role.rank > cur) storeRanks[b.scopeId] = b.role.rank;
    }
  }
  const perms =
    roleIds.length > 0
      ? await db.query.rolePermissions.findMany({
          where: (rp, { inArray }) => inArray(rp.roleId, roleIds),
        })
      : [];
  // The client receives a flat permission set for feature affordances.
  // `org.admin` is the one exception: it is an organization-wide bypass,
  // so it can only originate from a global role binding.

  // Per-member overrides (added 2026-05-05, migration 0008).
  //
  // Two passes — `allow` first (additive), then `deny` (subtractive)
  // so deny always wins on conflict. Expired overrides are filtered
  // server-side: cheaper than a per-request cron sweep.
  //
  // M0 simplification: store-scoped overrides land in the same
  // permission set regardless of which store the request targets.
  // Per-store gating moves to a request-time check when the
  // store-scope middleware grows; the schema is forward-compatible.
  const overrides = await db
    .select({
      permissionKey: s.memberPermissionOverrides.permissionKey,
      effect: s.memberPermissionOverrides.effect,
      scopeType: s.memberPermissionOverrides.scopeType,
      scopeId: s.memberPermissionOverrides.scopeId,
    })
    .from(s.memberPermissionOverrides)
    .where(
      and(
        eq(s.memberPermissionOverrides.memberId, memberId),
        // Either no expiry, or expiry is in the future. Mirrors the SQL
        // pattern Postgres uses for soft-expiring rows without a sweeper.
        or(
          isNull(s.memberPermissionOverrides.expiresAt),
          gt(s.memberPermissionOverrides.expiresAt, new Date()),
        ),
      ),
    );
  // Defensive `o.permissionKey` truthiness check (audit 2026-05-05) —
  // the column is FK + NOT NULL so this should always be a non-empty
  // string, but a malformed row from a future migration bug shouldn't
  // pollute permKeys with `''` or `undefined`.
  //
  // The flat set the client gets: keys effective in at least one scope,
  // overrides applied per scope (ADM-3: a deny in ONE store used to be
  // collapsed into the flat set and hid Manage for a two-store manager).
  // Per-store checks still run through effectivePermissionsForStore.
  const keysByRole = new Map<string, string[]>();
  for (const p of perms) {
    keysByRole.set(p.roleId, [...(keysByRole.get(p.roleId) ?? []), p.permissionKey]);
  }
  const scopedGrants = bindings.flatMap((b) =>
    (keysByRole.get(b.role.id) ?? []).map((key) => ({
      key,
      scopeType: b.scopeType,
      scopeId: b.scopeId,
    })),
  );
  const scopedOverrides = overrides.map((o) => ({
    key: o.permissionKey,
    effect: o.effect,
    scopeType: o.scopeType,
    scopeId: o.scopeId,
  }));
  const permKeys = flatEffectivePermissions(scopedGrants, scopedOverrides);

  // `users.manage` is store-manager authority too. Only the explicit
  // org-tier marker grants visibility over every store in the session.
  const isOrgAdmin = permKeys.has('org.admin');

  // Scope stores: org admins see ALL active stores in the org. Regular
  // staff see ONLY stores they're explicitly assigned to. This is the
  // multi-store isolation guarantee — prevents store A's staff from
  // seeing store B's data in their session.stores list.
  let storeRows: Array<{
    id: string;
    name: string;
    code: string | null;
    isActive: boolean;
    sortIndex: number;
  }>;
  if (isOrgAdmin) {
    storeRows = await db
      .select({
        id: s.stores.id,
        name: s.stores.name,
        code: s.stores.code,
        isActive: s.stores.isActive,
        sortIndex: s.stores.sortIndex,
      })
      .from(s.stores)
      .where(and(eq(s.stores.orgId, orgId), eq(s.stores.isActive, true)))
      .orderBy(s.stores.sortIndex);
  } else {
    // Non-admin: union of two scope sources (added 2026-05-05 — see
    // storeScope.getActorStoreIds for the same logic, and migration
    // 0007 for how existing global manager bindings got fanned out).
    //   (1) member_store_assignments rows  — explicit "works here"
    //   (2) member_role_bindings (scope_type='store') — role grant
    // Both are valid grants of "you can act on store X". A manager
    // granted "manager of store B" sees store B even if MSA is empty.
    const [msaStores, scopedStores] = await Promise.all([
      db
        .select({
          id: s.stores.id,
          name: s.stores.name,
          code: s.stores.code,
          isActive: s.stores.isActive,
          sortIndex: s.stores.sortIndex,
        })
        .from(s.stores)
        .innerJoin(s.memberStoreAssignments, eq(s.memberStoreAssignments.storeId, s.stores.id))
        .where(
          and(
            eq(s.stores.orgId, orgId),
            eq(s.stores.isActive, true),
            eq(s.memberStoreAssignments.memberId, memberId),
          ),
        ),
      db
        .select({
          id: s.stores.id,
          name: s.stores.name,
          code: s.stores.code,
          isActive: s.stores.isActive,
          sortIndex: s.stores.sortIndex,
        })
        .from(s.stores)
        .innerJoin(s.memberRoleBindings, eq(s.memberRoleBindings.scopeId, s.stores.id))
        .where(
          and(
            eq(s.stores.orgId, orgId),
            eq(s.stores.isActive, true),
            eq(s.memberRoleBindings.memberId, memberId),
            eq(s.memberRoleBindings.scopeType, 'store'),
            or(
              isNull(s.memberRoleBindings.expiresAt),
              gt(s.memberRoleBindings.expiresAt, new Date()),
            ),
          ),
        ),
    ]);
    const seen = new Set<string>();
    storeRows = [...msaStores, ...scopedStores]
      .filter((row) => {
        if (seen.has(row.id)) return false;
        seen.add(row.id);
        return true;
      })
      .sort((a, b) => a.sortIndex - b.sortIndex);
  }

  // C2 (2026-05-06): the stores the actor manages people in. A
  // store-scoped manager who has `users.manage` only in Store A must not
  // be able to invite into Store B; the FE filters its store pickers
  // against this list and the server gates writes via
  // `getActorAdminStoreIds`. Computed here so the session payload is the
  // single source of truth — no extra round trip per UI render. A global
  // admin's list is every active store (minus any where overrides deny
  // all admin-tier keys), so the FE uses one `Set<storeId>` lookup.
  //
  // ADM1-03 (2026-11-10): the same rule as the admin router and invite
  // acceptance (storeScope.adminScopeOf); it used to be a third copy.
  // COREWEB2-11: the inactive stores they manage go separately: removing
  // a role there stays possible (R2-ADM-2), granting does not.
  const adminScope = adminScopeOf(scopedGrants, scopedOverrides);
  const candidateStores =
    adminScope.isGlobalAdmin || adminScope.storeIds.size > 0
      ? await db
          .select({ id: s.stores.id, isActive: s.stores.isActive })
          .from(s.stores)
          .where(
            and(
              eq(s.stores.orgId, orgId),
              adminScope.isGlobalAdmin ? undefined : inArray(s.stores.id, [...adminScope.storeIds]),
            ),
          )
      : [];
  const managed = new Set(
    adminStoresOf(
      adminScope,
      candidateStores.map((st) => st.id),
    ),
  );
  const adminStoreIds = candidateStores
    .filter((st) => st.isActive && managed.has(st.id))
    .map((st) => st.id);
  const inactiveAdminStoreIds = candidateStores
    .filter((st) => !st.isActive && managed.has(st.id))
    .map((st) => st.id);

  // Onboarding hint: the FE should show the name-confirm screen when
  // the user hasn't yet locked their displayName. Either flow reaches
  // this state:
  //   1. Self sign-up via Telegram (user has displayName from Telegram
  //      but never confirmed it in our app).
  //   2. Admin invite via memberInviteByTgId (placeholder name `tg:NNN`).
  const needsOnboarding = !user.displayNameLocked;

  // SHL-2 / CLS-5 (2026-10-30): the effective permissions in each of the
  // member's stores, so store-bound tabs can follow the selected store.
  // `permissions` above stays the flat union every older client reads.
  const storePermissions: Record<string, string[]> = {};
  const permSet = new Set(permKeys);
  for (const st of storeRows) {
    storePermissions[st.id] = [
      ...(await effectivePermissionsForStore(db, member.id, st.id, permSet)),
    ];
  }

  return {
    user: {
      id: user.id,
      displayName: user.displayName,
      displayNameLocked: user.displayNameLocked,
      avatarUrl: user.avatarUrl,
      locale: detectLocale(user.locale),
      // M3.45 (2026-05-22): bilingual display preference. Null when
      // unset (default — single-language UI). Otherwise one of the
      // 4-locale enum, drives product-name rendering and per-vendor
      // copy-template language.
      secondaryLocale: (user.secondaryLocale ?? null) as Session['user']['locale'] | null,
      tgUsername: user.tgUsername,
      tgUserId: user.tgUserId === null ? null : String(user.tgUserId),
    },
    member: {
      memberId: member.id,
      orgId: org.id,
      orgSlug: org.slug,
      orgName: org.name,
      status: member.status,
      // M1.17 (2026-05-08): currency + tax exposed on session so the
      // FE can format money + display tax info without a round-trip
      // per page. Snapshot-from-DB at login — operators should NEVER
      // flip currency mid-life, so this stays valid for the session
      // lifetime.
      currency: org.currency ?? 'UZS',
      taxRatePct: org.taxRatePct ?? '0',
      pricesIncludeTax: org.pricesIncludeTax ?? true,
      timezone: org.timezone,
    },
    memberships,
    isPlatformAdmin: platformAdmin,
    subscription,
    stores: storeRows.map((st) => ({
      id: st.id,
      name: st.name,
      code: st.code,
      isActive: st.isActive,
    })),
    permissions: [...permKeys],
    roleSlugs,
    myMaxRank,
    storeRanks,
    adminStoreIds,
    inactiveAdminStoreIds,
    storePermissions,
    needsOnboarding,
  };
}
