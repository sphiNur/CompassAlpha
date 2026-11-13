/**
 * Sending a batch, and taking a sent one back (review ORD-10, step 2:
 * moved out of OrderPage as it was).
 */
import { useCallback, useRef } from 'react';
import { useToast } from '@compass/ui';
import { trpc, newIdempotencyKey } from '../../lib/trpc';
import { haptic } from '../../lib/telegram';
import { outbox } from '../../lib/idb';
import { isLikelyNetworkError } from '../../lib/networkError';
import { useErrToast } from '../../hooks/useErrToast';
import { useI18n } from '../../hooks/useI18n';
import type { useOfflineQueue } from '../../hooks/useOfflineQueue';
import { isLockedStatus } from './batchStatus';

/** Order writes still waiting in the offline outbox for this store (an
 *  entry without a storeId, e.g. extras keyed by session, counts too). */
async function hasQueuedOrderWrites(storeId: string): Promise<boolean> {
  try {
    const entries = await outbox.list();
    return entries.some((entry) => {
      if (!entry.procedure.startsWith('order.')) return false;
      const entryStore = (entry.input as { storeId?: unknown } | null)?.storeId;
      return typeof entryStore !== 'string' || entryStore === storeId;
    });
  } catch {
    return false; // IndexedDB unavailable: nothing can be queued there either
  }
}

/** O1: how long the "submitted" toast offers Withdraw. */
const WITHDRAW_TOAST_MS = 5000;

export function useSubmitBatch({
  storeId,
  canSubmit,
  selectedCount,
  flushAllPendingAdjusts,
  offline,
  onSubmitted,
  onWithdrawn,
}: {
  storeId: string | null;
  /** The page's batch is a draft or a rejected one. */
  canSubmit: boolean;
  /** Products and other items in it. */
  selectedCount: number;
  /** useAdjustQueue's: every tap reaches the server before Submit. */
  flushAllPendingAdjusts: () => Promise<void>;
  offline: Pick<ReturnType<typeof useOfflineQueue>, 'online' | 'flush'>;
  /** The batch was sent: show it (and close the review). */
  onSubmitted: (sessionId: string) => void;
  /** A sent batch was taken back: it is a draft again, the default view. */
  onWithdrawn: () => void;
}) {
  const i18n = useI18n();
  const toast = useToast();
  const errToast = useErrToast();
  const utils = trpc.useUtils();
  /**
   * Submit mutation with explicit feedback. Earlier the MainButton text
   * just flipped Submitting → Submit-order silently when the request
   * failed (iOS Telegram WebView occasionally drops in-flight POSTs
   * during virtual-keyboard / nav transitions). Now we:
   *   1. Disable retry — the user, not the client, decides when to
   *      try again. Auto-retries hide the failure and confuse state.
   *   2. Toast on success / failure with concrete copy.
   *   3. On network-shaped failure, keep the review sheet (when it is
   *      open) so the tap target is obvious; on a domain error, close it.
   */
  // 2026-10-21 audit CA-26: one stable X-Idempotency-Key per LOGICAL
  // submit of a given session (sent in the trpc context, as RunPage's
  // writes do through hooks/useOfflineWrite.ts), so a retry after a lost
  // response dedupes server-side instead of minting a fresh key. Scoped
  // to the session id because the server's cache is keyed on (key,
  // route, user) only, not the input.
  const submitIdemCtx = useRef<{ idempotencyKey?: string }>({}).current;
  const submitIdemRef = useRef<{ sessionId: string; key: string } | null>(null);
  /** Guards handleSubmit across its async flush phase (double taps). */
  const submittingRef = useRef(false);
  const submit = trpc.order.submit.useMutation({
    retry: false,
    trpc: { context: submitIdemCtx },
    onSuccess: (_data, vars) => {
      submitIdemRef.current = null;
      void utils.order.todaySession.invalidate();
      void utils.order.todayBatches.invalidate();
      onSubmitted(vars.sessionId);
      haptic('success');
      // O1 (2026-11-13): Submit is one tap now, so the toast offers the
      // way back at once. The receipt's banner keeps Withdraw after it
      // goes, until a reviewer picks the batch up.
      toast.show(i18n.t('order.toast.submitted'), {
        tone: 'success',
        ttlMs: WITHDRAW_TOAST_MS,
        actions: [
          {
            label: i18n.t('order.withdraw'),
            onClick: () => withdraw.mutate({ sessionId: vars.sessionId }),
          },
        ],
      });
    },
    onError: (err) => {
      haptic('error');
      if (isLikelyNetworkError(err)) {
        // Keep submitIdemRef: the retry is the same logical submit.
        toast.error(i18n.t('order.toast.submitFailedNetwork'));
      } else {
        submitIdemRef.current = null;
        // M1.9-extra (2026-05-07): was interpolating raw err.message
        // into the toast text via {reason}, leaking i18n keys like
        // `order.errors.cannotSubmit` to the user. errToast translates
        // domain keys; falls back to a generic "could not submit"
        // toast for unrecognized error shapes.
        errToast('order.toast.submitFailed')(err);
      }
    },
  });
  const withdraw = trpc.order.withdraw.useMutation({
    onSuccess: () => {
      onWithdrawn();
      // CA-26: the withdrawn session will be re-submitted as a new
      // logical submit — never reuse the previous attempt's key.
      submitIdemRef.current = null;
      void utils.order.todaySession.invalidate();
      void utils.order.todayBatches.invalidate();
    },
    // 2026-10-21 audit B-23: a failed withdraw (e.g. claimed meanwhile —
    // order.errors.cannotWithdrawWhileClaimed) used to just stop the
    // spinner. Surface it, and refetch so the banner reflects reality.
    onError: (err) => {
      errToast('common.errors.actionFailed')(err);
      void utils.order.todaySession.invalidate();
    },
  });

  /**
   * Submit-with-id-resolution flow, used by both the Telegram
   * MainButton and the non-Telegram fallback footer button. Steps:
   *
   *   1. Flush every pending / in-flight AdjustItem so the server
   *      has every line before we ask it to submit.
   *   2. Read the session id from the cache. If it's still
   *      'optimistic' (because an adjust hit a CONFLICT or the user
   *      submitted the very first tap at the same instant), force a
   *      refetch and read again. The server is the authoritative
   *      source of the real id once the first AdjustItem landed
   *      (server lazy-creates the session).
   *   3. If after the refetch we STILL don't have a real id, tell
   *      the user to try again — at this point the network is genuinely
   *      losing requests.
   *
   * Earlier the failure mode here was: any CONFLICT during the burst
   * of taps left the cache stuck on id='optimistic' and Submit would
   * print "syncing — try submit in a moment" and just sit there. The
   * refetch step resolves that without user intervention.
   */
  const handleSubmit = useCallback(async () => {
    if (!canSubmit || selectedCount === 0 || submit.isPending) return;
    if (!storeId) return;
    // CA-26: `submit.isPending` is false during the flush/refetch below,
    // so a second tap used to start a second submit. Ref-lock the whole
    // logical submit instead.
    if (submittingRef.current) return;
    // DX-ORD-5 (2026-11-01): offline, say that submitting needs a network.
    // It used to fall through to the outbox check and say "still syncing,
    // tap again in a moment", and people kept waiting.
    if (!offline.online) {
      toast.info(i18n.t('order.review.needsNetwork'));
      return;
    }
    submittingRef.current = true;
    try {
      await flushAllPendingAdjusts();
      // Changes queued offline must reach the server before the batch is
      // submitted: the review showed them, but Submit sent the server's
      // copy without them, and their later replay lazily opened a new
      // draft. Drain the outbox; if this store still has queued order
      // writes (offline, or the server refused to answer), don't submit.
      await offline.flush();
      if (await hasQueuedOrderWrites(storeId)) {
        toast.info(i18n.t(navigator.onLine ? 'order.toast.syncing' : 'order.review.needsNetwork'));
        return;
      }

      // Only a draft/rejected session is submittable. CA-24: in new-batch
      // mode the raw cache can still hold the previous SENT batch — never
      // submit that id (the domain would no-op it as a repeat Submit).
      const submittableId = (
        d: { id: string; status: string } | null | undefined,
      ): string | undefined =>
        d && d.id !== 'optimistic' && !isLockedStatus(d.status) ? d.id : undefined;
      let sid = submittableId(utils.order.todaySession.getData({ storeId }));
      if (!sid) {
        try {
          sid = submittableId(await utils.order.todaySession.fetch({ storeId }));
        } catch {
          /* network fail — fall through to syncing toast */
        }
      }

      if (!sid) {
        toast.info(i18n.t('order.toast.syncing'));
        return;
      }
      if (submitIdemRef.current?.sessionId !== sid) {
        submitIdemRef.current = { sessionId: sid, key: newIdempotencyKey() };
      }
      submitIdemCtx.idempotencyKey = submitIdemRef.current.key;
      try {
        await submit.mutateAsync({ sessionId: sid });
      } catch {
        /* surfaced by the mutation's onError */
      }
    } finally {
      submittingRef.current = false;
    }
  }, [
    canSubmit,
    selectedCount,
    submit,
    submitIdemCtx,
    storeId,
    flushAllPendingAdjusts,
    offline,
    utils.order.todaySession,
    toast,
    i18n,
  ]);

  return { submit, withdraw, handleSubmit };
}
