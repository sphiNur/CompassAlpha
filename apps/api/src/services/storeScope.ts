/**
 * Store-scope authorization helpers.
 *
 * A member may act only on stores they are assigned to through an explicit
 * member-store assignment or a store-scoped role binding. The sole bypass is
 * `org.admin`. `users.manage` is intentionally not a bypass: store managers
 * hold it to manage staff in their own stores.
 */
import { TRPCError } from '@trpc/server';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { DB } from '@compass/db';
import { schema as s } from '@compass/db';
import { hasGlobalOrgAdmin, hasGlobalPermission } from './orgAdmin';

/**
 * Throw FORBIDDEN unless the actor is allowed to act on `storeId`.
 *
 * Callers must first verify that the store belongs to the actor's org. This
 * function enforces the second boundary: membership within that org.
 */
export async function assertActorAssignedToStore(
  db: DB,
  memberId: string,
  storeId: string,
  permissions: ReadonlySet<string>,
): Promise<void> {
  const allowed = await getActorStoreIds(db, memberId, permissions);
  if (allowed === null || allowed.includes(storeId)) return;

  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'auth.errors.notAssignedToStore',
  });
}

/**
 * Return the store ids the actor may access, or null for an org-wide admin.
 *
 * Store membership has two sources:
 *   - `auth.member_store_assignments`
 *   - active store-scoped role bindings
 *
 * An empty array means the actor has no store access. Expired role bindings
 * are ignored here and by the permission resolver below.
 */
export async function getActorStoreIds(
  db: DB,
  memberId: string,
  _permissions: ReadonlySet<string>,
): Promise<string[] | null> {
  // Never infer the organization-wide bypass from a flat session set: that
  // set intentionally aggregates store-scoped permissions for UI affordance.
  // Resolve `org.admin` from its persisted global provenance instead.
  if (await hasGlobalOrgAdmin(db, memberId)) return null;

  return loadAssignedStoreIds(db, memberId);
}

/**
 * Highest active role rank that applies to one concrete store.
 *
 * This deliberately resolves persisted global + same-store bindings rather
 * than looking at the flattened session role/permission union: a person may
 * be a manager in Store A and a cashier in Store B. Expired bindings do not
 * contribute to the result.
 */
export async function getActorMaxActiveRoleRankInStore(
  db: DB,
  memberId: string,
  storeId: string,
): Promise<number> {
  const now = new Date();
  const rows = await db
    .select({ rank: s.roles.rank })
    .from(s.memberRoleBindings)
    .innerJoin(s.roles, eq(s.roles.id, s.memberRoleBindings.roleId))
    .where(
      and(
        eq(s.memberRoleBindings.memberId, memberId),
        or(
          eq(s.memberRoleBindings.scopeType, 'global'),
          and(
            eq(s.memberRoleBindings.scopeType, 'store'),
            eq(s.memberRoleBindings.scopeId, storeId),
          ),
        ),
        or(isNull(s.memberRoleBindings.expiresAt), gt(s.memberRoleBindings.expiresAt, now)),
      ),
    );
  return rows.reduce((highest, row) => Math.max(highest, row.rank), 0);
}

/**
 * Return the concrete stores where `permissionKey` is effective, or null
 * when the permission comes from an active GLOBAL binding/override.
 *
 * This is deliberately stricter than `getActorStoreIds`: session
 * permissions are a union used for UI affordances, while store membership
 * says only where somebody belongs. A member can be a manager in Store A
 * and ordinary staff in Store B; finance/history reads must not treat the
 * manager permission from A as effective in B.
 *
 * Global deny wins over global allow. Store-level resolution is delegated
 * to `effectivePermissionsForStore`, where global + store allows are also
 * applied before denies.
 */
export async function getActorStoreIdsForPermission(
  db: DB,
  memberId: string,
  permissionKey: string,
  permissions: ReadonlySet<string>,
): Promise<string[] | null> {
  const now = new Date();
  const [globalRoleRows, globalOverrides, storeOverrides] = await Promise.all([
    db
      .select({ permissionKey: s.rolePermissions.permissionKey })
      .from(s.memberRoleBindings)
      .innerJoin(s.rolePermissions, eq(s.rolePermissions.roleId, s.memberRoleBindings.roleId))
      .where(
        and(
          eq(s.memberRoleBindings.memberId, memberId),
          eq(s.memberRoleBindings.scopeType, 'global'),
          eq(s.rolePermissions.permissionKey, permissionKey),
          or(isNull(s.memberRoleBindings.expiresAt), gt(s.memberRoleBindings.expiresAt, now)),
        ),
      ),
    db
      .select({ effect: s.memberPermissionOverrides.effect })
      .from(s.memberPermissionOverrides)
      .where(
        and(
          eq(s.memberPermissionOverrides.memberId, memberId),
          eq(s.memberPermissionOverrides.scopeType, 'global'),
          eq(s.memberPermissionOverrides.permissionKey, permissionKey),
          or(
            isNull(s.memberPermissionOverrides.expiresAt),
            gt(s.memberPermissionOverrides.expiresAt, now),
          ),
        ),
      ),
    db
      .select({ scopeId: s.memberPermissionOverrides.scopeId })
      .from(s.memberPermissionOverrides)
      .where(
        and(
          eq(s.memberPermissionOverrides.memberId, memberId),
          eq(s.memberPermissionOverrides.scopeType, 'store'),
          eq(s.memberPermissionOverrides.permissionKey, permissionKey),
          or(
            isNull(s.memberPermissionOverrides.expiresAt),
            gt(s.memberPermissionOverrides.expiresAt, now),
          ),
        ),
      ),
  ]);

  let globallyAllowed = globalRoleRows.length > 0;
  if (globalOverrides.some((row) => row.effect === 'allow')) globallyAllowed = true;
  // A global deny applies inside every store and therefore defeats both
  // global and store-scoped allows (same deny-wins rule as the resolver).
  if (globalOverrides.some((row) => row.effect === 'deny')) return [];

  // A clean global grant is the only safe unrestricted fast path. If a
  // store override exists, enumerate every store in the member's org and
  // resolve each one so a Store-B deny cannot be bypassed by returning null.
  if (globallyAllowed && storeOverrides.length === 0) return null;

  const candidateStoreIds = globallyAllowed
    ? (
        await db
          .select({ storeId: s.stores.id })
          .from(s.stores)
          .innerJoin(s.members, eq(s.members.orgId, s.stores.orgId))
          .where(eq(s.members.id, memberId))
      ).map((row) => row.storeId)
    : await loadAssignedStoreIds(db, memberId);
  if (candidateStoreIds.length === 0) return [];

  const resolved = await Promise.all(
    candidateStoreIds.map(async (storeId) => ({
      storeId,
      permissions: await effectivePermissionsForStore(db, memberId, storeId, permissions),
    })),
  );
  return resolved.filter((row) => row.permissions.has(permissionKey)).map((row) => row.storeId);
}

/**
 * Resolve the stores where this actor may plan/extend a run.
 *
 * `SessionContext.permissions` is a compatibility union across every role
 * binding, so the presence of `run.create.org` there cannot prove an
 * organization-wide grant. Only an active persisted GLOBAL grant selects the
 * org-wide path. Both paths still go through the effective-permission resolver
 * so a store-scoped deny wins:
 *
 *   - GLOBAL `run.create.org` -> stores where `run.create.org` is effective
 *   - otherwise              -> stores where `run.create` is effective
 *
 * This also prevents an unrelated Store-B staff assignment from widening a
 * Store-A purchaser's planning scope.
 *
 * Review COREAPI-10 (2026-11): here rather than in the run router, which the
 * nav router imported it from.
 */
export async function resolveRunCreateStoreScope(
  db: DB,
  session: { memberId: string; permissions: ReadonlySet<string> },
): Promise<string[] | null> {
  const hasPersistedOrgGrant = await hasGlobalPermission(db, session.memberId, 'run.create.org');
  return getActorStoreIdsForPermission(
    db,
    session.memberId,
    hasPersistedOrgGrant ? 'run.create.org' : 'run.create',
    session.permissions,
  );
}

async function loadAssignedStoreIds(db: DB, memberId: string): Promise<string[]> {
  const now = new Date();
  const [msaRows, roleScopeRows] = await Promise.all([
    db
      .select({ storeId: s.memberStoreAssignments.storeId })
      .from(s.memberStoreAssignments)
      .where(eq(s.memberStoreAssignments.memberId, memberId)),
    db
      .select({ scopeId: s.memberRoleBindings.scopeId })
      .from(s.memberRoleBindings)
      .where(
        and(
          eq(s.memberRoleBindings.memberId, memberId),
          eq(s.memberRoleBindings.scopeType, 'store'),
          or(isNull(s.memberRoleBindings.expiresAt), gt(s.memberRoleBindings.expiresAt, now)),
        ),
      ),
  ]);

  const storeIds = new Set<string>();
  for (const row of msaRows) storeIds.add(row.storeId);
  for (const row of roleScopeRows) {
    if (row.scopeId) storeIds.add(row.scopeId);
  }
  return [...storeIds];
}

/**
 * Keys that mean authority over the whole organisation. Only a global role
 * binding or a global override yields them; the same key granted in one
 * store counts nowhere.
 *
 * - `org.admin`: the organisation-admin marker.
 * - `dishes.manage` (review CONF-04, 2026-11-09): dishes and recipes are
 *   shared by every store, and each store's sales deduct stock by the same
 *   recipe. A store-level grant let one store change the menu, the recipes
 *   and the selling prices of all of them, which M3.2 took away from store
 *   managers on purpose.
 */
export const ORG_WIDE_PERMISSION_KEYS: ReadonlySet<string> = new Set([
  'org.admin',
  'dishes.manage',
]);

/** Whether a grant of `key` at this scope counts at all. */
export function grantCounts(key: string, scopeType: string): boolean {
  return !ORG_WIDE_PERMISSION_KEYS.has(key) || scopeType === 'global';
}

/**
 * Compute permissions that apply to one concrete store.
 *
 * The session permission set is intentionally flat for client-side feature
 * affordances, but it cannot authorize a store-specific server action. A
 * member may be a manager of Store A and a staff member of Store B. Resolve
 * only active global bindings plus bindings scoped to `storeId`, then apply
 * active global and store-specific overrides. Allows are applied first and
 * denies second, so deny wins.
 */
export async function effectivePermissionsForStore(
  db: DB,
  memberId: string,
  storeId: string,
  _sessionPermissions: ReadonlySet<string>,
): Promise<ReadonlySet<string>> {
  const now = new Date();
  const [rolePermissionRows, overrides] = await Promise.all([
    db
      .select({
        permissionKey: s.rolePermissions.permissionKey,
        scopeType: s.memberRoleBindings.scopeType,
      })
      .from(s.memberRoleBindings)
      .innerJoin(s.rolePermissions, eq(s.rolePermissions.roleId, s.memberRoleBindings.roleId))
      .where(
        and(
          eq(s.memberRoleBindings.memberId, memberId),
          or(
            eq(s.memberRoleBindings.scopeType, 'global'),
            and(
              eq(s.memberRoleBindings.scopeType, 'store'),
              eq(s.memberRoleBindings.scopeId, storeId),
            ),
          ),
          or(isNull(s.memberRoleBindings.expiresAt), gt(s.memberRoleBindings.expiresAt, now)),
        ),
      ),
    db
      .select({
        permissionKey: s.memberPermissionOverrides.permissionKey,
        effect: s.memberPermissionOverrides.effect,
        scopeType: s.memberPermissionOverrides.scopeType,
      })
      .from(s.memberPermissionOverrides)
      .where(
        and(
          eq(s.memberPermissionOverrides.memberId, memberId),
          or(
            eq(s.memberPermissionOverrides.scopeType, 'global'),
            and(
              eq(s.memberPermissionOverrides.scopeType, 'store'),
              eq(s.memberPermissionOverrides.scopeId, storeId),
            ),
          ),
          or(
            isNull(s.memberPermissionOverrides.expiresAt),
            gt(s.memberPermissionOverrides.expiresAt, now),
          ),
        ),
      ),
  ]);

  // A store-scoped role/override must never yield org-wide authority, even
  // when a legacy row happens to carry an org-wide key.
  const effective = new Set(
    rolePermissionRows
      .filter((row) => grantCounts(row.permissionKey, row.scopeType))
      .map((row) => row.permissionKey),
  );
  for (const override of overrides) {
    if (
      override.effect === 'allow' &&
      override.permissionKey &&
      grantCounts(override.permissionKey, override.scopeType)
    ) {
      effective.add(override.permissionKey);
    }
  }
  for (const override of overrides) {
    if (
      override.effect === 'deny' &&
      override.permissionKey &&
      grantCounts(override.permissionKey, override.scopeType)
    ) {
      effective.delete(override.permissionKey);
    }
  }
  return effective;
}

/**
 * DX-ADM-2 (2026-11-01): keys the member holds everywhere in the
 * organisation — what an org-wide change (a role's key list) may hand on.
 * Only global bindings and global allows count; a global deny removes a
 * key, and so does a deny in any one store, since an org-wide role would
 * carry the key into that store too. The flat session set was used
 * before: a key from one store's custom role let an admin add it to the
 * built-in manager role for every store.
 */
export async function effectiveGlobalPermissions(db: DB, memberId: string): Promise<Set<string>> {
  const now = new Date();
  const [roleRows, overrides] = await Promise.all([
    db
      .select({ permissionKey: s.rolePermissions.permissionKey })
      .from(s.memberRoleBindings)
      .innerJoin(s.rolePermissions, eq(s.rolePermissions.roleId, s.memberRoleBindings.roleId))
      .where(
        and(
          eq(s.memberRoleBindings.memberId, memberId),
          eq(s.memberRoleBindings.scopeType, 'global'),
          or(isNull(s.memberRoleBindings.expiresAt), gt(s.memberRoleBindings.expiresAt, now)),
        ),
      ),
    db
      .select({
        permissionKey: s.memberPermissionOverrides.permissionKey,
        effect: s.memberPermissionOverrides.effect,
        scopeType: s.memberPermissionOverrides.scopeType,
      })
      .from(s.memberPermissionOverrides)
      .where(
        and(
          eq(s.memberPermissionOverrides.memberId, memberId),
          or(
            isNull(s.memberPermissionOverrides.expiresAt),
            gt(s.memberPermissionOverrides.expiresAt, now),
          ),
        ),
      ),
  ]);
  const effective = new Set(roleRows.map((row) => row.permissionKey));
  for (const o of overrides) {
    if (o.effect === 'allow' && o.scopeType === 'global' && o.permissionKey) {
      effective.add(o.permissionKey);
    }
  }
  for (const o of overrides) {
    if (o.effect === 'deny' && o.permissionKey) effective.delete(o.permissionKey);
  }
  return effective;
}

/**
 * Assert a permission in the context of one store. This is kept separate
 * from store membership because callers sometimes need to distinguish a
 * missing permission from access to the wrong store.
 */
export async function assertHasPermissionInStore(
  db: DB,
  memberId: string,
  permKey: string,
  storeId: string,
  permissions: ReadonlySet<string>,
): Promise<void> {
  const effective = await effectivePermissionsForStore(db, memberId, storeId, permissions);
  if (effective.has(permKey)) return;

  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'auth.errors.missingPermission',
    cause: { missingPermission: permKey },
  });
}

/** Add a store assignment if it does not already exist. */
export async function assignMemberToStore(
  db: DB,
  memberId: string,
  storeId: string,
  assignedByUserId: string,
): Promise<void> {
  await db
    .insert(s.memberStoreAssignments)
    .values({ memberId, storeId, assignedBy: assignedByUserId })
    .onConflictDoNothing();
}

/** Remove a store assignment. Idempotent. */
export async function unassignMemberFromStore(
  db: DB,
  memberId: string,
  storeId: string,
): Promise<void> {
  await db
    .delete(s.memberStoreAssignments)
    .where(
      and(
        eq(s.memberStoreAssignments.memberId, memberId),
        eq(s.memberStoreAssignments.storeId, storeId),
      ),
    );
}

/** A permission key granted by a role binding or an override, with its scope. */
export interface ScopedPermission {
  key: string;
  scopeType: string;
  scopeId: string | null;
}

/**
 * The flat permission set: every key that is effective in at least one
 * scope — globally, or in some store. Each scope resolves like
 * `effectivePermissionsForStore`: global + that store's role grants, then
 * allows, then denies (deny wins); an org-wide key only ever from a global
 * row (`ORG_WIDE_PERMISSION_KEYS`).
 *
 * ADM-1/2/3 (2026-10-30): the server's session set ignored overrides (a
 * global deny of users.manage still passed every admin gate; a global
 * allow showed the Manage tab, then every page refused), and the client's
 * set applied a deny in ONE store as if it were global (a manager of two
 * stores denied in one lost Manage entirely). Both now use this.
 */
export function flatEffectivePermissions(
  grants: readonly ScopedPermission[],
  overrides: readonly (ScopedPermission & { effect: string })[],
): Set<string> {
  const { stores, resolve } = scopeResolver(grants, overrides);
  const flat = resolve(null);
  for (const storeId of stores) for (const key of resolve(storeId)) flat.add(key);
  return flat;
}

/**
 * The stores the rows name, and the effective keys of one scope: the
 * organisation (`null`, global rows only) or one store (global rows plus
 * that store's). Grants, then allows, then denies, so deny wins.
 */
function scopeResolver(
  grants: readonly ScopedPermission[],
  overrides: readonly (ScopedPermission & { effect: string })[],
): { stores: ReadonlySet<string>; resolve: (storeId: string | null) => Set<string> } {
  const stores = new Set<string>();
  for (const row of [...grants, ...overrides]) {
    if (row.scopeType === 'store' && row.scopeId) stores.add(row.scopeId);
  }
  const applies = (row: ScopedPermission, storeId: string | null) =>
    row.scopeType === 'global' ||
    (storeId !== null && row.scopeType === 'store' && row.scopeId === storeId);
  const usable = (row: ScopedPermission) => Boolean(row.key) && grantCounts(row.key, row.scopeType);
  const resolve = (storeId: string | null): Set<string> => {
    const effective = new Set<string>();
    for (const g of grants) if (applies(g, storeId) && usable(g)) effective.add(g.key);
    for (const o of overrides) {
      if (o.effect === 'allow' && applies(o, storeId) && usable(o)) effective.add(o.key);
    }
    for (const o of overrides) {
      if (o.effect === 'deny' && applies(o, storeId) && usable(o)) effective.delete(o.key);
    }
    return effective;
  };
  return { stores, resolve };
}

/** What a role gives in one scope, and what holds there after overrides. */
export interface ScopeKeys {
  roleKeys: string[];
  effective: string[];
}

/**
 * Review ADM1-05 (2026-11-10): a member's keys per scope, for the
 * permissions screen: the organisation, and each store the rows name (a
 * store no row names is the organisation's). It used to show one union
 * of every binding on every tab, so a manager of A who is staff in B read
 * "from role" for order.approve on B's tab, and a deny in one store
 * counted everywhere.
 */
export function permissionsByScope(
  grants: readonly ScopedPermission[],
  overrides: readonly (ScopedPermission & { effect: string })[],
): { global: ScopeKeys; stores: Record<string, ScopeKeys> } {
  const fromRoles = scopeResolver(grants, []);
  const withOverrides = scopeResolver(grants, overrides);
  const at = (storeId: string | null): ScopeKeys => ({
    roleKeys: [...fromRoles.resolve(storeId)].sort(),
    effective: [...withOverrides.resolve(storeId)].sort(),
  });
  const stores: Record<string, ScopeKeys> = {};
  for (const storeId of withOverrides.stores) stores[storeId] = at(storeId);
  return { global: at(null), stores };
}

/**
 * The keys that give authority over people. `users.invite`, listed with
 * them in the three old copies, was never a key of the catalog.
 */
export const ADMIN_TIER_KEYS: ReadonlySet<string> = new Set(['users.manage', 'users.grant_role']);

/** Where a member has authority over people (adminScopeOf). */
export interface AdminScope {
  /** users.manage is effective in some scope (what requireAdmin asks). */
  hasUsersManage: boolean;
  /** An admin-tier key holds organisation-wide: every store but `deniedStoreIds`. */
  isGlobalAdmin: boolean;
  /** Stores a row names where an admin-tier key holds. */
  storeIds: ReadonlySet<string>;
  /** Stores a row names where none holds; they limit a global admin. */
  deniedStoreIds: ReadonlySet<string>;
}

/**
 * Review ADM1-03 / COREAPI-08 (2026-11-10): one rule for "which stores may
 * this member manage people in", used by the session payload, the admin
 * router and invite acceptance. There were three copies. Two walked the
 * overrides in database order, so an allow and a deny for the same store
 * gave either answer, and all three dropped a store (or global authority)
 * when ANY admin-tier key was denied, even with another one still held.
 * Each scope now resolves like `effectivePermissionsForStore` and counts
 * when an admin-tier key survives; a store deny also limits a global
 * admin, as it does for every per-store check.
 */
export function adminScopeOf(
  grants: readonly ScopedPermission[],
  overrides: readonly (ScopedPermission & { effect: string })[],
): AdminScope {
  const { stores, resolve } = scopeResolver(grants, overrides);
  const holdsAdminKey = (keys: ReadonlySet<string>) =>
    [...ADMIN_TIER_KEYS].some((key) => keys.has(key));
  const storeIds = new Set<string>();
  const deniedStoreIds = new Set<string>();
  for (const storeId of stores) {
    (holdsAdminKey(resolve(storeId)) ? storeIds : deniedStoreIds).add(storeId);
  }
  return {
    hasUsersManage: flatEffectivePermissions(grants, overrides).has('users.manage'),
    isGlobalAdmin: holdsAdminKey(resolve(null)),
    storeIds,
    deniedStoreIds,
  };
}

/**
 * Which of `candidates` (stores of the organisation, e.g. the active ones)
 * `scope` manages people in: a global admin all but the denied ones,
 * anyone else those in `scope.storeIds`.
 */
export function adminStoresOf(scope: AdminScope, candidates: readonly string[]): string[] {
  return candidates.filter((id) =>
    scope.isGlobalAdmin ? !scope.deniedStoreIds.has(id) : scope.storeIds.has(id),
  );
}

/**
 * The live role grants and overrides of one member, as adminScopeOf and
 * flatEffectivePermissions take them.
 */
export async function loadScopedPermissions(
  db: DB,
  memberId: string,
): Promise<{
  grants: ScopedPermission[];
  overrides: (ScopedPermission & { effect: string })[];
}> {
  const now = new Date();
  const [grants, overrides] = await Promise.all([
    db
      .select({
        key: s.rolePermissions.permissionKey,
        scopeType: s.memberRoleBindings.scopeType,
        scopeId: s.memberRoleBindings.scopeId,
      })
      .from(s.memberRoleBindings)
      .innerJoin(s.rolePermissions, eq(s.rolePermissions.roleId, s.memberRoleBindings.roleId))
      .where(
        and(
          eq(s.memberRoleBindings.memberId, memberId),
          or(isNull(s.memberRoleBindings.expiresAt), gt(s.memberRoleBindings.expiresAt, now)),
        ),
      ),
    db
      .select({
        key: s.memberPermissionOverrides.permissionKey,
        effect: s.memberPermissionOverrides.effect,
        scopeType: s.memberPermissionOverrides.scopeType,
        scopeId: s.memberPermissionOverrides.scopeId,
      })
      .from(s.memberPermissionOverrides)
      .where(
        and(
          eq(s.memberPermissionOverrides.memberId, memberId),
          or(
            isNull(s.memberPermissionOverrides.expiresAt),
            gt(s.memberPermissionOverrides.expiresAt, now),
          ),
        ),
      ),
  ]);
  return { grants, overrides };
}

/**
 * HIS-19 (2026-10-30): finance is read with `reports.view`, the key the
 * roles carry for it. `users.manage` keeps working so no one who sees
 * finance today loses it; the readable stores are the union of both.
 */
export const FINANCE_KEYS = ['reports.view', 'users.manage'] as const;

export async function financeStoreIds(
  db: DB,
  session: { memberId: string; permissions: ReadonlySet<string> },
): Promise<string[] | null> {
  const union = new Set<string>();
  for (const key of FINANCE_KEYS) {
    const ids = await getActorStoreIdsForPermission(db, session.memberId, key, session.permissions);
    if (ids === null) return null;
    for (const id of ids) union.add(id);
  }
  return [...union];
}
