import { Banner, Button } from '@compass/ui';
import { useI18n } from '../../hooks/useI18n';
import { authErrorText } from '../../lib/authAccess';
import { BrowserLoginForm } from './BrowserLoginForm';
import { DevPersonaPicker } from './DevPersonaPicker';
import { loginDiagnosticText, nonTelegramErrorMessage } from './devLoginText';
import { TelegramIdChip } from './TelegramIdChip';
import type { SignIn } from './useSignIn';

/**
 * Not signed in: what went wrong, if anything, and the ways in this build
 * offers — Sign in with Telegram, a retried invite, the development
 * personas, or the browser login.
 * Review COREWEB1-09 (2026-11-12): out of AuthGate.tsx.
 */
export function SignInScreen({ signIn }: { signIn: SignIn }) {
  const i18n = useI18n();
  const showBrowserLogin = Boolean(
    signIn.loginModes.data?.nonTelegram.available && !signIn.hasTelegramInitData,
  );
  const showDevLogin = signIn.showDevPersonas;
  const showSignInButton = !showBrowserLogin && !showDevLogin;
  const errorText = signIn.error ? authErrorText(i18n, signIn.error) : null;
  return (
    <div className="flex h-full flex-col items-center gap-4 overflow-y-auto px-6 py-8 text-center">
      <h1 className="text-old-display font-semibold">Compass</h1>
      {/* Outside Telegram there is no ID to share (AUTH-8: production
          browsers were asked to send an ID that was not on screen). */}
      {!signIn.hasTelegramInitData ? null : (
        <>
          <p className="text-old-body text-[var(--c-fg-muted)]">{i18n.t('auth.shareThisId')}</p>
          {/* 2026-10-21 audit CA-50 / A-14: the line above asks the user to
              send their ID to an admin, but the ID was never on screen. */}
          <TelegramIdChip />
        </>
      )}
      {/* 2026-10-21 audit CA-48 / E-18: the title was hard-coded Chinese
          and the login-mode diagnostic (dev/browser login internals,
          Chinese only) showed in production Telegram after 10 s. The
          diagnostic is now DEV-only; production gets a translated hint. */}
      {signIn.authWaitTimedOut ? (
        <Banner tone="warn" title={i18n.t('auth.loginTimeout.title')}>
          {import.meta.env.DEV
            ? loginDiagnosticText(i18n, signIn.loginModes.data, signIn.loginModes.error)
            : i18n.t('auth.loginTimeout.body')}
        </Banner>
      ) : null}
      {errorText !== null ? (
        <Banner tone="danger" title={i18n.t('auth.errors.signInFailed')}>
          {/* The generic failure is already the title; don't say it twice. */}
          {errorText === i18n.t('auth.errors.signInFailed') ? null : errorText}
        </Banner>
      ) : null}
      {showDevLogin ? (
        <DevPersonaPicker
          personas={signIn.devPersonas.list}
          loading={signIn.devPersonas.loading}
          error={
            signIn.devPersonas.error
              ? nonTelegramErrorMessage(i18n, signIn.devPersonas.error)
              : null
          }
          pending={signIn.personaPending}
          onSelect={signIn.signInAsPersona}
          onAutoLogin={signIn.signInDevAuto}
        />
      ) : null}
      {signIn.canRetryInvite ? (
        <Button onClick={signIn.retryInvite}>{i18n.t('auth.retryInvite')}</Button>
      ) : null}
      {showSignInButton ? (
        <Button onClick={signIn.signInWithTelegram}>{i18n.t('auth.signIn')}</Button>
      ) : null}
      {showBrowserLogin ? (
        <BrowserLoginForm pending={signIn.browserLoginPending} onSubmit={signIn.signInInBrowser} />
      ) : null}
    </div>
  );
}
