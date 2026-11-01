import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider, onlineManager, useQueryClient } from '@tanstack/react-query';
import { ThemeProvider, ToastProvider } from '@compass/ui';
import { initLogger, getLogger } from '@compass/telemetry';
import { trpc, buildTrpcClient, sendClientLogs } from '../lib/trpc';
import { reportLastReload } from '../lib/reload';
import {
  cacheOwner,
  clearPersistedQueries,
  restoreQueryCache,
  startQueryPersistence,
} from '../lib/queryPersist';
import { useAuthStore } from '../stores/authStore';
import { useTelegramInit } from '../hooks/useTelegram';
import { useTapGuard } from '../hooks/useTapGuard';
import { useVersionCheck } from '../hooks/useVersionCheck';
import { useRealtime } from '../hooks/useRealtime';
import { useRefetchFailedOnReconnect } from '../hooks/useRefetchFailedOnReconnect';
import { useOutboxReplay } from '../lib/outboxReplay';
import { useWarmRunQueries } from '../hooks/useWarmRunQueries';
import { AuthGate } from './AuthGate';
import { Shell } from './Shell';
import { ErrorBoundary } from './ErrorBoundary';
import { UiLabelsBridge } from './UiLabelsBridge';

const isBrowser = typeof window !== 'undefined';
// Local-scope augmentation: `__compassLoggerBooted` is a private
// idempotency flag set once per page lifetime to prevent duplicate
// logger init when HMR re-runs this module.
interface CompassWindow extends Window { __compassLoggerBooted?: boolean }
const compassWindow = isBrowser ? (window as CompassWindow) : null;
if (compassWindow && !compassWindow.__compassLoggerBooted) {
  const logger = initLogger({ appVersion: import.meta.env.VITE_BUILD_SHA ?? 'dev' });
  compassWindow.__compassLoggerBooted = true;
  // Without a transport every event stayed in the browser: client errors
  // never reached system.log and the debug page's server tab was empty.
  logger.setTransport(sendClientLogs);
  reportLastReload();

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

// R2-ENG-1 (2026-10-31): React Query assumes it is online until an
// `offline` event fires, which never happens when the app STARTS offline
// (a reload in the market, now that sw.js serves the shell). Every query
// then failed at once into "network error". Start from what the browser
// knows: offline, queries wait (paused) on the saved copy and run by
// themselves when the network comes back.
if (isBrowser && typeof navigator !== 'undefined') {
  onlineManager.setOnline(navigator.onLine);
}

/**
 * Keep the offline copy of the read queries (lib/queryPersist) in step
 * with who is signed in. When the person or the organisation changes —
 * or the session ends, however it ended — the in-memory cache and the
 * saved copy both go, so the next person on this phone never sees the
 * previous one's data, not even for the second before a refetch.
 */
function useQueryCachePersistence(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const stop = startQueryPersistence(queryClient, () =>
      cacheOwner(useAuthStore.getState().session),
    );
    let owner = cacheOwner(useAuthStore.getState().session);
    const unsubscribe = useAuthStore.subscribe((state) => {
      const next = cacheOwner(state.session);
      if (next === owner) return;
      const previous = owner;
      owner = next;
      if (previous !== null) {
        queryClient.clear();
        void clearPersistedQueries();
      }
    });
    return () => {
      stop();
      unsubscribe();
    };
  }, [queryClient]);
}

/** Hooks that need QueryClient (and downstream Toast). */
function QueryConsumers({ children }: { children: ReactNode }) {
  useRealtime();
  useVersionCheck();
  useRefetchFailedOnReconnect();
  useQueryCachePersistence();
  // CMP-FE-3: writes queued offline on any page replay from here.
  useOutboxReplay();
  // DX-PFE-3: the purchase tab's run queries start before the gates below.
  useWarmRunQueries();
  return <>{children}</>;
}

/** Longest the first screen waits for the saved copy before drawing anyway. */
const RESTORE_WAIT_MS = 1_500;

/**
 * Draws the pages only once the saved copy of the read queries is back
 * (a few milliseconds), so an offline start shows the last data rather
 * than a spinner that never ends. A slow or broken IndexedDB never holds
 * the app for longer than RESTORE_WAIT_MS.
 */
function CacheRestoreGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      setReady(true);
    };
    const timer = window.setTimeout(finish, RESTORE_WAIT_MS);
    void restoreQueryCache(queryClient, cacheOwner(useAuthStore.getState().session)).finally(finish);
    return () => window.clearTimeout(timer);
  }, [queryClient]);
  return ready ? <>{children}</> : null;
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
            // TanStack's default ('online') PAUSES a mutation while the
            // browser is offline: no request, no onError. Pages queue a
            // write in the IndexedDB outbox from onError on a network
            // error, so offline writes never reached it — they sat paused
            // in memory (lost when Telegram closed the app) and, counted
            // as in flight, locked the bottom nav. Always run the request:
            // offline it fails at once, queued writes go to the outbox and
            // the rest show an error instead of hanging.
            networkMode: 'always',
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
        {/* UiLabelsBridge feeds the i18n catalog into @compass/ui so the
            strings the design system renders itself (QtyControl's
            quick-pick sheet + aria-labels, DataState empty/error states,
            PhotoCapture hints) follow the user's language instead of
            being frozen English. Sits outside AuthGate so the auth and
            onboarding screens get it too. */}
        <UiLabelsBridge>
          <ToastProvider>
            <trpc.Provider client={trpcClient} queryClient={queryClient}>
                <QueryClientProvider client={queryClient}>
                  <QueryConsumers>
                    <AuthGate>
                      <CacheRestoreGate>
                        <Shell />
                      </CacheRestoreGate>
                    </AuthGate>
                  </QueryConsumers>
                </QueryClientProvider>
            </trpc.Provider>
          </ToastProvider>
        </UiLabelsBridge>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
