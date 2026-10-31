import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Query, QueryClient } from '@tanstack/react-query';

/** Exported for tests: a query on screen whose last load failed. */
export function failedQuery(query: Pick<Query, 'state'>): boolean {
  return query.state.status === 'error';
}

/**
 * Load again every query on screen whose last load failed. R2-AUTH-2
 * (2026-10-31): the order page's Retry reloaded only the session, so
 * after a refresh that hung the products and categories kept their error
 * banners until each Retry was tapped too.
 */
export function refetchFailedQueries(queryClient: QueryClient): Promise<void> {
  return queryClient.refetchQueries({ type: 'active', predicate: failedQuery });
}

/**
 * N12 (2026-10-30): when the app starts offline (an offline reload, now
 * that sw.js serves the shell), React Query still believes it is online —
 * it only learns otherwise from an `offline` event, which never fires —
 * so every query fails at once and nothing retries them when the network
 * returns. The page kept its error banners, and labels built from a
 * failed lookup (store names) kept showing raw ids, until each Retry was
 * tapped. On `online`, load again whatever is on screen in a failed state.
 */
export function useRefetchFailedOnReconnect(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const onOnline = () => {
      void refetchFailedQueries(queryClient);
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [queryClient]);
}
