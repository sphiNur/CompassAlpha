/**
 * Pure pieces of what a session may open: the sign-in gate (AuthGate) and
 * the Admin tab. Kept here so they can be tested without rendering them.
 */
import { isCatalogKey, type I18n } from '@compass/i18n';
import type { AuthSession } from '../stores/authStore';

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
export function authErrorText(i18n: Pick<I18n, 't'>, error: AuthError): string {
  if (error.raw) return error.raw;
  return i18n.t(isCatalogKey(error.key) ? error.key : 'auth.errors.signInFailed');
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

/**
 * HIS-19 (2026-10-30): someone who reads finance (`reports.view`) without
 * managing people gets the finance report alone: AdminPage draws only it,
 * and the bottom nav names the Admin tab for it (RE-HIS-1). Review
 * COREWEB1-31 (2026-11-12): one rule for both, not a copy in each.
 */
export function readsFinanceOnly(
  session: Pick<AuthSession, 'permissions' | 'isPlatformAdmin'> | null,
): boolean {
  if (!session || session.isPlatformAdmin) return false;
  return (
    !session.permissions.includes('users.manage') && session.permissions.includes('reports.view')
  );
}
