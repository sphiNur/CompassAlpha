/**
 * Resolve the one permission that grants organization-wide store access.
 *
 * `org.admin` is meaningful only when it comes from a global role binding
 * or a global per-member override. Store-scoped roles and overrides may
 * contain other permissions, but must never turn into an organization-wide
 * bypass when their flat session permissions are assembled.
 */
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { DB } from '@compass/db';
import { schema as s } from '@compass/db';

/**
 * Resolve one permission strictly from active GLOBAL persisted grants.
 *
 * The session permission set is intentionally a union across scopes, so it
 * cannot prove that an organization-wide capability came from an
 * organization-wide binding. Global overrides follow the usual deny-wins
 * contract. Store overrides are applied separately when an operation touches
 * concrete stores.
 */
export async function hasGlobalPermission(
  db: DB,
  memberId: string,
  permissionKey: string,
): Promise<boolean> {
  const now = new Date();
  const [roleGrants, overrides] = await Promise.all([
    db
      .select({ id: s.memberRoleBindings.id })
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
          eq(s.memberPermissionOverrides.permissionKey, permissionKey),
          eq(s.memberPermissionOverrides.scopeType, 'global'),
          or(
            isNull(s.memberPermissionOverrides.expiresAt),
            gt(s.memberPermissionOverrides.expiresAt, now),
          ),
        ),
      ),
  ]);

  let granted = roleGrants.length > 0;
  // Allow first, then deny, matching the effective-permission contract used
  // throughout the app. (The uniqueness constraint normally permits at most
  // one row here, but the two passes keep this safe for historical data.)
  for (const override of overrides) {
    if (override.effect === 'allow') granted = true;
  }
  for (const override of overrides) {
    if (override.effect === 'deny') granted = false;
  }
  return granted;
}

export async function hasGlobalOrgAdmin(db: DB, memberId: string): Promise<boolean> {
  return hasGlobalPermission(db, memberId, 'org.admin');
}
