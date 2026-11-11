/**
 * Words for the development and browser sign-in: a reason the server gave,
 * and why each login mode is or is not on (shown after the sign-in wait
 * times out, in development builds only).
 *
 * Review COREWEB1-09 (2026-11-12): out of AuthGate.tsx.
 */
import { isCatalogKey } from '@compass/i18n';
import type { useI18n } from '../../hooks/useI18n';

type I18n = ReturnType<typeof useI18n>;

/**
 * RE-COPY-9 (2026-10-31): the dev / test sign-in errors are catalog keys
 * now (`auth.errors.*`), so these screens follow the UI language instead of
 * a hard-coded Chinese switch. Anything else is shown as the server sent it.
 */
export function nonTelegramErrorMessage(i18n: I18n, message: string): string {
  return isCatalogKey(message) ? i18n.t(message) : message;
}

export interface LoginModeDiagnostics {
  environment?: {
    nodeEnv: string;
    releaseChannel: string;
    localRequest: boolean;
  };
  devPersona?: {
    available: boolean;
    enabled: boolean;
    reason: string | null;
  };
  nonTelegram?: {
    available: boolean;
    enabled: boolean;
    reason: string | null;
  };
}

export function loginDiagnosticText(
  i18n: I18n,
  modes: LoginModeDiagnostics | undefined,
  queryError: string | undefined,
): string {
  if (queryError) return i18n.t('dev.diag.queryFailed', { error: queryError });
  if (!modes) return i18n.t('dev.diag.waiting');
  const reason = (r: string | null | undefined) =>
    r ? nonTelegramErrorMessage(i18n, r) : i18n.t('dev.diag.unknownReason');
  const dev = modes.devPersona?.available
    ? i18n.t('dev.diag.devOk')
    : i18n.t('dev.diag.devUnavailable', { reason: reason(modes.devPersona?.reason) });
  const browser = modes.nonTelegram?.available
    ? i18n.t('dev.diag.browserOk')
    : i18n.t('dev.diag.browserUnavailable', { reason: reason(modes.nonTelegram?.reason) });
  return i18n.t('dev.diag.summary', {
    dev,
    browser,
    env: modes.environment?.nodeEnv ?? '?',
    channel: modes.environment?.releaseChannel ?? '?',
    local: i18n.t(modes.environment?.localRequest ? 'dev.diag.yes' : 'dev.diag.no'),
  });
}
