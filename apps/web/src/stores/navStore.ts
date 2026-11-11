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

/** localStorage key of the persisted slice (see resetNavStore). */
export const NAV_STORAGE_KEY = 'compass.nav.v1';

/**
 * Every bottom tab, in the order the nav shows them. Review COREWEB1-11
 * (2026-11-11): the one list. The Shell's tab table and its pages are
 * keyed by `Tab`, so neither can leave a tab out, and the deep links and
 * the restore below accept exactly these.
 *
 * 2026-10-21: 'sales' is the staff-only sales entry tab (SalesPage.tsx).
 */
export const TAB_KEYS = [
  'order',
  'approve',
  'run',
  'history',
  'settlement',
  'sales',
  'confirm',
  'attendance',
  'admin',
] as const;
export type Tab = (typeof TAB_KEYS)[number];

/** Whether a stored or linked value names a tab. */
export function isTab(value: unknown): value is Tab {
  return (TAB_KEYS as readonly unknown[]).includes(value);
}

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

/**
 * The admin drill-down: its sections, and the pages inside Catalog,
 * Operations and a focused store. Review COREWEB1-11: defined once, here,
 * with the lists the restore below checks stored values against. The
 * admin pages import them; pages/admin/shared.ts used to define them a
 * second time.
 */
export const ADMIN_SECTIONS = [
  'home',
  'organization',
  'stores',
  'permissions',
  'catalog',
  'operations',
  'attendance',
  'platform',
] as const;
export type AdminSection = (typeof ADMIN_SECTIONS)[number];

// M2.0b: 'dishes' holds menu items and their recipe (BOM) editor. It sits
// next to SKUs because both are catalog data, on a page of its own so the
// SKU list stays uncluttered.
export const CATALOG_SUBS = [
  'categories',
  'skus',
  'suppliers',
  'dishes',
  'expenseTemplates',
] as const;
export type CatalogSub = (typeof CATALOG_SUBS)[number];

// M1.15 (2026-05-08): 'finance' is the cash / transfer reconciliation by
// date range, supplier and store. It lives under Operations because it is
// a read-only view, not a CRUD surface, like the price report next to it.
export const OPERATIONS_SUBS = [
  'activity',
  'history',
  'maintenance',
  'adminAudit',
  'priceReport',
  'finance',
] as const;
export type OperationsSub = (typeof OPERATIONS_SUBS)[number];

/**
 * StoreFocus tracks "am I drilled into a specific store, or browsing the
 * list?". `null` → the list. `'org-level'` → the pseudo-store for members
 * bound to no store. `{ storeId, storeName }` → a real store. JSON-safe.
 */
export type StoreFocus =
  | null
  | { kind: 'org-level' }
  | { kind: 'store'; storeId: string; storeName: string };

/**
 * The sub-tab inside a focused store. Org-level only ever shows 'team'.
 * M2.0a: 'inventory' (on-hand levels, stocktake, wastage). M2.0c: 'sales'
 * (record sales, which deducts inventory). Both only on real stores.
 */
export const STORE_SUBS = ['team', 'settings', 'inventory', 'sales'] as const;
export type StoreSub = (typeof STORE_SUBS)[number];

export interface NavState {
  tab: Tab;
  adminSection: AdminSection;
  /** null: the Catalog section's own home. */
  catalogSub: CatalogSub | null;
  /** null: the Operations section's own home. */
  opsSub: OperationsSub | null;
  storeFocus: StoreFocus;
  storeSub: StoreSub;

  setTab: (tab: Tab) => void;
  setAdminSection: (s: AdminSection) => void;
  setCatalogSub: (s: CatalogSub | null) => void;
  setOpsSub: (s: OperationsSub | null) => void;
  setStoreFocus: (f: StoreFocus) => void;
  setStoreSub: (s: StoreSub) => void;

  /**
   * Reset the admin drill-down to home. Used by the SectionFrame
   * back button when popping back to the section list.
   */
  resetAdminDrillDown: () => void;
}

/** The part of NavState that is persisted. */
export type NavData = Pick<
  NavState,
  'tab' | 'adminSection' | 'catalogSub' | 'opsSub' | 'storeFocus' | 'storeSub'
>;

const DEFAULTS: NavData = {
  tab: 'order',
  adminSection: 'home',
  catalogSub: null,
  opsSub: null,
  storeFocus: null,
  storeSub: 'team',
};

/** Never restored: the destructive maintenance page is opened on purpose. */
const RESTORED_OPERATIONS_SUBS = OPERATIONS_SUBS.filter((sub) => sub !== 'maintenance');

/**
 * Sanitize on rehydrate (2026-07-30): `persist`'s merge.
 *
 * `persist` trusts whatever is in localStorage. The types say
 * `adminSection` is never null and the actions can't produce an
 * inconsistent pair, but the STORED payload is outside the type system: a
 * value from an older build, a partially-written entry, a hand-edited key,
 * or a future field rename all land here verbatim.
 *
 * Observed 2026-07-30: a payload carrying `adminSection: null` alongside
 * `catalogSub: 'skus'` rendered the Admin tab as a blank page with an empty
 * <h1> — and because admin drill-down has no in-app back control (it relies
 * on Telegram's chrome BackButton) and the bad value is PERSISTED, a reload
 * landed straight back on the same blank screen. No way out without
 * clearing storage.
 *
 * Same spirit as `resolveVisibleTab` below and the "stale-tab guard" this
 * file's header already promises: never let stored state render a dead
 * end. Anything unrecognized falls back to its default, and a sub-selection
 * whose parent section isn't active is dropped.
 */
export function restoreNav(persisted: unknown): NavData {
  const p = (persisted ?? {}) as Partial<NavData>;
  const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
    allowed.includes(v as T) ? (v as T) : fallback;
  /** Same, but `null` is itself a valid value (a section's own home). */
  const oneOfOrNull = <T extends string>(v: unknown, allowed: readonly T[]): T | null =>
    allowed.includes(v as T) ? (v as T) : null;

  const tab = oneOf(p.tab, TAB_KEYS, DEFAULTS.tab);
  const adminSection = oneOf(p.adminSection, ADMIN_SECTIONS, DEFAULTS.adminSection);
  const storeSub = oneOf(p.storeSub, STORE_SUBS, DEFAULTS.storeSub);
  // A sub-selection only means anything inside its own section.
  const catalogSub = adminSection === 'catalog' ? oneOfOrNull(p.catalogSub, CATALOG_SUBS) : null;
  const opsSub =
    adminSection === 'operations' ? oneOfOrNull(p.opsSub, RESTORED_OPERATIONS_SUBS) : null;
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
    tab,
    adminSection,
    catalogSub,
    opsSub,
    storeFocus: adminSection === 'stores' ? storeFocus : null,
    storeSub,
  };
}

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
      name: NAV_STORAGE_KEY,
      // Persist only the data — re-derive the actions on rehydrate.
      partialize: (s) => ({
        tab: s.tab,
        adminSection: s.adminSection,
        catalogSub: s.catalogSub,
        opsSub: s.opsSub,
        storeFocus: s.storeFocus,
        storeSub: s.storeSub,
      }),
      merge: (persisted, current) => ({ ...current, ...restoreNav(persisted) }),
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
  // 2026-10-21: 'sales' and 'settlement' are the two homes of sales entry
  // and are mutually exclusive (the Sales tab hides once the user holds
  // settlement.record). Gaining or losing that permission lands the user
  // on the other one instead of the first tab.
  const sibling: Tab | null =
    persisted === 'sales' ? 'settlement' : persisted === 'settlement' ? 'sales' : null;
  if (sibling && visibleKeys.includes(sibling)) return sibling;
  return visibleKeys[0] ?? 'order';
}

/**
 * 2026-10-21: bottom-tab visibility. A tab needs its permission (or none)
 * and is hidden when the user also holds its `hiddenWith` permission —
 * the Sales tab yields to the Settlement page's sales block.
 */
export function isTabVisible(
  tab: { permission: string | null; orPermission?: string; hiddenWith?: string },
  permissions: readonly string[],
): boolean {
  if (
    tab.permission &&
    !permissions.includes(tab.permission) &&
    !(tab.orPermission && permissions.includes(tab.orPermission))
  ) {
    return false;
  }
  if (tab.hiddenWith && permissions.includes(tab.hiddenWith)) return false;
  return true;
}

/**
 * Drop the persisted navigation (2026-10-21 audit CA-33 / E-07).
 *
 * Called on organisation switch, workspace creation, sign-out / auth
 * clear, and the crash-screen and debug resets. Without it a new tenant
 * (or a new user on the same device) reopened the previous one's Admin
 * drill-down — e.g. a `storeFocus` holding another org's storeId — and a
 * crash caused by a bad persisted value survived "reset".
 */
export function resetNavStore(): void {
  try {
    useNavStore.setState({ ...DEFAULTS });
    useNavStore.persist.clearStorage();
  } catch {
    /* storage unavailable — the in-memory reset above still applies */
  }
  try {
    window.localStorage.removeItem(NAV_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
