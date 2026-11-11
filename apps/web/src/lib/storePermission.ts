import { useAuthStore, type AuthSession } from '../stores/authStore';

/**
 * Whether `key` holds for the actor in `storeId`: the session's per-store
 * map (store roles and overrides, SHL-2), else the flat union for a
 * cross-store page or an older session without the map. Review CONF-14
 * (2026-11-11): the sales panel read the flat union, so a person denied
 * sales.record in one store saw the form there and learned it only when
 * the server refused the sale.
 */
export function hasStorePermission(
  session: Pick<AuthSession, 'permissions' | 'storePermissions'> | null | undefined,
  storeId: string | null | undefined,
  key: string,
): boolean {
  if (!session) return false;
  const storePerms = storeId ? session.storePermissions?.[storeId] : undefined;
  return (storePerms ?? session.permissions).includes(key);
}

export function useStorePermission(key: string, storeId: string | null | undefined): boolean {
  const session = useAuthStore((s) => s.session);
  return hasStorePermission(session, storeId, key);
}
