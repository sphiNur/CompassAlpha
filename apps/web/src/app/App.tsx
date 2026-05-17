import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider, ToastProvider } from '@compass/ui';
import { initLogger, getLogger } from '@compass/telemetry';
import { trpc, buildTrpcClient } from '../lib/trpc';
import { useTelegramInit } from '../hooks/useTelegram';
import { useTapGuard } from '../hooks/useTapGuard';
import { useVersionCheck } from '../hooks/useVersionCheck';
import { useRealtime } from '../hooks/useRealtime';
import { AuthGate } from './AuthGate';
import { Shell } from './Shell';
import { ErrorBoundary } from './ErrorBoundary';

const isBrowser = typeof window !== 'undefined';
// Local-scope augmentation: `__compassLoggerBooted` is a private
// idempotency flag set once per page lifetime to prevent duplicate
// logger init when HMR re-runs this module.
interface CompassWindow extends Window { __compassLoggerBooted?: boolean }
const compassWindow = isBrowser ? (window as CompassWindow) : null;
if (compassWindow && !compassWindow.__compassLoggerBooted) {
  initLogger({ appVersion: import.meta.env.VITE_BUILD_SHA ?? 'dev' });
  compassWindow.__compassLoggerBooted = true;

  window.addEventListener('error', (e) => {
    try {
      getLogger().error(e.error ?? new Error(e.message), 'window.error');
    } catch {
      /* logger not yet booted */
    }
  });
  window.addEventListener('unhandledrejection', (e) => {
    try {
      getLogger().error(e.reason ?? new Error('unhandledrejection'), 'unhandledrejection');
    } catch {
      /* logger not yet booted */
    }
  });
}

/** Hooks that need ToastProvider but not QueryClient. */
function ToastConsumers({ children }: { children: ReactNode }) {
  useVersionCheck();
  return <>{children}</>;
}

/** Hooks that need QueryClient (and downstream Toast). */
function QueryConsumers({ children }: { children: ReactNode }) {
  useRealtime();
  return <>{children}</>;
}

export function App() {
  useTelegramInit();
  // Block accidental button activation during scroll. Has to run at the
  // App root so it covers every page including the AuthGate / onboarding
  // screens, which also have tappable controls. See useTapGuard for why.
  useTapGuard();
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            gcTime: 5 * 60 * 1000,
            retry: (failureCount, err) => {
              const code = (err as { data?: { code?: string } })?.data?.code;
              if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') return false;
              return failureCount < 2;
            },
            // M3.10 (2026-05-16): was `'always'` which refetched every
            // active query on every tab/focus switch. Inside Telegram
            // WebView a user toggling back from the Settings sheet or
            // a sub-page would burst 4–6 parallel refetches —
            // ~30 kB of JSON per round-trip for noOp queries that were
            // already fresh. The real-time hub (useRealtime hook)
            // already invalidates the right queries on every domain
            // event with a 400ms coalesce window, so window-focus
            // refetches were redundant. Setting to false trades the
            // belt-and-suspenders refetch for less bandwidth + fewer
            // re-render bursts during normal tab switching.
            refetchOnWindowFocus: false,
          },
          mutations: {
            retry: false,
          },
        },
      }),
    [],
  );
  const trpcClient = useMemo(() => buildTrpcClient(), []);
  const defaultTheme =
    (import.meta.env.VITE_DEFAULT_THEME as 'native' | 'apple' | undefined) ?? 'native';

  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme={defaultTheme}>
        <ToastProvider>
          <ToastConsumers>
            <trpc.Provider client={trpcClient} queryClient={queryClient}>
              <QueryClientProvider client={queryClient}>
                <QueryConsumers>
                  <AuthGate>
                    <Shell />
                  </AuthGate>
                </QueryConsumers>
              </QueryClientProvider>
            </trpc.Provider>
          </ToastConsumers>
        </ToastProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
