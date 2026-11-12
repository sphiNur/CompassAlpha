/**
 * Saving the order's "其他物品" (other items) list (review ORD-10, step 2:
 * moved out of OrderPage as it was).
 */
import { useCallback } from 'react';
import { trpc } from '../../lib/trpc';
import { staysQueued } from '../../lib/outbox/policy';
import { useErrToast } from '../../hooks/useErrToast';
import type { useOfflineQueue } from '../../hooks/useOfflineQueue';
import { frozenOrderDate } from './orderDate';
import { isLockedStatus } from './batchStatus';
import type { ExtraLine } from './extraRows';

export function useExtrasSave({
  storeId,
  orgTimeZone,
  sendQueued,
  serializeOnStore,
}: {
  storeId: string | null;
  orgTimeZone: string | undefined;
  sendQueued: ReturnType<typeof useOfflineQueue>['sendQueued'];
  /** useAdjustQueue's per-store queue. */
  serializeOnStore: <T>(storeId: string, fn: () => Promise<T>) => Promise<T>;
}): (extras: ExtraLine[]) => Promise<void> {
  const utils = trpc.useUtils();
  const errToast = useErrToast();
  /**
   * Session-level "其他物品" structured extras (M3.16-C, 2026-05-16).
   * Successor to setSessionNote — sends the WHOLE updated list every
   * time. SessionExtrasEditor does the local accumulation; this just
   * persists the snapshot.
   */
  const setSessionExtras = trpc.order.setSessionExtras.useMutation({
    retry: false,
    onError: (err) => {
      // 2026-10-21 audit CA-25/CA-27: same offline story as adjustItem —
      // the save stored it in the outbox before sending (R2-ORD-5), and
      // it stays there (staysQueued), signed out included.
      if (staysQueued(err)) return;
      // Review ORD-15 (2026-11): a refused save says so, a conflict too.
      // A conflict was only reloaded, so the rows on screen looked saved
      // when they were not. The order is read again either way.
      if (storeId) {
        void utils.order.todaySession.invalidate({ storeId });
      }
      errToast('order.toast.extrasSaveFailed')(err);
    },
  });

  // 2026-10-21 audit CA-27: the extras editor no longer waits for a SKU
  // tap to create the session. With no session yet it saves by
  // {storeId, date} and the server lazy-creates the draft; the editor
  // then adopts the real id without dropping the rows on screen.
  return useCallback(
    async (extras: ExtraLine[]): Promise<void> => {
      if (!storeId) return;
      const store = storeId;
      // Same per-store queue as AdjustItem taps: the first tap and the
      // first extras save must not BOTH lazy-create a draft.
      await serializeOnStore(store, async () => {
        // Read the cache at fire time — the render that scheduled this
        // save may predate the lazily-created draft. Only a draft or
        // rejected session is editable here (in new-batch mode the raw
        // cache can still hold the previous SENT batch).
        const cached = utils.order.todaySession.getData({ storeId: store });
        const knownId =
          cached && cached.id !== 'optimistic' && !isLockedStatus(cached.status)
            ? cached.id
            : undefined;
        // No editable session: address it by store. Pin the date only
        // when the page shows a real session (server truth); otherwise
        // the server uses today and onError freezes one if it queues.
        const input = knownId
          ? { sessionId: knownId, extras }
          : {
              storeId: store,
              extras,
              ...(cached && cached.id !== 'optimistic' ? { date: cached.orderDate } : {}),
            };
        // The queued copy freezes the business date (CA-25) when the input
        // addresses the session by store without one.
        const queuedInput =
          'storeId' in input && !input.date
            ? { ...input, date: frozenOrderDate(cached, orgTimeZone) }
            : input;
        let res: { sessionId: string | null } | undefined;
        try {
          res = await sendQueued('order.setSessionExtras', queuedInput, () =>
            setSessionExtras.mutateAsync(input),
          );
        } catch (err) {
          // Left in the outbox (network failure, signed out): keep the
          // rows as saved locally.
          if (!staysQueued(err)) throw err;
        }
        const newId = res?.sessionId ?? null;
        // Optimistic cache write so the editor doesn't flicker on the
        // next refetch; adopt the lazily-created id over 'optimistic'.
        utils.order.todaySession.setData({ storeId: store }, (old) => {
          if (!old || isLockedStatus(old.status)) return old;
          return { ...old, extras, ...(newId && !knownId ? { id: newId } : {}) };
        });
        if (newId && !knownId) {
          void utils.order.todaySession.invalidate({ storeId: store });
          void utils.order.todayBatches.invalidate({ storeId: store });
        }
      });
    },
    [storeId, orgTimeZone, sendQueued, serializeOnStore, setSessionExtras, utils.order],
  );
}
