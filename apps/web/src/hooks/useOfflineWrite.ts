/**
 * The offline half of a write the outbox can keep (review CONF-07 /
 * RUNWEB1-06). RunPage and ConfirmPage spelled it out for each such
 * mutation, eight times, with the key plumbing kept in step by comments.
 *
 *   const key = useStableIdempotencyKey();
 *   const queueOnNetworkError = useQueueOnNetworkError();
 *   const purchase = trpc.run.purchaseItem.useMutation({
 *     ...key,
 *     onError: (err, vars, ctx) =>
 *       queueOnNetworkError(err, {
 *         procedure: 'run.purchaseItem',
 *         input: vars,
 *         idempotencyKey: ctx?.idempotencyKey,
 *         failedKey: 'run.toast.couldNotSavePurchase',
 *         queuedKey: 'run.toast.purchaseSavedOffline',
 *         onQueued: () => closeTheForm(),
 *       }),
 *   });
 */
import { useState } from 'react';
import { useToast } from '@compass/ui';
import type { CatalogKey } from '@compass/i18n';
import { newIdempotencyKey } from '../lib/trpc';
import { isLikelyNetworkError } from '../lib/networkError';
import { useErrToast } from './useErrToast';
import type { WriteFallbackKey } from '../lib/errorText';
import type { ReplayedProcedure } from '../lib/outbox/replayHandlers';
import { useI18n } from './useI18n';
import { enqueueWrite } from '../lib/outbox/engine';

/**
 * Mutation options that give each attempt one idempotency key (H2). It is
 * sent with the first try (through the trpc context: `onMutate` runs
 * before the request is built, so the header carries it) and handed to
 * `onError` as `ctx.idempotencyKey` for the outbox entry, so a replay
 * after a lost answer dedupes on the server instead of applying twice.
 * One context per mutation is enough: a page sends one attempt of a write
 * at a time (its button is busy, or it waits for `isPending`), so two
 * attempts cannot overwrite each other's key.
 */
export function useStableIdempotencyKey() {
  const [context] = useState<{ idempotencyKey?: string }>(() => ({}));
  return {
    trpc: { context },
    onMutate: () => {
      const idempotencyKey = newIdempotencyKey();
      context.idempotencyKey = idempotencyKey;
      return { idempotencyKey };
    },
  };
}

export interface QueueableWrite {
  procedure: ReplayedProcedure;
  input: unknown;
  /** The key the first attempt sent (`useStableIdempotencyKey`), if any. */
  idempotencyKey?: string | undefined;
  /** The write's own failure sentence (DX-COPY-8). */
  failedKey: WriteFallbackKey;
  /** What the toast says once the write is stored for later. */
  queuedKey: CatalogKey;
  /** Once it is stored: close the form it came from. */
  onQueued?: () => void;
  /** When it was neither sent nor stored: undo what was shown ahead of it. */
  onNotSaved?: () => void;
}

/**
 * `onError` for a write the outbox can keep. A write that never reached the
 * server goes to the outbox, and "saved offline" shows only once it is
 * stored (COREWEB2-04). A refusal, or a device that could not store it
 * either, is reported, and what was typed stays.
 */
export function useQueueOnNetworkError() {
  const toast = useToast();
  const errToast = useErrToast();
  const i18n = useI18n();
  return (err: unknown, write: QueueableWrite): void => {
    const notSaved = () => {
      write.onNotSaved?.();
      errToast(write.failedKey)(err);
    };
    if (!isLikelyNetworkError(err)) {
      notSaved();
      return;
    }
    void enqueueWrite(write.procedure, write.input, write.idempotencyKey).then(() => {
      write.onQueued?.();
      toast.info(i18n.t(write.queuedKey));
    }, notSaved);
  };
}
