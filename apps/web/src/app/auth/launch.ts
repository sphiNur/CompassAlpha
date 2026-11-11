/**
 * What this launch brings to sign-in: the invite in the Telegram link, and
 * the development-only switches (the persona picker, `?devAs=`, the
 * automatic development login, the remembered browser Telegram ID).
 *
 * Review COREWEB1-09 (2026-11-12): out of AuthGate.tsx, which held these
 * with the sign-in state machine and five screens.
 */
import { getTg } from '../../lib/telegram';
import { inviteSettled } from '../../lib/launchInvite';

// A browser-development login already persists its refresh token. Remembering
// only the non-secret Telegram ID keeps the rare re-authentication path short
// without putting the access code in local storage or the client bundle.
const DEV_BROWSER_TG_USER_ID_KEY = 'compass.devBrowserTgUserId';
const DEV_LOGIN_MODE_KEY = 'compass.devLoginMode';

export function wantsDevPersonaPicker(): boolean {
  if (!import.meta.env.DEV || typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    return (
      params.get('devLogin') === 'choose' ||
      window.localStorage.getItem(DEV_LOGIN_MODE_KEY) === 'choose'
    );
  } catch {
    return false;
  }
}

/**
 * `?devAs=<name or memberId>` signs a local development build straight in
 * as that persona (case-insensitive part of the display name), so test
 * scripts and repeated debugging skip the picker. Development builds only.
 */
export function devAsFromUrl(): string | null {
  if (!import.meta.env.DEV || typeof window === 'undefined') return null;
  try {
    return new URLSearchParams(window.location.search).get('devAs')?.trim().toLowerCase() || null;
  } catch {
    return null;
  }
}

export function shouldUseDevBypassLogin(): boolean {
  return (
    import.meta.env.DEV &&
    import.meta.env.VITE_DEV_MOCK_INIT_DATA === '1' &&
    typeof window !== 'undefined' &&
    !window.Telegram?.WebApp?.initData &&
    !wantsDevPersonaPicker()
  );
}

export function initialDevBrowserTgUserId(): string {
  if (!import.meta.env.DEV || typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(DEV_BROWSER_TG_USER_ID_KEY) ?? '';
  } catch {
    return '';
  }
}

/** After a browser development login: its Telegram ID, never the code. */
export function rememberDevBrowserTgUserId(tgUserId: string): void {
  if (!import.meta.env.DEV || !tgUserId) return;
  try {
    window.localStorage.setItem(DEV_BROWSER_TG_USER_ID_KEY, tgUserId);
  } catch {
    /* localStorage unavailable; the login session still works */
  }
}

/**
 * The invite token arrives in one of two places depending on how the
 * recipient got here:
 *   - ?startapp=<token> on the bot link → initDataUnsafe.start_param
 *   - the bot's web_app fallback button → ?invite=<token> on our URL
 * Both are only useful inside Telegram, where a signed initData blob
 * is also present. An invite this launch settled already is not taken
 * again on a reload (COREWEB1-03, lib/launchInvite).
 */
export function inviteTokenFromLaunch(): string | null {
  const token = launchInviteToken();
  return token && !inviteSettled(token) ? token : null;
}

function launchInviteToken(): string | null {
  const startParam = getTg()?.initDataUnsafe?.start_param?.trim();
  if (startParam?.startsWith('inv_')) return startParam;
  if (typeof window === 'undefined') return null;
  const fromUrl = new URLSearchParams(window.location.search).get('invite')?.trim();
  return fromUrl || null;
}

/**
 * The query-string form of the invite is visible in the address bar. Once
 * the invite has been accepted it has no job left.
 */
export function dropInviteFromAddressBar(): void {
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has('invite')) {
      url.searchParams.delete('invite');
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    }
  } catch {
    /* the session is valid even if the URL cannot be rewritten */
  }
}
