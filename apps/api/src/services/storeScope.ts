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
import { hasGlobalOrgAdmin } from './orgAdmin';

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
          or(
            isNull(s.memberRoleBindings.expiresAt),
            gt(s.memberRoleBindings.expiresAt, now),
          ),
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
      .innerJoin(
        s.rolePermissions,
        eq(s.rolePermissions.roleId, s.memberRoleBindings.roleId),
      )
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
          or(
            isNull(s.memberRoleBindings.expiresAt),
            gt(s.memberRoleBindings.expiresAt, now),
          ),
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
  // when a legacy row happens to carry the `org.admin` key.
  const effective = new Set(
    rolePermissionRows
      .filter((row) => row.permissionKey !== 'org.admin' || row.scopeType === 'global')
      .map((row) => row.permissionKey),
  );
  for (const override of overrides) {
    if (
      override.effect === 'allow' &&
      override.permissionKey &&
      (override.permissionKey !== 'org.admin' || override.scopeType === 'global')
    ) {
      effective.add(override.permissionKey);
    }
  }
  for (const override of overrides) {
    if (
      override.effect === 'deny' &&
      override.permissionKey &&
      (override.permissionKey !== 'org.admin' || override.scopeType === 'global')
    ) {
      effective.delete(override.permissionKey);
    }
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
  const effective = await effectivePermissionsForStore(
    db,
    memberId,
    storeId,
    permissions,
  );
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
