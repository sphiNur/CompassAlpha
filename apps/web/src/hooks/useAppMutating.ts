/**
 * useAppMutating — true when ANY tRPC mutation is currently in flight
 * (M3.50, 2026-05-23).
 *
 * Wraps TanStack Query's `useIsMutating()` so call sites get a clean
 * boolean instead of a count. Used by Shell.tsx to disable the
 * bottom nav + the in-page PageMainButton while a mutation is
 * processing — prevents the "I tapped Save and could still tap a
 * different tab / different button mid-flight, racing the result"
 * class of bugs the user reported.
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

export function useAppMutating(): boolean {
  return useIsMutating() > 0;
}
