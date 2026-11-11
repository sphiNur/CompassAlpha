/**
 * Put a freshly read session into the auth store (2026-10-21 FE-06).
 * hooks/useRefreshSession.ts fetches it.
 */
import { useAuthStore, type AuthSession } from '../stores/authStore';

interface SessionSink {
  getState: () => { accessToken: string | null; patchSession: (s: AuthSession) => void };
}

/**
 * Apply a freshly fetched session — unless the user signed out (or was
 * signed out by a failed refresh) while the request was in flight, in
 * which case resurrecting a session without tokens would be wrong.
 * Returns whether it was applied.
 */
export function applyRefreshedSession(
  session: AuthSession | null | undefined,
  store: SessionSink = useAuthStore,
): boolean {
  if (!session) return false;
  const state = store.getState();
  if (!state.accessToken) return false;
  state.patchSession(session);
  return true;
}
