/**
 * R2-INT-1 / R2-DLV-3 / RE-DLV-1 / RE-DLV-4 (2026-10-31): a write saved to
 * the offline queue used to leave the screen exactly as it was — the
 * purchase editor still open, the store still "not delivered", the
 * receiving list still "3/4 checked" — so people tapped again and queued
 * the same thing twice. These functions lay the queued writes over the
 * last server copy of the run, marked `pendingSync`, so the item shows
 * what was saved and that it is waiting to sync.
 *
 * Derived on every render from the outbox, not written into the query
 * cache: a refetch while the queue still holds the write cannot undo it,
 * and once the queue replays (or drops) the entry the server copy is
 * simply shown again.
 */
import type { PendingWrite } from '../../../hooks/useOfflineQueue';

type Split = {
  runId: string;
  skuId: string;
  storeId: string;
  qty: string;
  unitPrice?: string | null;
  paymentMethod?: string | null;
  deliveredAt: Date | string | null;
  confirmedAt: Date | string | null;
  confirmStatus?: string | null;
  confirmReceivedQty?: string | null;
  confirmNote?: string | null;
  confirmPhotoUrl?: string | null;
  /** Set on a split whose queued change has not reached the server. */
  pendingSync?: boolean;
};

type Item = {
  skuId: string;
  status: string;
  purchasedQty: string | null;
  unitPrice: string | null;
  unavailableNote: string | null;
  paymentMethod?: string | null;
  /** Set on an item whose queued change has not reached the server. */
  pendingSync?: boolean;
};

export type OverlayRun = { id: string; items: Item[]; splits: Split[] };

type StoreSplitInput = {
  storeId: string;
  qty: string;
  unitPrice?: string;
  paymentMethod?: string;
};

/** Procedures whose queued writes these overlays understand. */
export const OVERLAID_PROCEDURES = new Set([
  'run.purchaseItem',
  'run.markUnavailable',
  'run.deliverToStore',
  'run.confirmStoreItem',
  'run.markStoreItemsOk',
  'run.confirmStore',
]);

function inputOf(entry: PendingWrite): Record<string, unknown> {
  return (entry.input ?? {}) as Record<string, unknown>;
}

/**
 * The run with every queued write for it applied. Returns the same object
 * when nothing is queued for this run, so memoised children don't
 * re-render for nothing.
 */
export function overlayPendingWrites<T extends OverlayRun>(
  run: T | undefined,
  entries: readonly PendingWrite[],
): T | undefined {
  if (!run) return run;
  const mine = entries.filter(
    (entry) => OVERLAID_PROCEDURES.has(entry.procedure) && inputOf(entry).runId === run.id,
  );
  if (mine.length === 0) return run;
  let items = run.items;
  let splits = run.splits;
  const at = (entry: PendingWrite) => new Date(entry.enqueuedAt).toISOString();
  for (const entry of mine) {
    const input = inputOf(entry);
    switch (entry.procedure) {
      case 'run.purchaseItem': {
        const skuId = String(input.skuId);
        const storeSplits = (input.storeSplits ?? []) as StoreSplitInput[];
        items = items.map((item) =>
          item.skuId === skuId && item.status === 'pending'
            ? {
                ...item,
                status: 'purchased',
                purchasedQty: String(input.actualQty),
                unitPrice: String(input.unitPrice),
                paymentMethod: (input.paymentMethod as string | undefined) ?? 'cash',
                pendingSync: true,
              }
            : item,
        );
        if (items.some((item) => item.skuId === skuId && item.pendingSync)) {
          splits = [
            ...splits.filter((sp) => sp.skuId !== skuId),
            ...storeSplits.map(
              (sp): Split => ({
                runId: run.id,
                skuId,
                storeId: sp.storeId,
                qty: sp.qty,
                unitPrice: sp.unitPrice ?? null,
                paymentMethod: sp.paymentMethod ?? null,
                deliveredAt: null,
                confirmedAt: null,
                pendingSync: true,
              }),
            ),
          ];
        }
        break;
      }
      case 'run.markUnavailable': {
        const skuId = String(input.skuId);
        items = items.map((item) =>
          item.skuId === skuId && item.status === 'pending'
            ? {
                ...item,
                status: 'unavailable',
                unavailableNote: String(input.note ?? ''),
                pendingSync: true,
              }
            : item,
        );
        break;
      }
      case 'run.deliverToStore': {
        const storeId = String(input.storeId);
        splits = splits.map((sp) =>
          sp.storeId === storeId && !sp.deliveredAt
            ? { ...sp, deliveredAt: at(entry), pendingSync: true }
            : sp,
        );
        break;
      }
      case 'run.confirmStoreItem': {
        const { storeId, skuId } = input;
        splits = splits.map((sp) =>
          sp.storeId === storeId && sp.skuId === skuId && !sp.confirmedAt
            ? {
                ...sp,
                confirmStatus: String(input.status),
                confirmNote: (input.note as string | null | undefined) ?? null,
                confirmPhotoUrl: (input.photoUrl as string | null | undefined) ?? null,
                confirmReceivedQty: (input.receivedQty as string | null | undefined) ?? null,
                pendingSync: true,
              }
            : sp,
        );
        break;
      }
      case 'run.markStoreItemsOk': {
        const storeId = input.storeId;
        const skuIds = new Set((input.skuIds ?? []) as string[]);
        splits = splits.map((sp) =>
          sp.storeId === storeId && skuIds.has(sp.skuId) && sp.confirmStatus == null
            ? { ...sp, confirmStatus: 'ok', pendingSync: true }
            : sp,
        );
        break;
      }
      case 'run.confirmStore': {
        const storeId = input.storeId;
        splits = splits.map((sp) =>
          sp.storeId === storeId && sp.deliveredAt && !sp.confirmedAt
            ? { ...sp, confirmedAt: at(entry), pendingSync: true }
            : sp,
        );
        break;
      }
    }
  }
  return { ...run, items, splits } as T;
}

/** Stores with a queued delivery or receipt confirmation. */
export function pendingStoreIds(
  runId: string | undefined,
  entries: readonly PendingWrite[],
  procedure: 'run.deliverToStore' | 'run.confirmStore',
): ReadonlySet<string> {
  const out = new Set<string>();
  if (!runId) return out;
  for (const entry of entries) {
    const input = inputOf(entry);
    if (entry.procedure === procedure && input.runId === runId) out.add(String(input.storeId));
  }
  return out;
}

/**
 * The query result with `data` replaced. A Proxy rather than a spread:
 * TanStack Query tracks which result fields a component reads, and a
 * spread reads them all, so every background refetch (isFetching) would
 * re-render the page.
 */
export function withData<Q extends { data: unknown }>(query: Q, data: Q['data']): Q {
  return new Proxy(query, {
    get: (target, key, receiver) => (key === 'data' ? data : Reflect.get(target, key, receiver)),
  });
}
