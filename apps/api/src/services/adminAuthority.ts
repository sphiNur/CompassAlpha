/**
 * Who may hand authority on in an organisation: the rank, tier and key
 * rules behind granting a role, shared by the admin router and invite
 * acceptance (2026-11-09, a first step of ADM1-11). The routers used to
 * import these from each other (admin → auth for inviterStillAuthorized).
 * It also counts the admins a removal would leave, for the last-admin
 * guard (countAdminsInOrg).
 *
 * Ranks, by what is being done:
 *   - an organisation-level act (a global grant or revoke, the role
 *     catalog, suspending, renaming or removing someone as an org admin,
 *     a global override) counts the actor's GLOBAL bindings alone
 *     (getActorMaxGlobalRank; F8, ADM1-01). A store binding, even a
 *     legacy rank-100 one, carries no organisation-wide weight;
 *   - an act in one store counts the actor's global bindings plus that
 *     store's (getActorMaxRankInStore; C1);
 *   - the person acted on is ranked by every live binding they hold
 *     (getActorMaxRank): the strongest protection.
 */
import { and, eq, gt, gte, isNull, lte, or } from 'drizzle-orm';
import { ADMIN_RANK } from '@compass/contracts';
import { schema as s, type DB } from '@compass/db';
import { hasGlobalOrgAdmin } from './orgAdmin';
import { isPlatformAdmin } from './platformAdmin';
import {
  adminScopeOf,
  effectiveGlobalPermissions,
  effectivePermissionsForStore,
  loadScopedPermissions,
} from './storeScope';

/** A binding with an expiry in the past grants nothing. */
export function bindingIsLive() {
  return or(isNull(s.memberRoleBindings.expiresAt), gt(s.memberRoleBindings.expiresAt, new Date()));
}

/**
 * Review ADM1-04 (2026-11-10): give a member a role in one scope. A lapsed
 * binding keeps the unique key (mrb_binding_unique), and every grant path
 * took it for "already held": the person got nothing, and grantRole said
 * they had the role. A lapsed binding is renewed instead (until
 * `expiresAt`, or for good); a live one is left as it is.
 */
export async function grantBinding(
  tx: DB,
  binding: {
    memberId: string;
    roleId: string;
    scope: { type: 'global' } | { type: 'store'; storeId: string };
    /** Who grants it; null for an invite whose inviter is gone. */
    grantedBy: string | null;
    expiresAt?: Date | null;
  },
): Promise<{ outcome: 'created' | 'renewed' | 'held'; bindingId: string }> {
  const scopeId = binding.scope.type === 'store' ? binding.scope.storeId : null;
  const expiresAt = binding.expiresAt ?? null;
  const [created] = await tx
    .insert(s.memberRoleBindings)
    .values({
      memberId: binding.memberId,
      roleId: binding.roleId,
      scopeType: binding.scope.type,
      scopeId,
      grantedBy: binding.grantedBy,
      expiresAt,
    })
    .onConflictDoNothing()
    .returning({ id: s.memberRoleBindings.id });
  if (created) return { outcome: 'created', bindingId: created.id };
  const sameKey = and(
    eq(s.memberRoleBindings.memberId, binding.memberId),
    eq(s.memberRoleBindings.roleId, binding.roleId),
    eq(s.memberRoleBindings.scopeType, binding.scope.type),
    scopeId ? eq(s.memberRoleBindings.scopeId, scopeId) : isNull(s.memberRoleBindings.scopeId),
  );
  const [renewed] = await tx
    .update(s.memberRoleBindings)
    .set({ expiresAt, grantedBy: binding.grantedBy })
    .where(and(sameKey, lte(s.memberRoleBindings.expiresAt, new Date())))
    .returning({ id: s.memberRoleBindings.id });
  if (renewed) return { outcome: 'renewed', bindingId: renewed.id };
  const [held] = await tx
    .select({ id: s.memberRoleBindings.id })
    .from(s.memberRoleBindings)
    .where(sameKey)
    .limit(1);
  return { outcome: 'held', bindingId: held?.id ?? '' };
}

async function maxRankWhere(
  tx: DB,
  orgId: string,
  userId: string,
  counts: (binding: { scopeType: string; scopeId: string | null }) => boolean,
): Promise<number> {
  const rows = await tx
    .select({
      rank: s.roles.rank,
      scopeType: s.memberRoleBindings.scopeType,
      scopeId: s.memberRoleBindings.scopeId,
    })
    .from(s.memberRoleBindings)
    .innerJoin(s.members, eq(s.members.id, s.memberRoleBindings.memberId))
    .innerJoin(s.roles, eq(s.roles.id, s.memberRoleBindings.roleId))
    .where(and(eq(s.members.orgId, orgId), eq(s.members.userId, userId), bindingIsLive()));
  let max = 0;
  for (const r of rows) {
    if (counts(r) && r.rank > max) max = r.rank;
  }
  return max;
}

/**
 * Highest rank among every live binding the person holds, in any scope.
 * Rank the person acted ON with it; an actor's weight depends on where
 * they act (getActorMaxGlobalRank, getActorMaxRankInStore).
 */
export function getActorMaxRank(tx: DB, orgId: string, userId: string): Promise<number> {
  return maxRankWhere(tx, orgId, userId, () => true);
}

/**
 * Highest rank among the person's live GLOBAL bindings: their weight in
 * an organisation-level act (security scan F8, 2026-10-31; ADM1-01,
 * 2026-11-09). Counting store bindings let a legacy store-scoped
 * super_admin binding outrank `admin` org-wide: grant `admin` globally,
 * edit or delete roles of their own tier, suspend or remove a fellow
 * admin, set them a global override.
 */
export function getActorMaxGlobalRank(tx: DB, orgId: string, userId: string): Promise<number> {
  return maxRankWhere(tx, orgId, userId, (b) => b.scopeType === 'global');
}

/**
 * C1 (2026-05-06): the person's rank in one store — global bindings
 * (admin and super_admin reach everywhere) plus bindings scoped to that
 * store. Ranking across the org instead let someone with rank 50 in
 * Store A grant rank 40 in Store B, where they have no authority at all.
 */
export function getActorMaxRankInStore(
  tx: DB,
  orgId: string,
  userId: string,
  storeId: string,
): Promise<number> {
  return maxRankWhere(
    tx,
    orgId,
    userId,
    (b) => b.scopeType === 'global' || (b.scopeType === 'store' && b.scopeId === storeId),
  );
}

/**
 * Active admin-rank members of the org. ADM-6 (2026-10-30): the guards
 * ask how many would be LEFT, so they pass the member or binding being
 * removed; counting the target used to refuse removing a suspended admin
 * (not counted at all) whenever only one other admin remained.
 */
export async function countAdminsInOrg(
  tx: DB,
  orgId: string,
  except: { memberId?: string; bindingId?: string } = {},
): Promise<number> {
  const rows = await tx
    .select({ memberId: s.memberRoleBindings.memberId, bindingId: s.memberRoleBindings.id })
    .from(s.memberRoleBindings)
    .innerJoin(s.members, eq(s.members.id, s.memberRoleBindings.memberId))
    .innerJoin(s.roles, eq(s.roles.id, s.memberRoleBindings.roleId))
    .where(
      and(
        eq(s.members.orgId, orgId),
        eq(s.members.status, 'active'),
        gte(s.roles.rank, ADMIN_RANK),
        bindingIsLive(),
      ),
    );
  // Distinct member ids — one member with two admin-level roles still
  // counts as ONE admin for "last admin" purposes.
  const distinct = new Set(
    rows
      .filter((r) => r.memberId !== except.memberId && r.bindingId !== except.bindingId)
      .map((r) => r.memberId),
  );
  return distinct.size;
}

/**
 * Where a role may be bound (2026-05-05 role design; F8). From
 * ADMIN_RANK up a role is organisation-tier and bound only globally;
 * below it only in stores. `org.admin` is never handed out per store, so
 * a lower role carrying it fits nowhere.
 */
export async function roleTier(
  tx: DB,
  role: { id: string; rank: number },
): Promise<'global' | 'store' | 'invalid'> {
  if (role.rank >= ADMIN_RANK) return 'global';
  const orgAdminKey = await tx.query.rolePermissions.findFirst({
    where: (rp, { eq: eq2, and: and2 }) =>
      and2(eq2(rp.roleId, role.id), eq2(rp.permissionKey, 'org.admin')),
    columns: { roleId: true },
  });
  return orgAdminKey ? 'invalid' : 'store';
}

/** Someone handing a role on: the signed-in actor, or an invite's inviter once the link is opened. */
export interface Granter {
  orgId: string;
  memberId: string;
  userId: string;
}

export type GrantScope = { type: 'global' } | { type: 'store'; storeId: string };

/**
 * D8 / RE-ADM-10 (2026-10-31): the workspace's super admin (a live
 * global super_admin binding, as the session counts it) and platform
 * administrators may pass on keys they do not hold themselves. `db` is
 * the root handle: the platform lookup runs in its own system
 * transaction.
 */
export async function passesOnAnyKey(db: DB, tx: DB, granter: Granter): Promise<boolean> {
  const [superAdmin] = await tx
    .select({ id: s.memberRoleBindings.id })
    .from(s.memberRoleBindings)
    .innerJoin(s.roles, eq(s.roles.id, s.memberRoleBindings.roleId))
    .where(
      and(
        eq(s.memberRoleBindings.memberId, granter.memberId),
        eq(s.memberRoleBindings.scopeType, 'global'),
        eq(s.roles.slug, 'super_admin'),
        bindingIsLive(),
      ),
    )
    .limit(1);
  return !!superAdmin || (await isPlatformAdmin(db, granter.userId));
}

/**
 * D8 / RE-ADM-10 (2026-10-31): granting a role hands over every key in
 * it, so the granter must hold each of them where the binding applies (a
 * store's effective set for a store binding, the org-wide set for a
 * global one). The rank gate alone let an admin grant a custom rank-70
 * role carrying super-admin keys. Returns the first missing key, or null.
 *
 * Built-in roles keep the rank rule alone: their keys are fixed by the
 * seed, and a store manager inviting a purchaser (whose run.* keys the
 * manager does not hold) is a live workflow.
 */
export async function missingRoleKey(
  db: DB,
  tx: DB,
  granter: Granter,
  roleId: string,
  storeId: string | null,
): Promise<string | null> {
  const [role] = await tx
    .select({ isBuiltIn: s.roles.isBuiltIn })
    .from(s.roles)
    .where(eq(s.roles.id, roleId));
  if (!role || role.isBuiltIn) return null;
  const rows = await tx
    .select({ key: s.rolePermissions.permissionKey })
    .from(s.rolePermissions)
    .where(eq(s.rolePermissions.roleId, roleId));
  if (rows.length === 0) return null;
  // DX-ADM-2: a global binding applies in every store, so it is checked
  // against the keys the granter holds org-wide, not the flat session set.
  const held = storeId
    ? await effectivePermissionsForStore(tx, granter.memberId, storeId, new Set())
    : await effectiveGlobalPermissions(tx, granter.memberId);
  const missing = rows.find((r) => !held.has(r.key))?.key ?? null;
  if (missing === null) return null;
  return (await passesOnAnyKey(db, tx, granter)) ? null : missing;
}

/** Why a grant is refused, as the routers throw it (an i18n key). */
export interface GrantRefusal {
  code: 'FORBIDDEN';
  message:
    | 'auth.errors.missingPermission'
    | 'auth.errors.cannotGrantEqualOrHigher'
    | 'auth.errors.cannotGrantMissingPermission';
  missingPermission?: string;
}

/**
 * Whether `granter` may hand `role` on in `scope` now, or why not. One
 * rule for creating an invite and for opening it later (COREAPI-07: an
 * old link still granted a global admin role after its inviter had been
 * demoted). The caller has matched the scope to the role's tier
 * (roleTier) first.
 *   - Globally: a global org admin whose global rank is strictly higher
 *     (F8, ADM1-01).
 *   - In a store: a strictly higher rank there (C1).
 *   - Either way, D8: the granter holds the role's keys where it applies.
 */
export async function grantRefusal(
  db: DB,
  tx: DB,
  granter: Granter,
  role: { id: string; rank: number },
  scope: GrantScope,
): Promise<GrantRefusal | null> {
  if (scope.type === 'global') {
    if (!(await hasGlobalOrgAdmin(tx, granter.memberId))) {
      return {
        code: 'FORBIDDEN',
        message: 'auth.errors.missingPermission',
        missingPermission: 'org.admin',
      };
    }
    if (role.rank >= (await getActorMaxGlobalRank(tx, granter.orgId, granter.userId))) {
      return { code: 'FORBIDDEN', message: 'auth.errors.cannotGrantEqualOrHigher' };
    }
  } else if (
    role.rank >= (await getActorMaxRankInStore(tx, granter.orgId, granter.userId, scope.storeId))
  ) {
    return { code: 'FORBIDDEN', message: 'auth.errors.cannotGrantEqualOrHigher' };
  }
  const missing = await missingRoleKey(
    db,
    tx,
    granter,
    role.id,
    scope.type === 'store' ? scope.storeId : null,
  );
  return missing
    ? {
        code: 'FORBIDDEN',
        message: 'auth.errors.cannotGrantMissingPermission',
        missingPermission: missing,
      }
    : null;
}

// ---------- Invites --------------------------------------------------------

/** A role grant as an invite snapshots it (auth.member_invites.grants). */
export interface InviteGrant {
  roleId: string;
  /** Rank when the invite was made. */
  rank: number;
  scopeType: 'global' | 'store';
  scopeId: string | null;
}

/**
 * The grants an opened link still hands out, each with its role as it
 * is now. A grant is dropped, not refused, when its role is gone, became
 * more powerful than the snapshot, or moved to the other tier (ADM1-02:
 * a role lowered below ADMIN_RANK must not arrive as a global binding),
 * so an edited role cannot keep someone out entirely.
 */
export async function liveInviteGrants(
  tx: DB,
  invite: { orgId: string; grants: readonly InviteGrant[] },
): Promise<Array<{ grant: InviteGrant; role: { id: string; rank: number } }>> {
  const live: Array<{ grant: InviteGrant; role: { id: string; rank: number } }> = [];
  for (const grant of invite.grants) {
    const role = await tx.query.roles.findFirst({
      where: (r, { eq: eq2, and: and2 }) =>
        and2(eq2(r.id, grant.roleId), eq2(r.orgId, invite.orgId)),
      columns: { id: true, rank: true },
    });
    if (!role || role.rank > grant.rank) continue;
    if (grant.scopeType === 'store' && !grant.scopeId) continue;
    if ((await roleTier(tx, role)) !== grant.scopeType) continue;
    live.push({ grant, role });
  }
  return live;
}

/**
 * 2026-10-21 CA-19 (A-06): what an inviter can still vouch for when
 * their link is opened. Mirrors the gates of admin.memberInviteCreate:
 * `users.manage` somewhere (requireAdmin) and admin-tier authority over
 * every store on the invite (getActorAdminStoreIds). An invite with no
 * store is an org-tier invite and needs a global admin-tier grant.
 */
export interface InviterAuthority {
  active: boolean;
  hasUsersManage: boolean;
  isGlobalAdmin: boolean;
  adminStoreIds: ReadonlySet<string>;
  /** Stores where overrides take a global admin's authority away (ADM1-03). */
  deniedStoreIds?: ReadonlySet<string>;
}

export function inviterCoversInvite(
  authority: InviterAuthority | null,
  inviteStoreIds: readonly string[],
): boolean {
  if (!authority || !authority.active || !authority.hasUsersManage) return false;
  if (authority.isGlobalAdmin) {
    return inviteStoreIds.every((id) => !authority.deniedStoreIds?.has(id));
  }
  if (inviteStoreIds.length === 0) return false;
  return inviteStoreIds.every((id) => authority.adminStoreIds.has(id));
}

async function loadInviterAuthority(
  tx: DB,
  orgId: string,
  inviterUserId: string | null,
): Promise<(InviterAuthority & { memberId: string }) | null> {
  if (!inviterUserId) return null;
  const member = await tx.query.members.findFirst({
    where: (m, { eq: eq2, and: and2 }) => and2(eq2(m.orgId, orgId), eq2(m.userId, inviterUserId)),
  });
  if (!member) return null;
  // ADM1-03 (2026-11-10): the rule the session and the admin router use.
  const { grants, overrides } = await loadScopedPermissions(tx, member.id);
  const scope = adminScopeOf(grants, overrides);
  return {
    memberId: member.id,
    active: member.status === 'active',
    hasUsersManage: scope.hasUsersManage,
    isGlobalAdmin: scope.isGlobalAdmin,
    adminStoreIds: scope.storeIds,
    deniedStoreIds: scope.deniedStoreIds,
  };
}

/**
 * Whether an invite's link may still be used: its inviter still covers
 * its stores (CA-19), and could still make each grant it carries today
 * (COREAPI-07, 2026-11-09). The link only checked `users.manage` over
 * the stores, so an org admin's link kept handing out the global admin
 * role after they were demoted to a store manager. Invite acceptance and
 * the pending-invite list both ask this. `db` is the root handle (see
 * passesOnAnyKey).
 */
export async function inviterStillAuthorized(
  db: DB,
  tx: DB,
  invite: {
    orgId: string;
    invitedBy: string | null;
    storeIds: readonly string[];
    grants: readonly InviteGrant[];
  },
): Promise<boolean> {
  const authority = await loadInviterAuthority(tx, invite.orgId, invite.invitedBy);
  if (!authority || !invite.invitedBy || !inviterCoversInvite(authority, invite.storeIds)) {
    return false;
  }
  const inviter: Granter = {
    orgId: invite.orgId,
    memberId: authority.memberId,
    userId: invite.invitedBy,
  };
  for (const { grant, role } of await liveInviteGrants(tx, invite)) {
    const scope: GrantScope | null =
      grant.scopeType === 'global'
        ? { type: 'global' }
        : grant.scopeId
          ? { type: 'store', storeId: grant.scopeId }
          : null;
    if (!scope || (await grantRefusal(db, tx, inviter, role, scope))) return false;
  }
  return true;
}
