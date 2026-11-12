import { Suspense, type ReactNode } from 'react';
import { Spinner } from '@compass/ui';
import { resilientLazy } from '../components/resilientLazy';
import { I18nGate } from '../hooks/useI18n';
import { accessBlock } from '../lib/authAccess';
import { useSignIn, type SignIn } from './auth/useSignIn';

// Startup budget (scripts/check-entry-budget.ts): a person signed in
// through Telegram never sees these screens, so they are loaded only when
// one is drawn instead of with every start (about 2 KB gzip together).
const SignInScreen = resilientLazy(() =>
  import('./auth/SignInScreen').then((m) => ({ default: m.SignInScreen })),
);
const OnboardingScreen = resilientLazy(() =>
  import('./auth/OnboardingScreen').then((m) => ({ default: m.OnboardingScreen })),
);
const NoStoreScreen = resilientLazy(() =>
  import('./auth/BlockedScreens').then((m) => ({ default: m.NoStoreScreen })),
);
const NoAccessScreen = resilientLazy(() =>
  import('./auth/BlockedScreens').then((m) => ({ default: m.NoAccessScreen })),
);

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

function GateSpinner() {
  return (
    <div className="flex h-full items-center justify-center text-[var(--c-fg-muted)]">
      <Spinner size={32} />
    </div>
  );
}

function AuthGateScreen({ signIn, children }: { signIn: SignIn; children: ReactNode }) {
  if (signIn.waiting) return <GateSpinner />;
  const session = signIn.activeSession;
  if (!session) return <Lazy screen={<SignInScreen signIn={signIn} />} />;
  // Onboarding gate: a freshly-signed-up user (or an admin-invited
  // placeholder) confirms their name before seeing the rest of the app.
  // Until they finish, no business pages render — keeps the rule that
  // names appear in approval / audit logs from leaking placeholder
  // strings.
  if (session.needsOnboarding) return <Lazy screen={<OnboardingScreen />} />;
  const block = accessBlock(session);
  if (block === 'noStore') return <Lazy screen={<NoStoreScreen />} />;
  if (block === 'noAccess') return <Lazy screen={<NoAccessScreen />} />;
  return <>{children}</>;
}

/** One of the screens above, with the sign-in spinner while it loads. */
function Lazy({ screen }: { screen: ReactNode }) {
  return <Suspense fallback={<GateSpinner />}>{screen}</Suspense>;
}
