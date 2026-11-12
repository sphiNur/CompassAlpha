/**
 * What the signed-in person may administer, as the admin screens ask it.
 * Review ADM1-13 (2026-11-12): the people, catalog, store and workspace
 * screens each read these from the session in a copy of their own.
 */
import { useMemo } from 'react';
import { useAuthStore } from '../stores/authStore';

/**
 * Holds `org.admin`: organisation-wide authority. The explicit marker,
 * not "administers every visible store" (2026-10-21 audit CA-16: a
 * single-store manager passed that test).
 */
export function useIsOrgAdmin(): boolean {
  return useAuthStore((s) => s.session?.permissions.includes('org.admin') ?? false);
}

/** Module-level: a fresh `[]` in a selector re-renders without end. */
const NO_STORES: readonly string[] = [];

/**
 * The open stores where the signed-in person manages people
 * (session.adminStoreIds; absent from sessions saved by older builds).
 */
export function useAdminStoreIds(): ReadonlySet<string> {
  const ids = useAuthStore((s) => s.session?.adminStoreIds ?? NO_STORES);
  return useMemo(() => new Set(ids), [ids]);
}
