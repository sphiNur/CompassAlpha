/**
 * Has this launch settled its invite already? (COREWEB1-03, 2026-11-09)
 *
 * Telegram keeps a launch's `start_param` across reloads of the same
 * WebView: an update reload, a stale chunk, the crash screen's reset. Each
 * reload accepted the invite again. "Joined" was shown again, a member
 * who had switched organisation since was moved back to the invite's, and
 * a new refresh token was issued every time. Shell does the same for
 * `tab_` links (`compass.startParamTab`).
 *
 * Settled means accepted, or refused by the server. An invite that only
 * failed to get through is not settled: a reload tries it again.
 */
const SETTLED_KEY = 'compass.inviteSettled';

type SessionStore = Pick<Storage, 'getItem' | 'setItem'>;

function sessionStore(): SessionStore | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function inviteSettled(token: string, store: SessionStore | null = sessionStore()): boolean {
  try {
    return store?.getItem(SETTLED_KEY) === token;
  } catch {
    return false;
  }
}

export function markInviteSettled(
  token: string,
  store: SessionStore | null = sessionStore(),
): void {
  try {
    store?.setItem(SETTLED_KEY, token);
  } catch {
    /* no storage: a reload may accept it again, as before */
  }
}
