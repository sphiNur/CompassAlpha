/**
 * Store-scope authorization helpers.
 *
 * Ground rule: a member can only act on a store they are explicitly
 * assigned to via `auth.member_store_assignments`. Two bypasses:
 *   1. Members with `users.manage` permission (admin / super_admin) —
 *      they need to be able to fix things across the org.
 *   2. Aggregate views like the purchaser cockpit and the audit log
 *      that already gate on a separate permission and never write to
 *      a single store directly. They don't call this helper.
 *
 * Used from order / delivery routers. RLS is the floor of safety; this
 * is the application-level door that blocks "valid org but wrong store".
 */
import { TRPCError } from '@trpc/server';
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import type { DB } from '@compass/db';
import { schema as s } from '@compass/db';

/**
 * Throw FORBIDDEN unless the actor is allowed to act on `storeId`.
 *
 * Caller must have already verified the storeId belongs to the actor's
 * org (cross-tenant guard) — this helper only enforces the per-store
 * subscription within an org.
 *
 * "Allowed" means EITHER:
 *   - explicit row in `auth.member_store_assignments`, or
 *   - a store-scoped role binding (`scope_type='store'`, `scope_id=storeId`)
 *     in `auth.member_role_bindings` (added 2026-05-05 — managers grant
 *     scope through their role binding, not always through MSA).
 */
export async function assertActorAssignedToStore(
  db: DB,
  memberId: string,
  storeId: string,
  permissions: ReadonlySet<string>,
): Promise<void> {
  // Admins / super_admins bypass — they need to be able to fix orders
  // for any store when staff escalate an issue.
  if (permissions.has('users.manage')) return;

  const allowed = await getActorStoreIds(db, memberId, permissions);
  if (allowed === null) return; // unrestricted (admin path; defensive)
  if (allowed.includes(storeId)) return;

  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'auth.errors.notAssignedToStore',
  });
}

/**
 * Return the set of storeIds the actor can act on.
 *
 *   - Admin / super_admin: returns `null` (= unrestricted; caller should
 *     skip the WHERE filter entirely).
 *   - Everyone else: returns the union of
 *       (a) explicit `member_store_assignments` rows, AND
 *       (b) store-scoped role bindings (`scope_id` from
 *           `member_role_bindings WHERE scope_type='store'`).
 *
 * Why both sources:
 *   - MSA is the canonical "this human works here" record (used for
 *     bot routing, store selector, etc.).
 *   - Role bindings carry their own scope so a manager granted "manager
 *     of Store B" gains Store B even if MSA didn't have it. Previously
 *     that path only worked if admin remembered to ALSO add an MSA row,
 *     which a real admin frequently forgot.
 *
 * Empty array means "they have no stores anywhere" → list endpoints
 * should return `[]` without further DB hits.
 *
 * Used by `pendingList` and similar list endpoints to filter at the SQL
 * layer instead of fetching everything and rejecting per-row.
 */
export async function getActorStoreIds(
  db: DB,
  memberId: string,
  permissions: ReadonlySet<string>,
): Promise<string[] | null> {
  if (permissions.has('users.manage')) return null;

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
        ),
      ),
  ]);

  const set = new Set<string>();
  for (const r of msaRows) set.add(r.storeId);
  for (const r of roleScopeRows) {
    if (r.scopeId) set.add(r.scopeId);
  }
  return [...set];
}

/**
 * Compute the effective permission set for `memberId` operating on
 * `storeId` (added 2026-05-06).
 *
 * Starts from the flat session permissions (already reflects role
 * grants + GLOBAL allow/deny overrides) and layers in store-scoped
 * overrides:
 *   - any 'allow' override for (member, key, store) → adds the key
 *   - any 'deny' override for (member, key, store) → removes the key
 *
 * Admins (`users.manage` in the flat set) bypass — they keep their
 * full permission set regardless of store-scoped overrides.
 *
 * Returns a NEW ReadonlySet so the caller can pass it into the
 * domain layer's actor context without affecting the original
 * session-level set.
 */
export async function effectivePermissionsForStore(
  db: DB,
  memberId: string,
  storeId: string,
  sessionPermissions: ReadonlySet<string>,
): Promise<ReadonlySet<string>> {
  if (sessionPermissions.has('users.manage')) {
    return sessionPermissions;
  }
  const overrides = await db
    .select({
      permissionKey: s.memberPermissionOverrides.permissionKey,
      effect: s.memberPermissionOverrides.effect,
    })
    .from(s.memberPermissionOverrides)
    .where(
      and(
        eq(s.memberPermissionOverrides.memberId, memberId),
        eq(s.memberPermissionOverrides.scopeType, 'store'),
        eq(s.memberPermissionOverrides.scopeId, storeId),
        or(
          isNull(s.memberPermissionOverrides.expiresAt),
          gt(s.memberPermissionOverrides.expiresAt, new Date()),
        ),
      ),
    );
  if (overrides.length === 0) return sessionPermissions;
  const next = new Set(sessionPermissions);
  // Apply allow first (additive), then deny (subtractive). Deny wins.
  for (const o of overrides) {
    if (o.effect === 'allow' && o.permissionKey) next.add(o.permissionKey);
  }
  for (const o of overrides) {
    if (o.effect === 'deny' && o.permissionKey) next.delete(o.permissionKey);
  }
  return next;
}

/**
 * Per-store permission check (added 2026-05-06).
 *
 * Layered on top of the flat session permissions:
 *   - The session payload already contains the union of role-derived
 *     perms + global allow/deny overrides (handled in
 *     `buildSessionPayload`). The FE uses these for UI gating.
 *   - This helper additionally checks `auth.member_permission_overrides`
 *     rows scoped to a SPECIFIC store. So a manager who has
 *     `order.approve` from their role but a `deny` override
 *     scope_type='store' scope_id=<store B> should NOT be able to
 *     approve orders from store B even though their session.permissions
 *     includes 'order.approve'.
 *
 * Resolution at call time:
 *   1. Start from the actor's flat session permissions (already
 *      reflects role + global overrides).
 *   2. Check store-scoped overrides for this (member, key, store):
 *      - if 'deny' exists (and not expired) → reject
 *      - if 'allow' exists → grant (even if flat set lacks the key)
 *   3. Fall back to flat session permission set.
 *
 * `users.manage` (admin) bypasses store-scope override too — admins
 * are explicitly above the per-store rules. This mirrors the bypass
 * already in `assertActorAssignedToStore`.
 *
 * Throws FORBIDDEN if denied. Side-effect-free otherwise.
 */
export async function assertHasPermissionInStore(
  db: DB,
  memberId: string,
  permKey: string,
  storeId: string,
  permissions: ReadonlySet<string>,
): Promise<void> {
  // Admin bypass — same rationale as assertActorAssignedToStore.
  if (permissions.has('users.manage')) return;

  // Look up store-scoped override for THIS member + key + store.
  // Filter expired overrides — `expires_at IS NULL OR expires_at > now()`.
  const override = await db
    .select({
      effect: s.memberPermissionOverrides.effect,
    })
    .from(s.memberPermissionOverrides)
    .where(
      and(
        eq(s.memberPermissionOverrides.memberId, memberId),
        eq(s.memberPermissionOverrides.permissionKey, permKey),
        eq(s.memberPermissionOverrides.scopeType, 'store'),
        eq(s.memberPermissionOverrides.scopeId, storeId),
        or(
          isNull(s.memberPermissionOverrides.expiresAt),
          gt(s.memberPermissionOverrides.expiresAt, new Date()),
        ),
      ),
    )
    .limit(1);

  // Explicit deny wins.
  if (override[0]?.effect === 'deny') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `auth.errors.missingPermission:${permKey}`,
    });
  }
  // Explicit store-scoped allow grants the perm even if the flat set
  // doesn't have it. (E.g., a staff member granted `order.approve`
  // only at their home store.)
  if (override[0]?.effect === 'allow') return;

  // No store-scoped override → fall back to the flat set.
  if (!permissions.has(permKey)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `auth.errors.missingPermission:${permKey}`,
    });
  }
}

/**
 * Add (or no-op if already there) a store assignment for a member.
 * Used by the admin panel's "Assign store" UI and by `memberInviteByTgId`
 * during invite. Records the assigning user for audit.
 */
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

/**
 * Remove a store assignment. Idempotent.
 */
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
