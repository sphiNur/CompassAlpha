import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface AuthSession {
  user: {
    id: string;
    displayName: string;
    /** Once true, only an admin can rename the user. */
    displayNameLocked: boolean;
    avatarUrl: string | null;
    locale: string;
    /**
     * M3.45 (2026-05-22): secondary display language for the bilingual
     * product-name workflow. Null when the user hasn't opted in. When
     * set, UI shows "Primary (Secondary)" and per-vendor copy
     * templates use the secondary locale exclusively.
     */
    secondaryLocale: string | null;
    tgUsername: string | null;
  };
  member: {
    memberId: string;
    orgId: string;
    orgSlug: string;
    orgName: string;
    status: string;
    /** M1.17: org-level financial settings exposed at login. The FE
     *  uses these to format money + display tax info without round-
     *  trip. Operators should treat as set-once per org. */
    currency?: string;
    taxRatePct?: string;
    pricesIncludeTax?: boolean;
  };
  /** Only stores this member is assigned to (admins see all org stores). */
  stores: Array<{ id: string; name: string; code: string | null; isActive: boolean }>;
  permissions: string[];
  roleSlugs: string[];
  /** Highest role rank held by the user — used by FE to filter which
   *  roles can even APPEAR as grantable in the admin UI. Server still
   *  enforces the same rule on the mutation; this is purely UX. */
  myMaxRank: number;
  /** Per-store max rank from store-scoped role bindings only (added
   *  2026-05-06 for C1). FE computes effective rank in store as
   *  `max(myMaxRank, storeRanks[storeId] ?? 0)` — though typically
   *  myMaxRank already includes this since it's the union. We split
   *  them so callers can tell store-only ranks apart from global. */
  storeRanks?: Record<string, number>;
  /** Stores in which the actor has admin authority (added 2026-05-06
   *  for C2). Used to filter the invite store-multiselect, the grant-
   *  role store picker, and the assign/unassign rows. Server enforces
   *  with `getActorAdminStoreIds`. Empty array = no admin authority. */
  adminStoreIds?: string[];
  /** True until the user confirms their name in onboarding. */
  needsOnboarding: boolean;
}

/**
 * Store-context selection (extended 2026-05-05).
 *
 * Three states:
 *   - `null`     — no store has ever been selected (very first login).
 *                  setSession auto-picks the first assigned store, so in
 *                  practice null is transient. Pages resolve it to the
 *                  first store authorized by the current session.
 *   - <storeId>  — the user is acting in a single store's context. This
 *                  is the default state for staff and store managers.
 *                  Pages that need a specific store (Order, Confirm)
 *                  use it directly; pages that aggregate (Approval,
 *                  Run) filter by it.
 *   - 'ALL'      — only valid for a user with the explicit `org.admin`
 *                  permission. It means "show every organization store".
 *                  Pages that need a specific store refuse this state and
 *                  prompt the user to pick.
 *
 * Why a sentinel string instead of e.g. an empty array of allowed
 * stores: keeps the type a simple discriminated union and makes the
 * picker UI's mental model match the user's ("am I looking at one
 * store, or all of them?").
 */
export const ALL_STORES = 'ALL' as const;
export type StoreContext = string | typeof ALL_STORES | null;

function canUseAllStores(session: AuthSession | null): boolean {
  return session?.permissions.includes('org.admin') ?? false;
}

function resolveCurrentStore(
  currentStoreId: StoreContext,
  session: AuthSession,
): StoreContext {
  if (currentStoreId === ALL_STORES && canUseAllStores(session)) return ALL_STORES;
  if (
    typeof currentStoreId === 'string' &&
    session.stores.some((store) => store.id === currentStoreId)
  ) {
    return currentStoreId;
  }
  return session.stores[0]?.id ?? null;
}

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  session: AuthSession | null;
  currentStoreId: StoreContext;
  hasHydrated: boolean;
  setHasHydrated: (value: boolean) => void;
  setSession: (input: { accessToken: string; refreshToken: string; session: AuthSession }) => void;
  /** Patch the session payload without rotating tokens. Used by mutations
   *  like auth.setLocale that change session-shaped data (locale, name)
   *  but leave authentication intact. */
  patchSession: (session: AuthSession) => void;
  setCurrentStore: (id: StoreContext) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      session: null,
      currentStoreId: null,
      hasHydrated: false,
      setHasHydrated: (value) => set({ hasHydrated: value }),
      setSession: ({ accessToken, refreshToken, session }) => {
        set((state) => {
          return {
            accessToken,
            refreshToken,
            session,
            currentStoreId: resolveCurrentStore(state.currentStoreId, session),
          };
        });
      },
      patchSession: (session) =>
        set((state) => {
          return {
            ...state,
            session,
            currentStoreId: resolveCurrentStore(state.currentStoreId, session),
          };
        }),
      setCurrentStore: (id) =>
        set((state) => {
          const session = state.session;
          if (!session) return {};
          if (id === ALL_STORES) {
            return canUseAllStores(session) ? { currentStoreId: ALL_STORES } : {};
          }
          if (id === null || session.stores.some((store) => store.id === id)) {
            return { currentStoreId: id };
          }
          return {};
        }),
      clear: () =>
        set({ accessToken: null, refreshToken: null, session: null, currentStoreId: null }),
    }),
    {
      name: 'compass.auth',
      partialize: (state) => ({
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        session: state.session,
        currentStoreId: state.currentStoreId,
      }),
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    },
  ),
);

export const useHasPermission = (key: string): boolean => {
  return useAuthStore((s) => Boolean(s.session?.permissions.includes(key)));
};
