/**
 * The store a page works in, and whether the person may switch it, as
 * hooks over the auth store. The rule is lib/storeContext.ts (review
 * NEW-08, 2026-11-11: these hooks were in components/StoreSwitcher.tsx).
 */
import { useAuthStore, ALL_STORES } from '../stores/authStore';
import type { AuthSession } from '../stores/authStore';
import { canSwitchStore } from '../lib/storeContext';

/**
 * Module-level empty array for the `stores` selector below.
 *
 * Why this exists: zustand compares selector output with `Object.is` and
 * feeds it to `useSyncExternalStore`. A selector that ends in `?? []`
 * mints a FRESH array on every call, so the snapshot always looks
 * "changed" — React re-renders, re-reads, sees another new array, and
 * loops until it throws `Maximum update depth exceeded` out of
 * `forceStoreRerender`. That crash was observed once while navigating
 * Run → Confirm (both pages call useStoreContext) on 2026-07-30.
 *
 * Returning the SAME reference every time keeps the snapshot
 * stable when `session` is null or `session.stores` is undefined.
 */
export const NO_STORES: AuthSession['stores'] = [];

export function useCanSeeStorePicker(): boolean {
  return useAuthStore((s) => canSwitchStore(s.session));
}

/**
 * Hook helper — does the current page need a specific store?
 *
 * Returns:
 *   - { kind: 'specific', storeId } — caller can use storeId directly
 *   - { kind: 'all' } — page should aggregate; if it can't, show pick-prompt
 *   - { kind: 'none' } — user has no store assignments at all
 *
 * Centralizes the "what's our store context right now" logic so each
 * page doesn't reinvent the discriminated-union check.
 *
 * A persisted context is validated against the current session. A store
 * manager can only resolve to a store present in that session; `all` is
 * reserved for the explicit `org.admin` permission.
 */
export function useStoreContext():
  | { kind: 'specific'; storeId: string }
  | { kind: 'all' }
  | { kind: 'none' } {
  const currentStoreId = useAuthStore((s) => s.currentStoreId);
  // NO_STORES (module-level) — never `?? []` inline here. See the
  // constant's docblock: a fresh array per call loops useSyncExternalStore.
  const stores = useAuthStore((s) => s.session?.stores ?? NO_STORES);
  const isOrgAdmin = useAuthStore((s) => s.session?.permissions.includes('org.admin') ?? false);
  if (currentStoreId === ALL_STORES && isOrgAdmin) return { kind: 'all' };
  if (typeof currentStoreId === 'string' && stores.some((store) => store.id === currentStoreId)) {
    return { kind: 'specific', storeId: currentStoreId };
  }
  if (stores[0]) return { kind: 'specific', storeId: stores[0].id };
  // A missing or stale context falls back to the first authorized store;
  // without an authorized store, only an org admin may use the all-stores
  // read context.
  if (!isOrgAdmin) return { kind: 'none' };
  return { kind: 'all' };
}
