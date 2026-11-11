import type { ReactNode } from 'react';
import { Spinner } from '@compass/ui';
import { I18nGate } from '../hooks/useI18n';
import { accessBlock } from '../lib/authAccess';
import { NoAccessScreen, NoStoreScreen } from './auth/BlockedScreens';
import { OnboardingScreen } from './auth/OnboardingScreen';
import { SignInScreen } from './auth/SignInScreen';
import { useSignIn, type SignIn } from './auth/useSignIn';

/**
 * Signs the person in, then draws the app — or, until it can, what stands
 * in the way: a spinner, the sign-in screen, the name confirmation, or "no
 * store" / "no access". The sign-in itself is useSignIn (app/auth).
 *
 * Review COREWEB1-09 (2026-11-12): this file held the sign-in state
 * machine and every one of those screens, about 1,000 lines.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  // DX-PFE-2 (2026-11-01): the sign-in check runs at once; only what this
  // gate draws (its own screens and the app) waits for the catalog.
  const signIn = useSignIn();
  return (
    <I18nGate>
      <AuthGateScreen signIn={signIn}>{children}</AuthGateScreen>
    </I18nGate>
  );
}

function AuthGateScreen({ signIn, children }: { signIn: SignIn; children: ReactNode }) {
  if (signIn.waiting) {
    return (
      <div className="flex h-full items-center justify-center text-[var(--c-fg-muted)]">
        <Spinner size={32} />
      </div>
    );
  }
  const session = signIn.activeSession;
  if (!session) return <SignInScreen signIn={signIn} />;
  // Onboarding gate: a freshly-signed-up user (or an admin-invited
  // placeholder) confirms their name before seeing the rest of the app.
  // Until they finish, no business pages render — keeps the rule that
  // names appear in approval / audit logs from leaking placeholder
  // strings.
  if (session.needsOnboarding) return <OnboardingScreen />;
  const block = accessBlock(session);
  if (block === 'noStore') return <NoStoreScreen />;
  if (block === 'noAccess') return <NoAccessScreen />;
  return <>{children}</>;
}
