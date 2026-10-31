/**
 * Shared error-toast helper for tRPC mutations.
 *
 * Why this exists:
 *   The server's TRPCError `message` field carries an i18n key like
 *   `order.errors.cannotApprove` — the FE is supposed to translate
 *   these. Network errors and the framework itself can also produce
 *   raw strings ("Failed to fetch", "FORBIDDEN", uncaught Error
 *   messages). Without a translation layer, those land in front of
 *   the user verbatim, which is what the launch audit caught on
 *   ConfirmPage.
 *
 * Pre-M1.9 this was inlined in ~4 spots across the four pages with
 * the same heuristic regex. Hoisting to lib/ kills the drift risk
 * (the regex changed once already; if it changes again the inlined
 * copies WILL diverge).
 *
 * Usage:
 *   const errToast = useErrToast();
 *   ...
 *   trpc.order.approve.useMutation({
 *     onError: errToast('approval.toast.approveFailed'),
 *   });
 *
 * Or imperatively (where the mutation handler does extra work first
 * — e.g. `isLikelyNetworkError` branch):
 *   onError: (err) => {
 *     if (isLikelyNetworkError(err)) { ... return; }
 *     errToast('common.error')(err);
 *   }
 */
import type { ReactNode } from 'react';
import { useToast } from '@compass/ui';
import { useI18n } from '../hooks/useI18n';
import { haptic } from '../hooks/useTelegram';
import { I18N_KEY_RE, isServerSideFailure, networkFailureKey, zodIssueKey } from './errorText';
import { isLikelyNetworkError } from './networkError';

interface ErrLike {
  message?: string;
}

/**
 * Returns a curried error-handler builder. Pass the fallback i18n
 * key (used when the server message isn't recognizable as an i18n
 * key); receive a function suitable for `useMutation({ onError })`.
 */
export interface ErrToastOptions {
  /**
   * The write sends the same idempotency key when repeated with the same
   * content, so after a lost answer the toast may say trying again is safe.
   */
  retrySafe?: boolean;
}

export function useErrToast(): (
  defaultKey: Parameters<ReturnType<typeof useI18n>['t']>[0],
  options?: ErrToastOptions,
) => (err: unknown) => void {
  const i18n = useI18n();
  const toast = useToast();
  return (defaultKey, options) => (err: unknown) => {
    haptic('error');
    const raw = (err as ErrLike | null)?.message;
    // A schema refusal carries its key inside the zod issue list.
    const msg = zodIssueKey(raw) ?? raw;
    const looksLikeKey = typeof msg === 'string' && I18N_KEY_RE.test(msg);
    // RE-CLS-3 (2026-10-30): writes that reach here were NOT queued (the
    // queued ones say "saved offline" themselves). Say what is known about
    // whether it was saved (R2-CLS-1, networkFailureKey), instead of a
    // generic failure next to a banner promising that changes sync later.
    // A server that answered with a gateway error is not the user's
    // connection (R2-AUTH-3).
    const text: ReactNode = looksLikeKey
      ? i18n.t(msg as Parameters<typeof i18n.t>[0])
      : isLikelyNetworkError(err)
        ? i18n.t(
            isServerSideFailure(raw)
              ? 'common.errors.internal'
              : networkFailureKey(
                  typeof navigator === 'undefined' ? true : navigator.onLine !== false,
                  options?.retrySafe ?? false,
                ),
          )
        : i18n.t(defaultKey);
    toast.error(text);
  };
}

/**
 * Translate-only variant — returns a string, no toast side-effect.
 * Useful when the calling code wants to format the message into a
 * larger composition (e.g. a banner subtitle). Skips haptic since
 * the caller controls UI side-effects.
 */
export function useTranslateError(): (
  err: unknown,
  defaultKey: Parameters<ReturnType<typeof useI18n>['t']>[0],
) => string {
  const i18n = useI18n();
  return (err, defaultKey) => {
    const raw = (err as ErrLike | null)?.message;
    const msg = zodIssueKey(raw) ?? raw;
    if (typeof msg === 'string' && I18N_KEY_RE.test(msg)) {
      return i18n.t(msg as Parameters<typeof i18n.t>[0]);
    }
    return i18n.t(defaultKey);
  };
}
