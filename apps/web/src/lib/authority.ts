/**
 * CMP-ADM-1 (2026-10-31): the server's rules for managing people, mirrored
 * so the People screen offers only what the server will accept. A store
 * manager could tap × on their own "manager" role, confirm, and only then
 * get "you cannot revoke a role at or above your own level"; suspend,
 * transfer and the permission overrides had the same gap.
 *
 * Each function names the server check it mirrors (apps/api/src/trpc/
 * routers/admin.ts). The server stays the authority: these only decide
 * what is shown, and when a rank is unknown (an older server) the action
 * is shown and the server answers as before.
 */
import { ADMIN_RANK } from '@compass/contracts/schemas/roles';

/** A role binding as the member list returns it. */
export interface Binding {
  slug: string;
  scopeType: string;
  scopeId: string | null;
  /** Absent from servers older than CMP-ADM-1. */
  rank?: number;
}

/** The signed-in person, as far as these rules need. */
export interface Actor {
  userId: string;
  /** Holds `org.admin` (organisation-wide authority). */
  isOrgAdmin: boolean;
  /** Stores where the actor may manage people (session.adminStoreIds). */
  adminStoreIds: readonly string[];
  /** The actor's own role bindings (their row in the member list). */
  bindings: readonly Binding[];
}

export interface TargetMember {
  userId: string;
  bindings: readonly Binding[];
  /** Every store the member is in (assignments and store bindings). */
  storeIds: readonly string[];
}

const UNKNOWN = Number.POSITIVE_INFINITY;

/**
 * Highest rank among the bindings that count in a scope: organisation-wide
 * (`storeId` null) every binding counts — getActorMaxRank; in a store,
 * global bindings and that store's — getActorMaxRankInStore. Infinity
 * when a counted binding has no rank (older server: undecidable).
 */
export function rankIn(bindings: readonly Binding[], storeId: string | null): number {
  let max = 0;
  for (const b of bindings) {
    const counts = storeId === null || b.scopeType === 'global' || b.scopeId === storeId;
    if (!counts) continue;
    if (b.rank === undefined) return UNKNOWN;
    if (b.rank > max) max = b.rank;
  }
  return max;
}

/** Actor strictly outranks the target in the scope; unknown ranks pass. */
function outranks(actorRank: number, targetRank: number): boolean {
  if (actorRank === UNKNOWN || targetRank === UNKNOWN) return true;
  return targetRank < actorRank;
}

function administers(actor: Actor, storeId: string): boolean {
  return actor.adminStoreIds.includes(storeId);
}

/** revokeRole: not one's own admin roles; admin of the binding's store; outrank it there. */
export function canRevokeRole(actor: Actor, targetUserId: string, binding: Binding): boolean {
  if (targetUserId === actor.userId && (binding.slug === 'super_admin' || binding.slug === 'admin')) {
    return false;
  }
  const storeId = binding.scopeType === 'store' ? binding.scopeId : null;
  if (storeId && !administers(actor, storeId)) return false;
  if (binding.rank === undefined) return true;
  return outranks(rankIn(actor.bindings, storeId), binding.rank);
}

/**
 * memberSetStatus (assertCanSetMemberStatus): never suspend oneself. An
 * organisation admin needs to outrank the member organisation-wide;
 * anyone else must administer every store the member is in and outrank
 * them in each.
 */
export function canSetStatus(
  actor: Actor,
  target: TargetMember,
  next: 'active' | 'suspended',
): boolean {
  if (target.userId === actor.userId) return next !== 'suspended';
  if (actor.isOrgAdmin) {
    return outranks(rankIn(actor.bindings, null), rankIn(target.bindings, null));
  }
  if (target.storeIds.length === 0) return false;
  return target.storeIds.every(
    (id) =>
      administers(actor, id) && outranks(rankIn(actor.bindings, id), rankIn(target.bindings, id)),
  );
}

/**
 * grantRole: organisation-tier roles (rank ≥ ADMIN_RANK) only globally and
 * only by an organisation admin; store roles only in a store the actor
 * manages; and always strictly below the actor's rank in that scope.
 */
export function canGrantRole(
  actor: Actor,
  role: { rank: number },
  scope: { type: 'global' } | { type: 'store'; storeId: string },
): boolean {
  if (scope.type === 'global') {
    if (!actor.isOrgAdmin || role.rank < ADMIN_RANK) return false;
    return outranks(rankIn(actor.bindings, null), role.rank);
  }
  if (role.rank >= ADMIN_RANK || !administers(actor, scope.storeId)) return false;
  return outranks(rankIn(actor.bindings, scope.storeId), role.rank);
}

/** Where the actor may hand a role on as far as its keys go (roleList `passOn`). */
export interface PassOn {
  global: boolean;
  storeIds: readonly string[];
}

/**
 * D8 key rule (missingRoleKey): a custom role carries only keys the actor
 * holds where the binding applies. DX-ADM-1: the grant, default-role and
 * invite lists hid nothing on this and learnt it from a 403. A role from
 * an older server without `passOn` passes; the server still decides.
 */
export function rolePassesOn(
  role: { passOn?: PassOn },
  scope: { type: 'global' } | { type: 'store'; storeId: string },
): boolean {
  if (!role.passOn) return true;
  return scope.type === 'global'
    ? role.passOn.global
    : role.passOn.storeIds.includes(scope.storeId);
}

/**
 * memberTransferStore: the actor manages both stores and outranks the
 * member in the one they leave. Destinations are stores the member is
 * not in already (CMP-ADM-18: "transfer" to a store they were in did
 * nothing useful).
 */
export function transferTargets<S extends { id: string }>(
  actor: Actor,
  target: TargetMember,
  fromStoreId: string,
  stores: readonly S[],
): S[] {
  if (!administers(actor, fromStoreId)) return [];
  if (!outranks(rankIn(actor.bindings, fromStoreId), rankIn(target.bindings, fromStoreId))) {
    return [];
  }
  return stores.filter(
    (st) => st.id !== fromStoreId && administers(actor, st.id) && !target.storeIds.includes(st.id),
  );
}

/**
 * memberPermissionSet / memberPermissionRevoke: an organisation-wide
 * exception needs an organisation admin, a store one the store's manager;
 * either way the actor outranks the member in that scope.
 */
export function canSetOverride(actor: Actor, target: TargetMember, storeId: string | null): boolean {
  if (storeId === null ? !actor.isOrgAdmin : !administers(actor, storeId)) return false;
  return outranks(rankIn(actor.bindings, storeId), rankIn(target.bindings, storeId));
}
