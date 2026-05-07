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

/** Regex matching server-emitted i18n keys (e.g. `order.errors.cannotApprove`). */
const I18N_KEY_RE = /^[a-z]+\.errors?\./;

interface ErrLike {
  message?: string;
}

/**
 * Returns a curried error-handler builder. Pass the fallback i18n
 * key (used when the server message isn't recognizable as an i18n
 * key); receive a function suitable for `useMutation({ onError })`.
 */
export function useErrToast(): (
  defaultKey: Parameters<ReturnType<typeof useI18n>['t']>[0],
) => (err: unknown) => void {
  const i18n = useI18n();
  const toast = useToast();
  return (defaultKey) => (err: unknown) => {
    haptic('error');
    const msg = (err as ErrLike | null)?.message;
    const looksLikeKey = typeof msg === 'string' && I18N_KEY_RE.test(msg);
    const text: ReactNode = looksLikeKey
      ? i18n.t(msg as Parameters<typeof i18n.t>[0])
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
    const msg = (err as ErrLike | null)?.message;
    if (typeof msg === 'string' && I18N_KEY_RE.test(msg)) {
      return i18n.t(msg as Parameters<typeof i18n.t>[0]);
    }
    return i18n.t(defaultKey);
  };
}
