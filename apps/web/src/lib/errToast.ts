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
 *     errToast('common.errors.actionFailed')(err);
 *   }
 *
 * DX-COPY-8 (2026-11-01): pass the action's own failure sentence when the
 * catalog has one; `common.errors.actionFailed` ("try again, then
 * refresh") otherwise. `common.error` ("Something went wrong") is a
 * title, not a toast: it says neither why nor what to do.
 */
import type { ReactNode } from 'react';
import { useToast } from '@compass/ui';
import { useI18n } from '../hooks/useI18n';
import { haptic } from '../hooks/useTelegram';
import { errorVars, isServerSideFailure, networkFailureKey, serverErrorKey } from './errorText';
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
    const key = serverErrorKey(err);
    // RE-CLS-3 (2026-10-30): writes that reach here were NOT queued (the
    // queued ones say "saved offline" themselves). Say what is known about
    // whether it was saved (R2-CLS-1, networkFailureKey), instead of a
    // generic failure next to a banner promising that changes sync later.
    // A server that answered with a gateway error is not the user's
    // connection (R2-AUTH-3).
    // CMP-FE-1: with the placeholders the server sent (`data.context`).
    const text: ReactNode = key
      ? i18n.t(key as Parameters<typeof i18n.t>[0], errorVars(err))
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
    const key = serverErrorKey(err);
    if (key) return i18n.t(key as Parameters<typeof i18n.t>[0], errorVars(err));
    return i18n.t(defaultKey);
  };
}
