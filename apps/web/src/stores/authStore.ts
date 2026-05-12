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
 *                  practice null is transient. Pages should treat null
 *                  the same as "ALL" for safety, OR redirect to a picker.
 *   - <storeId>  — the user is acting in a single store's context. This
 *                  is the default state for staff and store managers.
 *                  Pages that need a specific store (Order, Confirm)
 *                  use it directly; pages that aggregate (Approval,
 *                  Run) filter by it.
 *   - 'ALL'      — only valid when the user has rank ≥ admin OR is
 *                  assigned to ≥ 2 stores. Means "show me everything I
 *                  have access to". Pages that need a specific store
 *                  refuse this state and prompt the user to pick.
 *
 * Why a sentinel string instead of e.g. an empty array of allowed
 * stores: keeps the type a simple discriminated union and makes the
 * picker UI's mental model match the user's ("am I looking at one
 * store, or all of them?").
 */
export const ALL_STORES = 'ALL' as const;
export type StoreContext = string | typeof ALL_STORES | null;

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  session: AuthSession | null;
  currentStoreId: StoreContext;
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
      setSession: ({ accessToken, refreshToken, session }) => {
        const firstStore = session.stores[0]?.id ?? null;
        set((state) => {
          // Validate the persisted currentStoreId against the new
          // session. 'ALL' is always valid. A real storeId is valid
          // only if it's still in the assigned set. Otherwise reset
          // to first-store (or null if none).
          let nextCurrent: StoreContext;
          if (state.currentStoreId === ALL_STORES) {
            nextCurrent = ALL_STORES;
          } else if (
            state.currentStoreId &&
            session.stores.some((s) => s.id === state.currentStoreId)
          ) {
            nextCurrent = state.currentStoreId;
          } else {
            nextCurrent = firstStore;
          }
          return {
            accessToken,
            refreshToken,
            session,
            currentStoreId: nextCurrent,
          };
        });
      },
      patchSession: (session) =>
        set((state) => {
          let nextCurrent: StoreContext;
          if (state.currentStoreId === ALL_STORES) {
            nextCurrent = ALL_STORES;
          } else if (
            state.currentStoreId &&
            session.stores.some((s) => s.id === state.currentStoreId)
          ) {
            nextCurrent = state.currentStoreId;
          } else {
            nextCurrent = session.stores[0]?.id ?? null;
          }
          return {
            ...state,
            session,
            currentStoreId: nextCurrent,
          };
        }),
      setCurrentStore: (id) => set({ currentStoreId: id }),
      clear: () =>
        set({ accessToken: null, refreshToken: null, session: null, currentStoreId: null }),
    }),
    { name: 'compass.auth' },
  ),
);

export const useHasPermission = (key: string): boolean => {
  return useAuthStore((s) => Boolean(s.session?.permissions.includes(key)));
};
