import { useAuthStore, type AuthSession } from '../stores/authStore';

/**
 * D6 (2026-10-31): whether money is shown for `storeId` — prices.view as
 * it is effective in that store (store roles and overrides, from the
 * session's per-store map), else the flat union for cross-store pages or
 * older sessions without the map. The server leaves the same amounts out;
 * this keeps screens from drawing empty money slots.
 */
export function canSeePricesIn(
  session: Pick<AuthSession, 'permissions' | 'storePermissions'> | null | undefined,
  storeId?: string | null,
): boolean {
  if (!session) return false;
  const storePerms = storeId ? session.storePermissions?.[storeId] : undefined;
  return (storePerms ?? session.permissions).includes('prices.view');
}

export function useCanSeePrices(storeId?: string | null): boolean {
  const session = useAuthStore((s) => s.session);
  return canSeePricesIn(session, storeId);
}
