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
  if (isServerSideFailure(message)) return 'common.errors.internal';
  if (isLikelyNetworkError({ message })) return 'common.networkError';
  return fallbackKey;
}

/**
 * R2-AUTH-3 (2026-10-31): the request reached our side and the server or
 * its proxy answered with an error — a 502 page while the API restarts,
 * or a session refresh that got a 5xx. Those travel as network failures
 * (so writes still go to the offline queue) but telling the user to
 * "check your connection" sent them after the wrong problem.
 */
export function isServerSideFailure(message: string | undefined): boolean {
  if (typeof message !== 'string') return false;
  return /\((gateway \d{3}|session refresh did not complete: server \d{3})\)/.test(message);
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

/**
 * Which catalog key a write's transport failure gets (R2-CLS-1,
 * 2026-10-31). Only a device that is offline knows the request never
 * left; otherwise the server may have saved it and only the answer was
 * lost, and "not saved" would send the user to redo (and conflict with)
 * a change that is already there.
 */
export function networkFailureKey(
  online: boolean,
  retrySafe: boolean,
): 'common.offlineNotSaved' | 'common.maybeSaved' | 'common.maybeSavedRetrySafe' {
  if (!online) return 'common.offlineNotSaved';
  return retrySafe ? 'common.maybeSavedRetrySafe' : 'common.maybeSaved';
}
