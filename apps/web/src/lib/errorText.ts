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
  const fromZod = zodIssueKey(message);
  if (fromZod) return fromZod;
  if (isLikelyNetworkError({ message })) return 'common.networkError';
  return fallbackKey;
}

/**
 * CAT-10 / CLS-12 (2026-10-30): an input the server's schema refuses comes
 * back as the zod issue list serialised into the message. When the first
 * issue carries a catalog key ("dishes.errors.codeTaken"), use it rather
 * than the generic fallback.
 */
export function zodIssueKey(message: string | undefined): string | null {
  if (typeof message !== 'string' || !message.trimStart().startsWith('[')) return null;
  try {
    const issues = JSON.parse(message) as Array<{ message?: unknown }>;
    if (!Array.isArray(issues)) return null;
    for (const issue of issues) {
      if (typeof issue?.message === 'string' && I18N_KEY_RE.test(issue.message)) {
        return issue.message;
      }
    }
  } catch {
    /* not JSON */
  }
  return null;
}

/**
 * RE-AUTH-1 (2026-10-31): drop a message's own closing full stop before it
 * goes into a template that ends the sentence itself — "{reason}。你仍在…"
 * printed "…已被删除。。你仍在「Eden」。".
 */
export function withoutFinalStop(message: string): string {
  return message.replace(/[。．.!！]+$/u, '');
}
