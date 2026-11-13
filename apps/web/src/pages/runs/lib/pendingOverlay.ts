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
import type { PaymentMethod } from '@compass/contracts';
import type { PendingWrite } from '../../../lib/outbox/policy';
import type { ExtraStatus, RunExpense, RunExtra, RunItem, RunSplit } from '../types';

// Review RUNWEB2-31 (2026-11-12): the run's own types (runs/types.ts, from
// run.get's), where this file wrote out a third copy. An item may come
// without its planned quantity: the overlays never read it.
type Split = RunSplit;
type Item = Omit<RunItem, 'plannedQty'> & Partial<Pick<RunItem, 'plannedQty'>>;
type Expense = RunExpense;
/** An "other item" a store asked for (M3.37); absent status reads as pending. */
type Extra = Pick<RunExtra, 'sessionId' | 'idx' | 'status'>;

export type OverlayRun = {
  id: string;
  items: Item[];
  splits: Split[];
  expenses?: Expense[];
  sessionExtrasByStore?: Record<string, Extra[]>;
};

type StoreSplitInput = {
  storeId: string;
  qty: string;
  unitPrice?: string;
  paymentMethod?: PaymentMethod;
};

/** What a purchase sends that shows on its row. */
export type PurchaseInput = {
  skuId: string;
  actualQty: string;
  unitPrice: string;
  paymentMethod?: string;
  storeSplits: StoreSplitInput[];
};

/** Procedures whose queued writes these overlays understand. */
export const OVERLAID_PROCEDURES = new Set([
  'run.purchaseItem',
  'run.markUnavailable',
  'run.deliverToStore',
  'run.confirmStoreItem',
  'run.markStoreItemsOk',
  'run.confirmStore',
  // CMP-BUY-2 (2026-10-31): an expense or an added item recorded offline
  // only bumped the "waiting to sync" count; the list looked unchanged and
  // buyers recorded it again.
  'run.addExpense',
  'run.addPurchaserItem',
]);

function inputOf(entry: PendingWrite): Record<string, unknown> {
  return (entry.input ?? {}) as Record<string, unknown>;
}

/**
 * The items and splits with a purchase of an item not bought yet laid
 * over them; `pendingSync` marks it as not on the server yet.
 */
function applyPurchase(
  runId: string,
  items: Item[],
  splits: Split[],
  input: PurchaseInput,
  pendingSync: boolean,
): { items: Item[]; splits: Split[] } {
  const sync = pendingSync ? { pendingSync: true } : {};
  // Review RUNWEB2-11 (2026-11-12): the server records a purchase of any
  // item not bought yet, an unavailable one too (decide refuses only a
  // second buy), so the purchase shows on the same items.
  let applied = false;
  const nextItems = items.map((item) => {
    if (item.skuId !== input.skuId || item.status === 'purchased') return item;
    applied = true;
    return {
      ...item,
      status: 'purchased',
      purchasedQty: String(input.actualQty),
      unitPrice: String(input.unitPrice),
      paymentMethod: input.paymentMethod ?? 'cash',
      ...sync,
    };
  });
  if (!applied) return { items, splits };
  return {
    items: nextItems,
    splits: [
      ...splits.filter((sp) => sp.skuId !== input.skuId),
      ...input.storeSplits.map(
        (sp): Split => ({
          runId,
          skuId: input.skuId,
          storeId: sp.storeId,
          qty: sp.qty,
          unitPrice: sp.unitPrice ?? null,
          paymentMethod: sp.paymentMethod ?? null,
          deliveredAt: null,
          confirmedAt: null,
          ...sync,
        }),
      ),
    ],
  };
}

/**
 * Review RUNWEB1-37 (2026-11-12): a purchase the server has accepted,
 * shown on its row at once. The run is read again a moment later; until
 * then the row went back to "to buy", and on a slow line a second tap on
 * ✓ was refused as already bought. Written into the query cache, unlike
 * the queued writes above: the next read replaces it with what the
 * server holds.
 */
export function withRecordedPurchase<T extends OverlayRun>(run: T, input: PurchaseInput): T {
  const next = applyPurchase(run.id, run.items, run.splits, input, false);
  return next.items === run.items ? run : { ...run, ...next };
}

/**
 * The extras with one row's status set (RUNWEB1-17); the same object
 * when no row is at that address.
 */
export function withExtraStatus<R extends Record<string, Extra[]> | undefined>(
  byStore: R,
  sessionId: string,
  idx: number,
  status: ExtraStatus,
): R {
  if (!byStore) return byStore;
  for (const [storeId, extras] of Object.entries(byStore)) {
    const at = extras.findIndex((e) => e.sessionId === sessionId && e.idx === idx);
    if (at < 0) continue;
    if ((extras[at]!.status ?? 'pending') === status) return byStore;
    const rows = extras.slice();
    rows[at] = { ...extras[at]!, status };
    return { ...byStore, [storeId]: rows };
  }
  return byStore;
}

/** One extra's status, or undefined when no row is at that address. */
export function extraStatusOf(
  byStore: Record<string, Extra[]> | undefined,
  sessionId: string,
  idx: number,
): ExtraStatus | undefined {
  for (const extras of Object.values(byStore ?? {})) {
    const e = extras.find((x) => x.sessionId === sessionId && x.idx === idx);
    if (e) return e.status ?? 'pending';
  }
  return undefined;
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
  const withMarks = overlayExtraMarks(run, entries);
  const mine = entries.filter(
    (entry) => OVERLAID_PROCEDURES.has(entry.procedure) && inputOf(entry).runId === run.id,
  );
  if (mine.length === 0) return withMarks;
  let items = run.items;
  let splits = run.splits;
  let expenses = run.expenses;
  const at = (entry: PendingWrite) => new Date(entry.enqueuedAt).toISOString();
  for (const entry of mine) {
    const input = inputOf(entry);
    switch (entry.procedure) {
      case 'run.purchaseItem': {
        ({ items, splits } = applyPurchase(
          run.id,
          items,
          splits,
          {
            skuId: String(input.skuId),
            actualQty: String(input.actualQty),
            unitPrice: String(input.unitPrice),
            paymentMethod: input.paymentMethod as string | undefined,
            storeSplits: (input.storeSplits ?? []) as StoreSplitInput[],
          },
          true,
        ));
        break;
      }
      case 'run.addPurchaserItem': {
        const skuId = String(input.skuId);
        // Already on the run (the server has it, or it merges into an
        // existing row): nothing to add.
        if (items.some((item) => item.skuId === skuId)) break;
        const storeSplits = (input.storeSplits ?? []) as StoreSplitInput[];
        items = [
          ...items,
          {
            skuId,
            plannedQty: '0',
            supplierId: (input.supplierId as string | null | undefined) ?? null,
            addedByPurchaser: true,
            status: 'purchased',
            purchasedQty: String(input.actualQty),
            unitPrice: String(input.unitPrice),
            unavailableNote: null,
            paymentMethod: (input.paymentMethod as string | undefined) ?? 'cash',
            pendingSync: true,
          },
        ];
        splits = [
          ...splits,
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
        break;
      }
      case 'run.addExpense': {
        const id = String(input.expenseId);
        if ((expenses ?? []).some((e) => e.id === id)) break;
        expenses = [
          ...(expenses ?? []),
          {
            id,
            label: String(input.label ?? ''),
            unitHint: (input.unitHint as string | undefined) ?? null,
            qty: String(input.qty),
            unitPrice: String(input.unitPrice),
            storeSplits: (input.storeSplits ?? []) as StoreSplitInput[],
            paymentMethod: (input.paymentMethod as string | undefined) ?? 'cash',
            receiptPhotoUrl: (input.receiptPhotoUrl as string | null | undefined) ?? null,
            reason: String(input.reason ?? ''),
            addedByMemberId: '',
            addedAt: at(entry),
            pendingSync: true,
          },
        ];
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
  return { ...withMarks, items, splits, ...(expenses ? { expenses } : {}) } as T;
}

/**
 * RUNWEB1-17 (2026-11-12): an "other item" priced offline is marked
 * bought once its expense is sent (useRunMutations queues both); until
 * then it shows bought here. The mark names the order, not the run, so
 * it is matched by the order's rows.
 */
function overlayExtraMarks<T extends OverlayRun>(run: T, entries: readonly PendingWrite[]): T {
  let byStore = run.sessionExtrasByStore;
  for (const entry of entries) {
    if (entry.procedure !== 'order.markExtraStatus') continue;
    const input = inputOf(entry);
    if (typeof input.sessionId !== 'string' || typeof input.extraIndex !== 'number') continue;
    byStore = withExtraStatus(
      byStore,
      input.sessionId,
      input.extraIndex,
      input.status as ExtraStatus,
    );
  }
  return byStore === run.sessionExtrasByStore ? run : { ...run, sessionExtrasByStore: byStore };
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

/**
 * CMP-BUY-1 (2026-10-31): why "start delivery" must wait, or null. It is a
 * run-wide step the server checks against what it has recorded, so it
 * needs the network and every write queued on this phone sent first.
 */
export function startDeliveryBlock(online: boolean, queued: number): 'offline' | 'queued' | null {
  if (!online) return 'offline';
  if (queued > 0) return 'queued';
  return null;
}
