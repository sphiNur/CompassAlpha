/**
 * Which catalog key describes an error message (2026-10-21 FE-10).
 *
 * Kept free of React / @compass/ui so it can be unit-tested and shared by
 * useErrToast (mutation toasts) and UiLabelsBridge (DataState's error banner).
 */
import type { CatalogKey } from '@compass/i18n';
import { isLikelyNetworkError } from './networkError';
import { toQtyInput } from './format';

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

/** Values for a catalog sentence's placeholders. */
export type ErrorVars = Record<string, string | number>;

/**
 * CMP-FE-1 / CMP-COPY-2 (2026-10-31): the server sends a domain error's
 * placeholders in `data.context` ({ step: '0.500' }, { n: 3 }), and the
 * catalog sentence needs them: translating the key alone printed
 * "数量必须是  的倍数" and "还有  项待核对". Only plain numbers and strings
 * are taken; decimal strings lose their scale zeros ('0.500' → '0.5'),
 * like the quantity fields show them.
 */
export function errorVars(err: unknown): ErrorVars {
  const context = (err as { data?: { context?: unknown } } | null)?.data?.context;
  const vars: ErrorVars = {};
  if (!context || typeof context !== 'object' || Array.isArray(context)) return vars;
  for (const [name, value] of Object.entries(context as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) vars[name] = value;
    else if (typeof value === 'string') {
      vars[name] = /^-?\d+\.\d+$/.test(value) ? toQtyInput(value) : value;
    }
  }
  return vars;
}

/**
 * The catalog key the server named for an error, or null. Prefers the
 * message (a thrown key, or the key inside a zod issue list), then
 * `data.i18nKey`, which a domain error carries even when its message is
 * something else. The generic key the server puts on every schema refusal
 * ("check the highlighted fields") is skipped: the caller's own fallback
 * says more than that, as before.
 */
export function serverErrorKey(err: unknown): string | null {
  const raw = (err as { message?: unknown } | null)?.message;
  const message = typeof raw === 'string' ? raw : undefined;
  if (message && I18N_KEY_RE.test(message)) return message;
  const fromZod = zodIssueKey(message);
  if (fromZod) return fromZod;
  const dataKey = (err as { data?: { i18nKey?: unknown } } | null)?.data?.i18nKey;
  return typeof dataKey === 'string' &&
    I18N_KEY_RE.test(dataKey) &&
    dataKey !== 'common.errors.validation'
    ? dataKey
    : null;
}

/**
 * `errorTextKey` for a whole error object: the key plus the placeholders
 * the server sent with it.
 */
export function errorTextOf(
  err: unknown,
  fallbackKey: string,
): { key: string; vars: ErrorVars } {
  const key = serverErrorKey(err);
  if (key) return { key, vars: errorVars(err) };
  const raw = (err as { message?: unknown } | null)?.message;
  return { key: errorTextKey(typeof raw === 'string' ? raw : undefined, fallbackKey), vars: {} };
}

/**
 * The sentence a failed write falls back to: its own failure sentence, or
 * `common.errors.actionFailed`. Never the bare `common.error`, which says
 * neither why nor what to do (DX-COPY-8); the type refuses it (review
 * TEST3-06: a test used to look for it in the source).
 */
export type WriteFallbackKey = Exclude<CatalogKey, 'common.error'>;

/**
 * The toast for a write that failed and was not queued (errToast; review
 * TEST3-08 moved the choice here from the hook). A server key wins, with
 * its placeholders. A transport failure says what is known about whether
 * the write was saved (networkFailureKey; RE-CLS-3: queued writes say
 * "saved offline" themselves), unless the server or its proxy answered,
 * which is not the user's connection (R2-AUTH-3). Anything else gets the
 * action's own failure sentence.
 */
export function writeErrorTextOf(
  err: unknown,
  fallbackKey: string,
  write: { online: boolean; retrySafe: boolean },
): { key: string; vars: ErrorVars } {
  const key = serverErrorKey(err);
  if (key) return { key, vars: errorVars(err) };
  if (!isLikelyNetworkError(err)) return { key: fallbackKey, vars: {} };
  const raw = (err as { message?: unknown } | null)?.message;
  return {
    key: isServerSideFailure(typeof raw === 'string' ? raw : undefined)
      ? 'common.errors.internal'
      : networkFailureKey(write.online, write.retrySafe),
    vars: {},
  };
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
 * printed "…已被删除。。你仍在「工作区 A」。".
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
