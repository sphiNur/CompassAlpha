/**
 * Which store a person works in: who may switch it, and the guards a page
 * sets while it has unsaved work. The hooks are in hooks/useStoreContext.ts
 * and the picker in components/StoreSwitcher.tsx (review NEW-08,
 * 2026-11-11: all three were in the component file).
 */
import type { AuthSession, StoreContext } from '../stores/authStore';

/**
 * A page can veto a global store-context change while it has unsaved local
 * work. Every global change (the store chip and picker, a deep link to
 * another store, switching workspace) asks requestStoreChange first, so
 * none silently discards a form that already protects its page-local
 * selector.
 */
type StoreChangeGuard = (nextStoreId: StoreContext) => boolean | Promise<boolean>;
const storeChangeGuards = new Set<StoreChangeGuard>();

export function registerStoreChangeGuard(guard: StoreChangeGuard): () => void {
  storeChangeGuards.add(guard);
  return () => storeChangeGuards.delete(guard);
}

export async function requestStoreChange(nextStoreId: StoreContext): Promise<boolean> {
  for (const guard of storeChangeGuards) {
    try {
      if (!(await guard(nextStoreId))) return false;
    } catch {
      // A rejected guard must fail closed: preserving an unsaved financial
      // draft is safer than changing global context without confirmation.
      return false;
    }
  }
  return true;
}

/**
 * True iff the actor is allowed to see + use the store picker.
 *
 * M3.5 rule was `org.admin` only. 2026-10-21 audit CA-22 / E-08: a
 * non-admin assigned to two or more stores (multi-store manager,
 * regional purchaser) was pinned to `stores[0]` forever with no way to
 * switch, so the rule is now `org.admin` OR ≥2 assigned stores. The
 * "all organisation stores" row stays `org.admin`-only (see
 * StorePickerSection and authStore's canUseAllStores).
 */
export function canSwitchStore(
  session: Pick<AuthSession, 'permissions' | 'stores'> | null | undefined,
): boolean {
  if (!session) return false;
  return session.permissions.includes('org.admin') || session.stores.length >= 2;
}
