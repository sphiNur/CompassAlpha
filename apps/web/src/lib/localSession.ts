/**
 * "Reset session and reload": what the crash screen and the debug page's
 * sign-out clear before reloading. public/boot-guard.js, which runs when
 * the bundle could not start, removes the same keys without it.
 *
 * Review COREWEB1-16 (2026-11-12): the three each cleared something else.
 *
 * Cleared: the saved sign-in, the saved tab and drill-down (2026-10-21
 * audit CA-33: a crash caused by a bad saved value must not survive the
 * reset) and the saved copy of read answers. Kept: the outbox, whose
 * writes belong to their author and replay once that person signs in
 * again, and the tab's session storage, which holds the launch's one-time
 * markers. The debug page and boot-guard used to empty it, and the reload
 * then accepted again an invite the launch had already accepted
 * (lib/launchInvite.ts).
 */
import { AUTH_STORAGE_KEY, useAuthStore } from '../stores/authStore';
import { NAV_STORAGE_KEY } from '../stores/navStore';
import { clearPersistedQueries } from './queryPersist';

/** The localStorage keys a reset removes. */
export const SAVED_SESSION_KEYS = [AUTH_STORAGE_KEY, NAV_STORAGE_KEY] as const;

/** Longest the reset waits for IndexedDB before reloading anyway. */
const CLEAR_WAIT_MS = 1_000;

/**
 * Sign out on this device and forget where the person was. Never rejects.
 * The caller reloads right after: the keys are removed last, so nothing
 * writes the session back before the reload.
 */
export async function clearLocalSession(): Promise<void> {
  try {
    // Signed out in memory first, so nothing saves the session or its
    // answers again while the saved copy is being dropped.
    useAuthStore.getState().clear();
  } catch {
    /* a broken store must not keep the person on the crash screen */
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    clearPersistedQueries(),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CLEAR_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);
  try {
    for (const key of SAVED_SESSION_KEYS) window.localStorage.removeItem(key);
  } catch {
    /* storage unavailable: nothing is saved there */
  }
}
