import { trpc } from '../lib/trpc';
import { useStoreContext } from '../components/StoreSwitcher';

/**
 * A count is only worth showing if it is current: these are asked again
 * each time the screen showing them is opened, whatever is cached.
 */
const FRESH = { refetchOnMount: 'always' } as const;

/** Orders waiting for a decision in the current store. */
export function usePendingApprovals(enabled: boolean): number {
  const ctx = useStoreContext();
  // Same query and input as the approval screen, so the two share a cache
  // entry and the realtime invalidation keeps both current.
  const query = trpc.order.pendingList.useQuery(
    { status: 'submitted', ...(ctx.kind === 'specific' ? { storeId: ctx.storeId } : {}) },
    { ...FRESH, enabled: enabled && ctx.kind !== 'none' },
  );
  return query.data?.length ?? 0;
}

/** Approved orders that no market run has picked up yet. */
export function useOrdersToBuy(enabled: boolean): number {
  // The buying screen's own query, for the same reason as above.
  const query = trpc.run.previewCreatable.useQuery({}, { ...FRESH, enabled });
  return query.data?.sessions.length ?? 0;
}

/**
 * Delivered lines the current store has not checked in yet. Zero when
 * nothing is on its way.
 */
export function useLinesToReceive(enabled: boolean): number {
  const ctx = useStoreContext();
  // The receiving screen's two queries, so opening it afterwards is instant.
  const runs = trpc.run.list.useQuery(undefined, { ...FRESH, enabled });
  const delivering = runs.data?.find((r) => r.status === 'delivering') ?? null;
  const detail = trpc.run.get.useQuery(
    { runId: delivering?.id ?? '' },
    { ...FRESH, enabled: enabled && !!delivering },
  );
  if (!delivering || !detail.data) return 0;
  return detail.data.splits.filter(
    (sp) =>
      !!sp.deliveredAt &&
      !sp.confirmedAt &&
      (ctx.kind !== 'specific' || sp.storeId === ctx.storeId),
  ).length;
}

/**
 * Whether the current store's day is still to be closed: 1 or 0, so it
 * can sit in a count like the others. Null while unknown or when there
 * is no store to close.
 */
export function useCloseDue(enabled: boolean): number | null {
  const ctx = useStoreContext();
  const stores = trpc.catalog.stores.useQuery({ permission: 'settlement.record' }, { enabled });
  const wanted = ctx.kind === 'specific' ? ctx.storeId : null;
  // Same choice as the daily-close screen: the current store if this
  // person may close it, otherwise the first one they may.
  const storeId = stores.data?.find((st) => st.id === wanted)?.id ?? stores.data?.[0]?.id ?? null;
  const day = trpc.settlement.businessDate.useQuery(
    { storeId: storeId ?? '' },
    { enabled: enabled && !!storeId },
  );
  const date = day.data?.storeId === storeId ? day.data.date : null;
  const close = trpc.settlement.get.useQuery(
    { storeId: storeId ?? '', date: date ?? '' },
    { ...FRESH, enabled: enabled && !!storeId && !!date },
  );
  if (!storeId || !date || close.isLoading) return null;
  return close.data ? 0 : 1;
}

