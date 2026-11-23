import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Session } from '@compass/contracts/schemas/auth';
import { detectLocale } from '@compass/i18n';
import { resetNavStore } from './navStore';
import { clearPersistedQueries } from '../lib/queryPersist';
import { getTg } from '../lib/telegram';

/**
 * localStorage key of the saved session. Read before React starts
 * (lib/bootLocale.ts, app/pageChunks.ts) and removed by the reset
 * (lib/localSession.ts); public/boot-guard.js, which runs without the
 * bundle, spells it out, and its test checks the two agree.
 */
export const AUTH_STORAGE_KEY = 'compass.auth';

/**
 * Fields the server added over time: a session saved by an older build
 * can lack them until the next auth.me replaces it, so they stay optional
 * here and the screens keep their fallbacks.
 */
type AddedSince =
  | 'memberships'
  | 'isPlatformAdmin'
  | 'subscription'
  | 'storeRanks'
  | 'adminStoreIds'
  | 'inactiveAdminStoreIds'
  | 'storePermissions';

/**
 * The signed-in session: what auth.me and the sign-in calls return
 * (SessionSchema in @compass/contracts). Review COREAPI-33 (2026-11-12):
 * the web wrote its own copy of the shape, and the two had drifted (the
 * language was any string here).
 */
export type AuthSession = Omit<Session, AddedSince> & Partial<Pick<Session, AddedSince>>;

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

export type PersistedAuth = Pick<
  AuthState,
  'accessToken' | 'refreshToken' | 'legacyRefreshToken' | 'session' | 'currentStoreId'
>;

/**
 * Review MWD-14 (modern-web-guidance: privacy): what is saved under
 * `compass.auth` now. The session (who, which organisation and member,
 * what they may do, for the offline start and the per-user query cache)
 * and the chosen store: no token. The access token is kept in memory and
 * the refresh token is an HttpOnly cookie the server sets
 * (apps/api/src/http/refreshCookie.ts).
 *
 * `refreshToken` is still written, as one of two values:
 *   - while a session saved by an older build has not been moved to the
 *     cookie yet, its refresh token (`legacyRefreshToken`), so a start
 *     that is offline, or closed before the move, can still make it;
 *   - otherwise {@link REFRESH_TOKEN_PLACEHOLDER}. Not a token: an older
 *     build (a rollback) reads it as one, sends it to auth.refresh, is
 *     refused and signs in again, as for any refused refresh token.
 *     Without it, that build would hold a session with no token and no way
 *     to sign in again from it.
 */
export const REFRESH_TOKEN_PLACEHOLDER = 'mwd14-refresh-token-is-in-a-cookie';

export interface SavedAuth {
  session: AuthSession | null;
  currentStoreId: StoreContext;
  refreshToken?: string | null;
}

/** What of the store is written to localStorage (the persist `partialize`). */
export function savedAuth(
  state: Pick<AuthState, 'session' | 'currentStoreId' | 'legacyRefreshToken'>,
): SavedAuth {
  return {
    session: state.session,
    currentStoreId: state.currentStoreId,
    ...(state.session
      ? { refreshToken: state.legacyRefreshToken ?? REFRESH_TOKEN_PLACEHOLDER }
      : {}),
  };
}

/**
 * A session saved before the server kept only the four languages
 * (COREWEB2-10) can carry Telegram's raw code ("zh-hans"), and one from
 * before the second language (M3.45) has none; both are read as the
 * server reads them on the next sign-in.
 */
function withKnownLocales(session: AuthSession): AuthSession {
  const { locale, secondaryLocale } = session.user as {
    locale: unknown;
    secondaryLocale?: unknown;
  };
  return {
    ...session,
    user: {
      ...session.user,
      locale: detectLocale(typeof locale === 'string' ? locale : null),
      secondaryLocale:
        typeof secondaryLocale === 'string' && secondaryLocale
          ? detectLocale(secondaryLocale)
          : null,
    },
  };
}

/**
 * The Telegram account this launch was opened from; null outside Telegram
 * or before the SDK has loaded (it is a deferred script that runs before
 * the bundle, index.html). Unsigned, and used for nothing but the check
 * below: the worst a wrong value does is sign the person in again from
 * initData, which the server verifies.
 */
export function launchTelegramUserId(): string | null {
  const id = getTg()?.initDataUnsafe?.user?.id;
  return id === undefined || id === null ? null : String(id);
}

/**
 * Plan 2.3 (2026-11-23): is a saved session another Telegram account's
 * than the one that opened the app? The saved session and the refresh
 * cookie live in the WebView, which two accounts on one phone can share;
 * the app opened as the last person to use it, for up to the cookie's 30
 * days, with no sign-out in production. Both ids must be known: a
 * session from a sign-in without Telegram, or a start outside it, is
 * kept as before.
 */
export function savedForAnotherAccount(
  savedTgUserId: string | null | undefined,
  launchTgUserId: string | null,
): boolean {
  return !!savedTgUserId && !!launchTgUserId && savedTgUserId !== launchTgUserId;
}

/** What a stored payload restores: all of it, or nothing when the session is unusable. */
export function mergePersistedAuth<T extends PersistedAuth>(
  persisted: unknown,
  current: T,
  launchTgUserId: string | null = launchTelegramUserId(),
): T {
  const p = (persisted ?? {}) as Partial<PersistedAuth>;
  if (!isUsableSession(p.session)) return current;
  if (savedForAnotherAccount(p.session.user.tgUserId, launchTgUserId)) {
    // Another person's: not restored, and their tab and offline copy go
    // with it, as clear() does. The sign-in screen then signs this
    // account in from initData. The outbox stays: its writes carry their
    // author and wait for that person's next session.
    resetNavStore();
    void clearPersistedQueries();
    return current;
  }
  const session = withKnownLocales(p.session);
  // Review MWD-14: a session saved by an older build still carries its
  // tokens. The access token is used from memory until it runs out; the
  // refresh token is moved to the cookie by the first refresh
  // (lib/trpc.ts), and stays saved until then. Neither is written back.
  const legacyRefreshToken =
    typeof p.refreshToken === 'string' &&
    p.refreshToken.length > 0 &&
    p.refreshToken !== REFRESH_TOKEN_PLACEHOLDER
      ? p.refreshToken
      : null;
  return {
    ...current,
    accessToken: typeof p.accessToken === 'string' ? p.accessToken : null,
    refreshToken: null,
    legacyRefreshToken,
    session,
    currentStoreId: resolveCurrentStore(
      typeof p.currentStoreId === 'string' ? p.currentStoreId : null,
      session,
    ),
  };
}

interface AuthState {
  /** Review MWD-14: in memory only, never saved. */
  accessToken: string | null;
  /**
   * Review MWD-14: the refresh token the server last returned, in memory
   * only. The cookie is what a refresh sends; this is the fallback where
   * the browser does not keep the cookie (Telegram Web in a browser that
   * blocks cookies in frames), for as long as the page stays open.
   */
  refreshToken: string | null;
  /** Review MWD-14: an older build's saved refresh token, until a refresh moves it to the cookie. */
  legacyRefreshToken: string | null;
  /**
   * Bumped by every sign-in and sign-out. A refresh that was in flight
   * across one does not write its (older) session over the new one.
   */
  epoch: number;
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
      legacyRefreshToken: null,
      epoch: 0,
      session: null,
      currentStoreId: null,
      hasHydrated: false,
      setHasHydrated: (value) => set({ hasHydrated: value }),
      setSession: ({ accessToken, refreshToken, session }) => {
        set((state) => {
          return {
            accessToken,
            refreshToken,
            // The server answered with tokens, so it has set the cookie:
            // an older build's saved token is no longer needed.
            legacyRefreshToken: null,
            epoch: state.epoch + 1,
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
        set((state) => ({
          accessToken: null,
          refreshToken: null,
          legacyRefreshToken: null,
          epoch: state.epoch + 1,
          session: null,
          currentStoreId: null,
        }));
      },
    }),
    {
      name: AUTH_STORAGE_KEY,
      // Review MWD-14 (modern-web-guidance: privacy): no token is saved
      // (SavedAuth above).
      partialize: (state: AuthState): SavedAuth => savedAuth(state),
      merge: mergePersistedAuth,
      onRehydrateStorage: () => (state) => {
        state?.setHasHydrated(true);
      },
    },
  ),
);
