/**
 * Which catalog key describes an error message (2026-10-21 FE-10).
 *
 * Kept free of React / @compass/ui so it can be unit-tested and shared by
 * errToast (mutation toasts) and UiLabelsBridge (DataState's error banner).
 */
import { isLikelyNetworkError } from './networkError';

/** Regex matching server-emitted i18n keys (e.g. `order.errors.cannotApprove`). */
export const I18N_KEY_RE = /^[a-z]+\.errors?\./;

/**
 * - a server i18n key → that key
 * - a transport failure ("Failed to fetch", offline) → `common.networkError`
 * - anything else (framework text, stack-ish strings) → `fallbackKey`,
 *   never the raw message.
 */
export function errorTextKey(message: string | undefined, fallbackKey: string): string {
  if (typeof message === 'string' && I18N_KEY_RE.test(message)) return message;
  if (isLikelyNetworkError({ message })) return 'common.networkError';
  return fallbackKey;
}
