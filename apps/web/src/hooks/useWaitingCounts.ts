import { trpc } from '../lib/trpc';
import { useStoreContext } from '../components/StoreSwitcher';

/** Orders waiting for a decision in the current store. */
export function usePendingApprovals(enabled: boolean): number {
  const ctx = useStoreContext();
  // Same query and input as the approval screen, so the two share a cache
  // entry and the realtime invalidation keeps both current.
  const query = trpc.order.pendingList.useQuery(
    { status: 'submitted', ...(ctx.kind === 'specific' ? { storeId: ctx.storeId } : {}) },
    { enabled: enabled && ctx.kind !== 'none' },
  );
  return query.data?.length ?? 0;
}

/** Approved orders that no market run has picked up yet. */
export function useOrdersToBuy(enabled: boolean): number {
  // The buying screen's own query, for the same reason as above.
  const query = trpc.run.previewCreatable.useQuery({}, { enabled });
  return query.data?.sessions.length ?? 0;
}
