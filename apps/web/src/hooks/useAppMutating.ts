/**
 * useAppMutating — true when ANY tRPC mutation is currently in flight
 * (M3.50, 2026-05-23).
 *
 * Wraps TanStack Query's `useIsMutating()` so call sites get a clean
 * boolean instead of a count. Used by Shell.tsx to disable the in-page
 * PageMainButton while a mutation is processing — prevents the "I
 * tapped Save and could still tap a different button mid-flight,
 * racing the result" class of bugs the user reported.
 *
 * Excluded by design:
 *   - The offline queue's replay path uses `utils.client.*.mutate()`
 *     (vanilla tRPC) which does NOT pass through TanStack Query's
 *     mutation cache. So background offline-flushes don't trigger
 *     this guard — only user-initiated React `useMutation` calls do.
 *   - Queries are not counted — refetches don't block interaction.
 *
 * Per-sheet dismiss-blocking continues to use the LOCAL mutation's
 * `isPending` (M3.10 pattern) for tighter scoping when a sheet
 * shouldn't dismiss mid-write.
 */
import { useIsMutating } from '@tanstack/react-query';
import type { Mutation } from '@tanstack/react-query';

export function useAppMutating(): boolean {
  return useIsMutating() > 0;
}

/**
 * Mutation `meta` that keeps the bottom nav locked while it runs. Only
 * for writes that replace the session underneath every page — switching
 * or creating a workspace — where a tab opened mid-flight would load
 * the old tenant's data and then be cleared out from under the user.
 */
export const BLOCKS_NAVIGATION = { blocksNavigation: true } as const;

/** Exported for tests: does this mutation hold the bottom nav? */
export function blocksNavigation(mutation: Pick<Mutation, 'options'>): boolean {
  return mutation.options.meta?.blocksNavigation === true;
}

/**
 * F3 (2026-10-30): the nav used to lock for EVERY write — tapping + on
 * an order line greyed out 下单/销售/验收 until the server answered, and
 * a slow network made the app feel frozen. Leaving a page mid-write is
 * safe: the write and its hook-level callbacks (toasts, cache
 * invalidation, offline enqueue) run to completion after the page
 * unmounts, and the next page fetches fresh data. So only the writes
 * marked with BLOCKS_NAVIGATION hold the nav now.
 */
export function useNavigationBlocked(): boolean {
  return useIsMutating({ predicate: blocksNavigation }) > 0;
}
