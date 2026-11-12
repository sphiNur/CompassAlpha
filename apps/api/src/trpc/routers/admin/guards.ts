/**
 * The permission checks the admin procedures start with. A refusal is
 * FORBIDDEN with `auth.errors.missingPermission`; the missing key goes in
 * the error's cause, for the log.
 */
import { TRPCError } from '@trpc/server';
import { hasGlobalOrgAdmin } from '../../../services/orgAdmin';
import type { PermissionKey } from '@compass/db';
import type { RequestContext } from '../../context';

export function requireAdmin(perms: ReadonlySet<string>): void {
  if (!perms.has('users.manage')) {
    // M1.9-extra (P7, 2026-05-07): was
    // 'auth.errors.missingPermission:users.manage' — the colon suffix
    // broke the dot-camelCase contract every other key follows, so
    // the FE errToast helper couldn't translate it cleanly. The
    // missing perm name is implementation detail; the user-facing
    // message is generic. The actual perm goes into TRPCError.cause
    // for log forensics.
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'auth.errors.missingPermission',
      cause: { missingPermission: 'users.manage' },
    });
  }
}

/**
 * Org-tier admin gate (M3.3, 2026-05-15).
 *
 * `requireAdmin` accepts `users.manage`, which is the admin-tier
 * marker for tasks that legitimately span store + org (member
 * invitation, role granting, etc.). Manager (rank 60) holds it too
 * since M1.9 so store managers can invite their own staff.
 *
 * That overload makes `users.manage` unsuitable as a gate for
 * mutations that affect the entire org — catalog (SKU, supplier,
 * category), role definitions, org settings, store create/delete.
 * Manager has authority over THEIR stores, not over org-wide rows.
 *
 * `org.admin` is granted only to admin + super_admin (via seed +
 * migration 0022 for existing orgs). Custom roles ranked ≥ 80 can
 * be granted it explicitly. Manager never has it.
 *
 * Use this helper at every mutation that:
 *   - writes/deletes a row outside any single store's scope
 *   - changes the org's role catalog
 *   - touches finance / settings that apply chain-wide
 *
 * Keep using `requireAdmin` for store-scoped admin work where the
 * per-store gates (`getActorAdminStoreIds`, C2) already constrain
 * the cross-store reach.
 */
export function requireOrgAdmin(perms: ReadonlySet<string>): void {
  if (!perms.has('org.admin')) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'auth.errors.missingPermission',
      cause: { missingPermission: 'org.admin' },
    });
  }
}

/**
 * org.admin from a GLOBAL grant in the current organisation. The session
 * permission set is a union across scopes, so it alone can't prove an
 * org-wide grant (see services/orgAdmin.ts).
 */
export async function requireGlobalOrgAdmin(ctx: RequestContext): Promise<void> {
  requireOrgAdmin(ctx.session!.permissions);
  const ok = await ctx.withOrg((tx) => hasGlobalOrgAdmin(tx, ctx.session!.memberId));
  if (!ok) requireOrgAdmin(new Set());
}

/**
 * Passes when the caller holds any of `keys`: the legacy coarse
 * `users.manage` or the specific key, so roles that carry only
 * `users.manage` keep working where a granular key now exists.
 */
export function requireOneOf(perms: ReadonlySet<string>, keys: PermissionKey[]): void {
  for (const k of keys) {
    if (perms.has(k)) return;
  }
  // M1.9-extra (P7): same shape as requireAdmin — generic
  // user-facing message, missing perms in cause for forensics.
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'auth.errors.missingPermission',
    cause: { missingPermissionAny: keys },
  });
}

/**
 * ADM-4 (2026-10-30): putting a key into a role hands it to everyone the
 * role is granted to, so the actor must hold it, as memberPermissionSet
 * already requires for a single allow. An admin used to be able to mint
 * a role with super-admin keys and grant it to themselves.
 */
export function assertHoldsKeys(perms: ReadonlySet<string>, keys: Iterable<string>): void {
  for (const key of keys) {
    if (!perms.has(key)) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'auth.errors.missingPermission' });
    }
  }
}
