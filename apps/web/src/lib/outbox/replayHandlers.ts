/**
 * The replay handler for every procedure a page may put in the offline
 * outbox (CMP-FE-3, 2026-10-31). hooks/useOutboxReplay.ts registers them
 * once, at app level; engine.ts calls them when it flushes.
 *
 * Each page used to register replay handlers for its own procedures when
 * it mounted (OrderPage, RunPage, ConfirmPage). After a reload on the
 * order tab, a purchase queued offline therefore waited — however long
 * the network had been back — until someone opened the purchase tab.
 *
 * Review COREWEB2-14 (2026-11-11): was lib/outboxReplay.ts, which also
 * held the app-level hook.
 */
import type { trpc } from '../trpc';
import type { MutationInput } from '../trpcPaths';
import type { ReplayFn } from './engine';

/** Every procedure a page may put in the outbox. */
export const REPLAYED_PROCEDURES = [
  'order.adjustItem',
  'order.setSessionExtras',
  'run.purchaseItem',
  'run.markUnavailable',
  'run.deliverToStore',
  'run.addPurchaserItem',
  'run.addExpense',
  'run.confirmStoreItem',
  'run.confirmStore',
  'run.markStoreItemsOk',
] as const;
export type ReplayedProcedure = (typeof REPLAYED_PROCEDURES)[number];

type Utils = ReturnType<typeof trpc.useUtils>;

/**
 * The input a replayed procedure's mutation takes, from the API's own
 * types (review COREWEB2-29, 2026-11-12): enqueue and the write-ahead send
 * used to take any input under any string, so a renamed procedure or a
 * changed input showed up only when a replay was refused. A name in the
 * list above that is not a mutation of the API gives `never`, which no
 * input matches (lib/outbox/__tests__/replayHandlers.test.ts checks).
 */
export type ReplayedInput<P extends ReplayedProcedure> = MutationInput<P>;

/**
 * One replay: send the queued input — with the idempotency key the first
 * attempt used (H2), so a request the server already committed before its
 * answer was lost dedupes — then refresh what it changed.
 */
function replay<P>(
  mutate: (input: P, opts?: { context?: Record<string, unknown> }) => Promise<unknown>,
  after: () => void,
): ReplayFn {
  return async (entry) => {
    await mutate(
      entry.input as P,
      entry.idempotencyKey ? { context: { idempotencyKey: entry.idempotencyKey } } : undefined,
    );
    after();
  };
}

/** The handler for every replayed procedure. Typed so none can be missed. */
export function replayHandlers(utils: Utils): Record<ReplayedProcedure, ReplayFn> {
  const run = () => void utils.run.get.invalidate();
  const runAndList = () => {
    void utils.run.get.invalidate();
    void utils.run.list.invalidate();
  };
  return {
    // Absolute-value writes: replaying one twice gives the same result.
    'order.adjustItem': replay(utils.client.order.adjustItem.mutate, () => {
      void utils.order.todaySession.invalidate();
    }),
    'order.setSessionExtras': replay(utils.client.order.setSessionExtras.mutate, () => {
      void utils.order.todaySession.invalidate();
      void utils.order.todayBatches.invalidate();
    }),
    'run.purchaseItem': replay(utils.client.run.purchaseItem.mutate, runAndList),
    'run.markUnavailable': replay(utils.client.run.markUnavailable.mutate, run),
    'run.deliverToStore': replay(utils.client.run.deliverToStore.mutate, runAndList),
    'run.addPurchaserItem': replay(utils.client.run.addPurchaserItem.mutate, runAndList),
    'run.addExpense': replay(utils.client.run.addExpense.mutate, runAndList),
    'run.confirmStoreItem': replay(utils.client.run.confirmStoreItem.mutate, run),
    'run.confirmStore': replay(utils.client.run.confirmStore.mutate, run),
    'run.markStoreItemsOk': replay(utils.client.run.markStoreItemsOk.mutate, run),
  };
}
