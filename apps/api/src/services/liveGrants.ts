/**
 * A role binding or a per-member override whose expiry has passed grants
 * nothing. Review ADM1-30 (2026-11-12): this was written out by hand in a
 * dozen queries (storeScope, orgAdmin) beside the admin's own
 * bindingIsLive; here it is said once. A module of its own, so that
 * storeScope and orgAdmin need not import adminAuthority, which imports
 * them.
 */
import { gt, isNull, or } from 'drizzle-orm';
import { schema as s } from '@compass/db';

/** A role binding that has not lapsed at `now`. */
export function bindingIsLive(now: Date = new Date()) {
  return or(isNull(s.memberRoleBindings.expiresAt), gt(s.memberRoleBindings.expiresAt, now));
}

/** A per-member permission override that has not lapsed at `now`. */
export function overrideIsLive(now: Date = new Date()) {
  return or(
    isNull(s.memberPermissionOverrides.expiresAt),
    gt(s.memberPermissionOverrides.expiresAt, now),
  );
}
