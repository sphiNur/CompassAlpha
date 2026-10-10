/**
 * Navigation state — bottom tab + admin drill-down. Persisted to
 * localStorage so a hard refresh / Telegram WebApp reopen returns
 * the user to the exact view they left.
 *
 * Added M3.16 (2026-05-16): the app previously held tab state in
 * useState inside Shell.tsx and AdminPage.tsx. Reload → app
 * remounted → state defaulted to "first visible tab" / admin home,
 * which felt jarring when the operator had drilled five levels deep
 * into a store's Team tab.
 *
 * Design:
 *   - One Zustand slice with `persist` (same middleware authStore
 *     uses) keyed under 'compass.nav.v1'.
 *   - Tab + admin drill-down are co-located so a single tab switch
 *     can also clear nested state when appropriate (we keep nested
 *     state on tab switch because switching away → back is common,
 *     but the back-button drill-up clears as before).
 *   - Stale-tab guard: if the persisted tab is no longer in `visible`
 *     (user lost a permission), fall back to the first visible one.
 *
 * NOT persisted (intentionally):
 *   - Sheet open/close state. Sheets are transient; refreshing in
 *     the middle of a Sheet should bring the user back to the
 *     underlying page, not re-open a stale modal.
 *   - Form drafts. Those are owned by the page component and reset
 *     on remount (which is the right behavior — typing into a half-
 *     finished form after a hard reload shouldn't quietly resume).
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Tab = 'order' | 'approve' | 'run' | 'history' | 'settlement' | 'confirm' | 'admin';

/**
 * Pages with an in-progress form can register a guard before the shell
 * unmounts them on a bottom-tab change. This lives outside Zustand state:
 * pending confirmation UI must never persist or replay after a reload.
 */
type TabChangeGuard = (nextTab: Tab) => boolean | Promise<boolean>;
const tabChangeGuards = new Set<TabChangeGuard>();

export function registerTabChangeGuard(guard: TabChangeGuard): () => void {
  tabChangeGuards.add(guard);
  return () => tabChangeGuards.delete(guard);
}

/**
 * Ask mounted pages whether a user-initiated tab change is safe. A guard
 * error is fail-closed so an exception cannot silently discard a draft.
 */
export async function requestTabChange(nextTab: Tab): Promise<boolean> {
  for (const guard of tabChangeGuards) {
    try {
      if (!(await guard(nextTab))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// Mirror of AdminPage's local types. Kept inline so this file has no
// dependency on AdminPage.tsx (which is a lazy-loaded chunk).
export type AdminSection =
  | 'home'
  | 'organization'
  | 'stores'
  | 'permissions'
  | 'catalog'
  | 'operations';
export type CatalogSub = 'categories' | 'skus' | 'suppliers' | 'dishes' | 'expenseTemplates' | null;
export type OperationsSub =
  | 'activity'
  | 'history'
  | 'maintenance'
  | 'adminAudit'
  | 'priceReport'
  | 'finance'
  | null;
/**
 * StoreFocus tracks "am I drilled into a specific store, or browsing
 * the list?". JSON-safe.
 */
export type StoreFocus =
  | null
  | { kind: 'org-level' }
  | { kind: 'store'; storeId: string; storeName: string };
export type StoreSub = 'team' | 'settings' | 'inventory' | 'sales';

export interface NavState {
  tab: Tab;
  adminSection: AdminSection;
  catalogSub: CatalogSub;
  opsSub: OperationsSub;
  storeFocus: StoreFocus;
  storeSub: StoreSub;

  setTab: (tab: Tab) => void;
  setAdminSection: (s: AdminSection) => void;
  setCatalogSub: (s: CatalogSub) => void;
  setOpsSub: (s: OperationsSub) => void;
  setStoreFocus: (f: StoreFocus) => void;
  setStoreSub: (s: StoreSub) => void;

  /**
   * Reset the admin drill-down to home. Used by the SectionFrame
   * back button when popping back to the section list.
   */
  resetAdminDrillDown: () => void;
}

const DEFAULTS = {
  tab: 'order' as Tab,
  adminSection: 'home' as AdminSection,
  catalogSub: null as CatalogSub,
  opsSub: null as OperationsSub,
  storeFocus: null as StoreFocus,
  storeSub: 'team' as StoreSub,
};

export const useNavStore = create<NavState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      setTab: (tab) => set({ tab }),
      setAdminSection: (adminSection) => set({ adminSection }),
      setCatalogSub: (catalogSub) => set({ catalogSub }),
      setOpsSub: (opsSub) => set({ opsSub }),
      setStoreFocus: (storeFocus) => set({ storeFocus }),
      setStoreSub: (storeSub) => set({ storeSub }),
      resetAdminDrillDown: () =>
        set({
          adminSection: 'home',
          catalogSub: null,
          opsSub: null,
          storeFocus: null,
          storeSub: 'team',
        }),
    }),
    {
      // v1: tab + admin drill-down. Bump if the shape changes.
      name: 'compass.nav.v1',
      // Persist only the data — re-derive the actions on rehydrate.
      partialize: (s) => ({
        tab: s.tab,
        adminSection: s.adminSection,
        catalogSub: s.catalogSub,
        opsSub: s.opsSub,
        storeFocus: s.storeFocus,
        storeSub: s.storeSub,
      }),
      /**
       * Sanitize on rehydrate (2026-07-30).
       *
       * `persist` trusts whatever is in localStorage. The types say
       * `adminSection` is never null and the actions can't produce an
       * inconsistent pair, but the STORED payload is outside the type
       * system: a value from an older build, a partially-written entry, a
       * hand-edited key, or a future field rename all land here verbatim.
       *
       * Observed 2026-07-30: a payload carrying `adminSection: null`
       * alongside `catalogSub: 'skus'` rendered the Admin tab as a blank
       * page with an empty <h1> — and because admin drill-down has no
       * in-app back control (it relies on Telegram's chrome BackButton)
       * and the bad value is PERSISTED, a reload landed straight back on
       * the same blank screen. No way out without clearing storage.
       *
       * Same spirit as `resolveVisibleTab` below and the "stale-tab guard"
       * this file's header already promises: never let stored state render
       * a dead end. Anything unrecognized falls back to its default, and a
       * sub-selection whose parent section isn't active is dropped.
       */
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<NavState>;
        const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
          allowed.includes(v as T) ? (v as T) : fallback;
        /** Same, but `null` is itself a valid value (a section's own home). */
        const oneOfOrNull = <T extends string>(v: unknown, allowed: readonly T[]): T | null =>
          allowed.includes(v as T) ? (v as T) : null;

        const tab = oneOf(
          p.tab,
          ['order', 'approve', 'run', 'history', 'settlement', 'confirm', 'admin'] as const,
          DEFAULTS.tab,
        );
        const adminSection = oneOf(
          p.adminSection,
          ['home', 'organization', 'stores', 'permissions', 'catalog', 'operations'] as const,
          DEFAULTS.adminSection,
        );
        const storeSub = oneOf(
          p.storeSub,
          ['team', 'settings', 'inventory', 'sales'] as const,
          DEFAULTS.storeSub,
        );
        // A sub-selection only means anything inside its own section.
        const catalogSub: CatalogSub =
          adminSection === 'catalog'
            ? oneOfOrNull(p.catalogSub, [
                'categories',
                'skus',
                'suppliers',
                'dishes',
                'expenseTemplates',
              ] as const)
            : null;
        const opsSub: OperationsSub =
          adminSection === 'operations'
            ? oneOfOrNull(p.opsSub, [
                'activity',
                'history',
                'maintenance',
                'adminAudit',
                'priceReport',
                'finance',
              ] as const)
            : null;
        // storeFocus is a discriminated union; accept only its two shapes.
        const f = p.storeFocus;
        const storeFocus: StoreFocus =
          f && typeof f === 'object' && 'kind' in f
            ? f.kind === 'org-level'
              ? { kind: 'org-level' }
              : f.kind === 'store' &&
                  typeof (f as { storeId?: unknown }).storeId === 'string' &&
                  typeof (f as { storeName?: unknown }).storeName === 'string'
                ? {
                    kind: 'store',
                    storeId: (f as { storeId: string }).storeId,
                    storeName: (f as { storeName: string }).storeName,
                  }
                : null
            : null;

        return {
          ...current,
          tab,
          adminSection,
          catalogSub,
          opsSub,
          storeFocus: adminSection === 'stores' ? storeFocus : null,
          storeSub,
        };
      },
    },
  ),
);

/**
 * Resolve a persisted tab against the set of currently-visible tabs.
 * If the user lost a permission since last session, fall back to the
 * first visible tab so we don't render a blank page.
 */
export function resolveVisibleTab(persisted: Tab, visibleKeys: readonly Tab[]): Tab {
  if (visibleKeys.includes(persisted)) return persisted;
  return visibleKeys[0] ?? 'order';
}
