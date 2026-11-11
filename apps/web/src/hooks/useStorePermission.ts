/**
 * The signed-in person's permissions in a store, as hooks: they draw again
 * when the session changes. The rules are lib/storePermission.ts and
 * lib/pricesVisible.ts (review COREWEB2-14, 2026-11-11: these hooks were
 * in those lib files).
 */
import { useAuthStore } from '../stores/authStore';
import { hasStorePermission } from '../lib/storePermission';

/** Whether `key` holds for the actor in `storeId` (hasStorePermission). */
export function useStorePermission(key: string, storeId: string | null | undefined): boolean {
  const session = useAuthStore((s) => s.session);
  return hasStorePermission(session, storeId, key);
}

/** Whether money is shown for `storeId` (canSeePricesIn, D6). */
export function useCanSeePrices(storeId?: string | null): boolean {
  return useStorePermission('prices.view', storeId);
}
