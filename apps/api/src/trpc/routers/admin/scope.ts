/**
 * Which stores and which members an admin may act on and see (C2,
 * CA-17). A global org admin reaches everything; anyone else, the stores
 * they administer (storeScope.adminScopeOf) and the people in them.
 */
import { TRPCError } from '@trpc/server';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { inSystem, schema as s, type DB } from '@compass/db';
import { hasGlobalOrgAdmin } from '../../../services/orgAdmin';
import {
  adminScopeOf,
  adminStoresOf,
  loadScopedPermissions,
  type AdminScope,
} from '../../../services/storeScope';
import {
  bindingIsLive,
  getActorMaxGlobalRank,
  getActorMaxRank,
  getActorMaxRankInStore,
} from '../../../services/adminAuthority';
import type { RequestContext } from '../../context';

/**
 * D22 (2026-10-31, security scan F1): does this user also belong to
 * another organisation? The display name lives on the shared
 * `auth.users` row and shows in every organisation the person is in, so
 * an admin here must not rename (or lock) someone another organisation
 * also knows: only the person can. Any membership counts, suspended
 * included. Read across tenants the way catalogSourceMemberships reads
 * the caller's own memberships.
 */
export async function userInAnotherOrg(ctx: RequestContext, userId: string): Promise<boolean> {
  return (await usersInOtherOrgs(ctx, [userId])).has(userId);
}

/** userInAnotherOrg for several users at once (memberList, ADM1-06). */
export async function usersInOtherOrgs(
  ctx: RequestContext,
  userIds: string[],
): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await inSystem(ctx.db, 'auth', (tx) =>
    tx
      .selectDistinct({ userId: s.members.userId })
      .from(s.members)
      .innerJoin(s.organizations, eq(s.organizations.id, s.members.orgId))
      .where(
        and(
          inArray(s.members.userId, userIds),
          ne(s.members.orgId, ctx.session!.orgId),
          isNull(s.organizations.deletedAt),
        ),
      ),
  );
  return new Set(rows.map((r) => r.userId));
}

/**
 * C2 (2026-05-06): "store-scoped admins can only manage their stores".
 *
 * Returns the storeIds in which the actor is permitted to perform
 * admin-tier actions (invite a member, grant a role, assign a store).
 *
 *   - An admin-tier key (`users.manage`, `users.grant_role`) that holds
 *     organisation-wide makes the actor a "global admin": every active
 *     store in the org, except a store where overrides deny both.
 *   - Otherwise, the active stores where one holds. A store-scoped
 *     manager who holds `users.manage` in Store A only is gated to A.
 *   - `includeInactive` adds the paused and archived stores it covers.
 *   - Each scope resolves role grants, then allows, then denies (deny
 *     wins), per key: storeScope.adminScopeOf (ADM1-03).
 *
 * Returns an EMPTY array if the actor has no admin authority anywhere.
 * Callers (grantRole, memberInvite, memberAssignStore) check whether
 * the target storeId is in this set; mismatches throw FORBIDDEN.
 */
export async function getActorAdminStoreIds(
  tx: DB,
  orgId: string,
  actorUserId: string,
  opts: { includeInactive?: boolean } = {},
): Promise<string[]> {
  return storesAdministeredBy(tx, orgId, await getActorAdminScope(tx, orgId, actorUserId), opts);
}

/**
 * The actor's authority over people (storeScope.adminScopeOf, ADM1-03):
 * the one rule the session payload and invite acceptance use too. Null
 * when they are not a member.
 */
export async function getActorAdminScope(
  tx: DB,
  orgId: string,
  actorUserId: string,
): Promise<AdminScope | null> {
  const member = await tx.query.members.findFirst({
    where: (m, { eq: eq2, and: and2 }) => and2(eq2(m.orgId, orgId), eq2(m.userId, actorUserId)),
  });
  if (!member) return null;
  const { grants, overrides } = await loadScopedPermissions(tx, member.id);
  return adminScopeOf(grants, overrides);
}

/** The stores of `orgId` that `scope` manages people in (getActorAdminStoreIds). */
export async function storesAdministeredBy(
  tx: DB,
  orgId: string,
  scope: AdminScope | null,
  // R2-ADM-2: removing someone from a paused or archived store must stay
  // possible; adding them there must not. Only removals and reads pass
  // true; ADM1-16 (2026-11-10): for store admins too, whose list used to
  // keep archived stores for grants and invites.
  opts: { includeInactive?: boolean } = {},
): Promise<string[]> {
  if (!scope || (!scope.isGlobalAdmin && scope.storeIds.size === 0)) return [];
  const candidates = await tx
    .select({ id: s.stores.id })
    .from(s.stores)
    .where(
      and(
        eq(s.stores.orgId, orgId),
        opts.includeInactive ? undefined : eq(s.stores.isActive, true),
        scope.isGlobalAdmin ? undefined : inArray(s.stores.id, [...scope.storeIds]),
      ),
    );
  return adminStoresOf(
    scope,
    candidates.map((r) => r.id),
  );
}

/**
 * ADM-16 (2026-10-30): the refusal for a store outside the actor's admin
 * set. An archived store is outside everyone's set, and "you are not this
 * store's admin" sent people looking for a missing role; say it is archived.
 */
export async function notAdminOfStore(
  tx: DB,
  orgId: string,
  storeIds: string[],
): Promise<TRPCError> {
  if (storeIds.length > 0) {
    const archived = await tx
      .select({ id: s.stores.id })
      .from(s.stores)
      .where(
        and(
          eq(s.stores.orgId, orgId),
          inArray(s.stores.id, storeIds),
          eq(s.stores.isActive, false),
        ),
      )
      .limit(1);
    if (archived.length > 0) {
      return new TRPCError({ code: 'PRECONDITION_FAILED', message: 'auth.errors.storeArchived' });
    }
  }
  return new TRPCError({ code: 'FORBIDDEN', message: 'admin.errors.notAdminOfStore' });
}

/**
 * 2026-10-21 CA-17 (A-04): read scope of the admin console.
 *
 * `users.manage` is held by store managers, so every admin READ used to
 * show them the whole organisation (members with Telegram ids, other
 * stores' role holders, every domain event payload, the full admin
 * audit). Reads are now scoped the same way writes already were:
 *
 *   - null       → the actor holds GLOBAL `org.admin`; no filter.
 *   - Set<id>    → the stores the actor administers
 *                  (`getActorAdminStoreIds`); rows outside them are
 *                  hidden. Can be empty.
 */
export async function getAdminReadScope(
  tx: DB,
  session: { userId: string; memberId: string; orgId: string },
): Promise<Set<string> | null> {
  if (await hasGlobalOrgAdmin(tx, session.memberId)) return null;
  // Paused and archived stores too: their people can still be removed
  // (R2-ADM-2).
  return new Set(
    await getActorAdminStoreIds(tx, session.orgId, session.userId, { includeInactive: true }),
  );
}

/**
 * Members of the org that have an assignment or a store-scoped role
 * binding in any of `storeIds`, plus the actor themself (2026-10-21
 * CA-17). Only meaningful for a non-null read scope.
 */
export async function visibleMemberIds(
  tx: DB,
  storeIds: ReadonlySet<string>,
  selfMemberId: string,
): Promise<Set<string>> {
  const ids = new Set<string>([selfMemberId]);
  if (storeIds.size === 0) return ids;
  const list = [...storeIds];
  const [assigned, bound] = await Promise.all([
    tx
      .select({ memberId: s.memberStoreAssignments.memberId })
      .from(s.memberStoreAssignments)
      .where(inArray(s.memberStoreAssignments.storeId, list)),
    tx
      .select({ memberId: s.memberRoleBindings.memberId })
      .from(s.memberRoleBindings)
      .where(
        and(
          eq(s.memberRoleBindings.scopeType, 'store'),
          inArray(s.memberRoleBindings.scopeId, list),
          bindingIsLive(),
        ),
      ),
  ]);
  for (const r of [...assigned, ...bound]) ids.add(r.memberId);
  return ids;
}

/**
 * 2026-10-21 CA-19: may an actor with read scope `scope` see / revoke an
 * invite for `inviteStoreIds`? Org admins (null scope) see every invite.
 * Anyone else only sees invites whose stores they ALL administer; an
 * invite with no store is an org-tier (admin) invite and stays with org
 * admins.
 */
export function inviteWithinScope(
  inviteStoreIds: readonly string[],
  scope: ReadonlySet<string> | null,
): boolean {
  if (scope === null) return true;
  if (inviteStoreIds.length === 0) return false;
  return inviteStoreIds.every((id) => scope.has(id));
}

/**
 * 2026-10-21 CA-17: SQL predicate "run `runIdExpr` involves one of
 * `storeIds`" — an order of one of those stores was attached to it, or
 * it carries a per-store split for one of them. Empty list → false.
 */
export function runTouchesStores(
  runIdExpr: ReturnType<typeof sql>,
  storeIds: readonly string[],
): ReturnType<typeof sql> {
  if (storeIds.length === 0) return sql`false`;
  const ids = sql.join(
    storeIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  return sql`(${runIdExpr} IN (SELECT os.run_id FROM read_model.order_sessions_v os WHERE os.run_id IS NOT NULL AND os.store_id IN (${ids})) OR ${runIdExpr} IN (SELECT ris.run_id FROM read_model.run_item_stores_v ris WHERE ris.store_id IN (${ids})))`;
}

/**
 * Gate for suspending / reactivating a member.
 *
 *   - An org admin (global `org.admin`) may act on anyone strictly
 *     below their own org-wide rank: their global bindings alone
 *     (ADM1-01); the target counts every binding they hold.
 *   - Anyone else must administer EVERY store the target belongs to and
 *     outrank the target in each. A target with no store at all, or
 *     with a foot in a store the actor does not manage, is out of reach.
 */
export async function assertCanSetMemberStatus(
  tx: DB,
  session: { userId: string; memberId: string; orgId: string },
  target: { id: string; userId: string },
): Promise<void> {
  const { orgId } = session;
  if (await hasGlobalOrgAdmin(tx, session.memberId)) {
    const [targetRank, actorRank] = await Promise.all([
      getActorMaxRank(tx, orgId, target.userId),
      getActorMaxGlobalRank(tx, orgId, session.userId),
    ]);
    if (targetRank >= actorRank) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'auth.errors.cannotRevokeEqualOrHigher' });
    }
    return;
  }
  await assertAdministersEveryTargetStore(tx, session, target);
}

/**
 * Store-tier half of `assertCanSetMemberStatus`: the actor must
 * administer EVERY store the target belongs to (assignment or store
 * binding) and strictly outrank the target in each. Shared with
 * memberSetDisplayName (2026-10-21 audit CA-07).
 */
export async function assertAdministersEveryTargetStore(
  tx: DB,
  session: { userId: string; orgId: string },
  target: { id: string; userId: string },
): Promise<void> {
  const { orgId } = session;
  const [assignments, storeBindings, allowed] = await Promise.all([
    tx
      .select({ storeId: s.memberStoreAssignments.storeId })
      .from(s.memberStoreAssignments)
      .where(eq(s.memberStoreAssignments.memberId, target.id)),
    tx
      .select({ storeId: s.memberRoleBindings.scopeId })
      .from(s.memberRoleBindings)
      .where(
        and(
          eq(s.memberRoleBindings.memberId, target.id),
          eq(s.memberRoleBindings.scopeType, 'store'),
          bindingIsLive(),
        ),
      ),
    // ADM1-16: a paused or archived store the actor administers does not
    // block acting on the member; adding to it is what stays refused.
    getActorAdminStoreIds(tx, orgId, session.userId, { includeInactive: true }),
  ]);
  const targetStoreIds = new Set<string>();
  for (const row of [...assignments, ...storeBindings]) {
    if (row.storeId) targetStoreIds.add(row.storeId);
  }
  if (targetStoreIds.size === 0 || [...targetStoreIds].some((id) => !allowed.includes(id))) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'admin.errors.notAdminOfStore' });
  }
  for (const storeId of targetStoreIds) {
    const [targetRank, actorRank] = await Promise.all([
      getActorMaxRankInStore(tx, orgId, target.userId, storeId),
      getActorMaxRankInStore(tx, orgId, session.userId, storeId),
    ]);
    if (targetRank >= actorRank) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'auth.errors.cannotRevokeEqualOrHigher' });
    }
  }
}
