import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { resetNavStore } from './navStore';
import { clearPersistedQueries } from '../lib/queryPersist';

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
    /** CMP-SHL-1: own Telegram id; absent in sessions from older builds. */
    tgUserId?: string | null;
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
    /** HIS-13: the org's time zone (older sessions lack it). */
    timezone?: string;
  };
  /** Every active organisation this person can enter. */
  memberships?: Array<{
    orgId: string;
    orgSlug: string;
    orgName: string;
    memberId: string;
    status: string;
    joinedAt: string;
  }>;
  /** Cross-tenant operator; only these users may create new workspaces. */
  isPlatformAdmin?: boolean;
  /** Current tenant plan and write access snapshot. */
  subscription?: {
    planCode: string;
    planName: string;
    status: 'trialing' | 'active' | 'past_due' | 'suspended' | 'canceled';
    writeAccess: boolean;
    trialEndsAt: string | null;
    currentPeriodEnd: string | null;
    graceEndsAt: string | null;
    cancelAtPeriodEnd: boolean;
    limits: { stores: number | null; members: number | null };
    usage: { stores: number; members: number };
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
  /** SHL-2: effective permission keys per store (older sessions lack it). */
  storePermissions?: Record<string, string[]>;
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

function resolveCurrentStore(currentStoreId: StoreContext, session: AuthSession): StoreContext {
  if (currentStoreId === ALL_STORES && canUseAllStores(session)) return ALL_STORES;
  if (
    typeof currentStoreId === 'string' &&
    session.stores.some((store) => store.id === currentStoreId)
  ) {
    return currentStoreId;
  }
  return session.stores[0]?.id ?? null;
}

/**
 * DX-SHL-16 (2026-11-01): the stored session is outside the type system
 * (an older build, a half-written entry, a hand edit). A session whose
 * shape the screens rely on is wrong (`stores` not an array, say) crashed
 * the whole app on every start. Such a session is dropped, which signs
 * the person in again; navStore validates its payload the same way.
 */
export function isUsableSession(value: unknown): value is AuthSession {
  if (!value || typeof value !== 'object') return false;
  const s = value as Partial<AuthSession>;
  const isStrings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  return (
    !!s.user &&
    typeof s.user === 'object' &&
    typeof s.user.id === 'string' &&
    typeof s.user.locale === 'string' &&
    !!s.member &&
    typeof s.member === 'object' &&
    typeof s.member.orgId === 'string' &&
    Array.isArray(s.stores) &&
    s.stores.every((x) => !!x && typeof x === 'object' && typeof x.id === 'string') &&
    isStrings(s.permissions) &&
    (s.memberships === undefined || Array.isArray(s.memberships))
  );
}

type PersistedAuth = Pick<AuthState, 'accessToken' | 'refreshToken' | 'session' | 'currentStoreId'>;

/** What a stored payload restores: all of it, or nothing when the session is unusable. */
export function mergePersistedAuth<T extends PersistedAuth>(persisted: unknown, current: T): T {
  const p = (persisted ?? {}) as Partial<PersistedAuth>;
  if (!isUsableSession(p.session)) return current;
  return {
    ...current,
    accessToken: typeof p.accessToken === 'string' ? p.accessToken : null,
    refreshToken: typeof p.refreshToken === 'string' ? p.refreshToken : null,
    session: p.session,
    currentStoreId: resolveCurrentStore(
      typeof p.currentStoreId === 'string' ? p.currentStoreId : null,
      p.session,
    ),
  };
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
      clear: () => {
        // 2026-10-21 audit CA-33: the next person to sign in on this
        // device must not inherit the previous session's tab / drill-down.
        resetNavStore();
        // R2-ENG-1: the offline copy of their data goes with the session.
        void clearPersistedQueries();
        set({ accessToken: null, refreshToken: null, session: null, currentStoreId: null });
      },
    }),
    {
      name: 'compass.auth',
      partialize: (state) => ({
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        session: state.session,
        currentStoreId: state.currentStoreId,
      }),
      merge: mergePersistedAuth,
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    },
  ),
);
