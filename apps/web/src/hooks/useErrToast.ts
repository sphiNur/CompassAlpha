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
 * the same heuristic regex. One shared module kills the drift risk
 * (the regex changed once already; if it changes again the inlined
 * copies WILL diverge). Review COREWEB2-14 (2026-11-11): moved here
 * from lib/errToast.ts; a hook belongs in hooks/.
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
import { useToast } from '@compass/ui';
import { haptic } from '../lib/telegram';
import {
  errorVars,
  serverErrorKey,
  withPermissionName,
  writeErrorTextOf,
  type WriteFallbackKey,
} from '../lib/errorText';
import { useI18n } from './useI18n';

export interface ErrToastOptions {
  /**
   * The write sends the same idempotency key when repeated with the same
   * content, so after a lost answer the toast may say trying again is safe.
   */
  retrySafe?: boolean;
}

/**
 * Returns a curried error-handler builder. Pass the fallback i18n
 * key (used when the server message isn't recognizable as an i18n
 * key); receive a function suitable for `useMutation({ onError })`.
 */
export function useErrToast(): (
  defaultKey: WriteFallbackKey,
  options?: ErrToastOptions,
) => (err: unknown) => void {
  const i18n = useI18n();
  const toast = useToast();
  return (defaultKey, options) => (err: unknown) => {
    haptic('error');
    // Which sentence, and with which placeholders: see writeErrorTextOf.
    const { key, vars } = writeErrorTextOf(err, defaultKey, {
      online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
      retrySafe: options?.retrySafe ?? false,
    });
    toast.error(i18n.t(key, withPermissionName(vars, i18n.t)));
  };
}

/**
 * Translate-only variant — returns a string, no toast side-effect.
 * Useful when the calling code wants to format the message into a
 * larger composition (e.g. a banner subtitle). Skips haptic since
 * the caller controls UI side-effects.
 */
export function useTranslateError(): (err: unknown, defaultKey: WriteFallbackKey) => string {
  const i18n = useI18n();
  return (err, defaultKey) => {
    const key = serverErrorKey(err);
    if (key) return i18n.t(key, withPermissionName(errorVars(err), i18n.t));
    return i18n.t(defaultKey);
  };
}
