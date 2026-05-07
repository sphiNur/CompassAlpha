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
if (isBrowser && !(window as { __compassLoggerBooted?: boolean }).__compassLoggerBooted) {
  initLogger({ appVersion: import.meta.env.VITE_BUILD_SHA ?? 'dev' });
  (window as { __compassLoggerBooted?: boolean }).__compassLoggerBooted = true;

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
            refetchOnWindowFocus: 'always',
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
