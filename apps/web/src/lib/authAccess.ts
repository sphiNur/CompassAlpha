/**
 * Pure pieces of the sign-in gate (AuthGate), kept here so they can be
 * tested without rendering it.
 */
import type { AuthSession } from '../stores/authStore';

type T = (key: never, values?: Record<string, string | number>) => string;

/**
 * CMP-SHL-2 (2026-10-31): a sign-in error is kept as a catalog key and
 * translated when it is shown. Kept as text, an error that arrived before
 * the language's catalog had loaded stayed in English for good. `raw` is
 * for development-only messages that have no key.
 */
export interface AuthError {
  key: string;
  raw?: string;
}

/**
 * The sign-in error as text in the current language. A key this build
 * does not know (a newer server) reads as the generic failure, never as
 * the raw key.
 */
export function authErrorText(i18n: { t: T }, error: AuthError): string {
  if (error.raw) return error.raw;
  const text = i18n.t(error.key as never);
  return text === error.key ? i18n.t('auth.errors.signInFailed' as never) : text;
}

/**
 * Why a signed-in person cannot use the app yet, or null. After name
 * onboarding, regular staff need at least one store assigned. Admins
 * (users.manage) bypass — they always see all stores.
 */
export function accessBlock(
  session: Pick<AuthSession, 'permissions' | 'stores'>,
): 'noStore' | 'noAccess' | null {
  const isAdmin = session.permissions.includes('users.manage');
  if (!isAdmin && session.stores.length === 0) return 'noStore';
  if (session.permissions.length === 0) return 'noAccess';
  return null;
}

