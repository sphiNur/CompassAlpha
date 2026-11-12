/**
 * Who may clock in at a store (review ATT-14, 2026-11-12): the punch's own
 * rule, for the checks that ask it about someone else.
 *
 * The punch (`authorize` in the attendance router) allows it when the
 * member's permissions in that store include `attendance.clock`
 * (effectivePermissionsForStore: roles bound organisation-wide or to the
 * store, then allow and deny overrides, a deny winning). Clocking a
 * colleague on another phone and the shift reminders read only the
 * organisation-wide allow that the settings' switch writes: someone denied
 * at the store could still be clocked there by a colleague and was still
 * reminded, and someone who clocks through a role was neither.
 *
 * Not used for the settings' switch itself: it shows and sets that
 * organisation-wide allow (`memberSet`).
 */
import type { DB } from '@compass/db';
import { effectivePermissionsForStore } from './storeScope';

/** effectivePermissionsForStore does not read the session's own set. */
const NO_SESSION: ReadonlySet<string> = new Set();

/** Of `memberIds`, those who may clock in at `storeId`. */
export async function clockingAt(
  db: DB,
  storeId: string,
  memberIds: readonly string[],
): Promise<Set<string>> {
  const ids = [...new Set(memberIds)];
  // The same call as the punch's, one member each; the reads go out
  // together on the transaction's connection.
  const allowed = await Promise.all(
    ids.map(async (memberId) =>
      (await effectivePermissionsForStore(db, memberId, storeId, NO_SESSION)).has(
        'attendance.clock',
      ),
    ),
  );
  return new Set(ids.filter((_, i) => allowed[i]));
}
