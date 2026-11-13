/**
 * CMP-FE-3 (2026-10-31): replay of the offline outbox, for the whole app.
 *
 * Each page used to register replay handlers for its own procedures when
 * it mounted (OrderPage, RunPage, ConfirmPage). After a reload on the
 * order tab, a purchase queued offline therefore waited — however long
 * the network had been back — until someone opened the purchase tab.
 * Mounted once in App, this registers a handler for every procedure any
 * page queues (lib/outbox/replayHandlers.ts), says when a queued write is
 * dropped, and runs the flushes (start, reconnect, return from
 * background, sign-in, a slow timer). Pages only enqueue
 * (useOfflineQueue).
 *
 * Review COREWEB2-14 (2026-11-11): was in lib/outboxReplay.ts, a lib
 * module that imported hooks.
 */
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useToast } from '@compass/ui';
import { trpc } from '../lib/trpc';
import {
  BACKLOG_RETRY_MS,
  currentOwner,
  flushOutbox,
  notifyOutboxChanged,
  registerReplayHandlers,
  setOfflineDropHandler,
  type OfflineDropInfo,
} from '../lib/outbox/engine';
import type { OutboxOwner } from '../lib/outbox/policy';
import { replayHandlers } from '../lib/outbox/replayHandlers';
import { offlineDropText, offlineDropToastOptions } from '../lib/offlineDrop';
import { isStaleVersionKey } from '../lib/conflict';
import { useAuthStore } from '../stores/authStore';
import { useI18n } from './useI18n';

export function useOutboxReplay(): void {
  const utils = trpc.useUtils();
  const dropToast = useOfflineDropToast();
  const dropToastRef = useRef(dropToast);
  dropToastRef.current = dropToast;
  useEffect(() => registerReplayHandlers(replayHandlers(utils)), [utils]);
  useEffect(() => {
    setOfflineDropHandler((info) => dropToastRef.current(info));
    return () => setOfflineDropHandler(null);
  }, []);
  useOutboxFlushTriggers();
}

/** Says, in a toast that stays until it is dismissed, which write was lost. */
function useOfflineDropToast(): (info: OfflineDropInfo) => void {
  const i18n = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  return (info) => {
    // UX-22: refused for a stale version → Refresh, as in useErrToast.
    const refresh =
      info.reason === 'rejected' && isStaleVersionKey(info.message)
        ? {
            label: i18n.t('common.refresh'),
            onClick: () => void queryClient.invalidateQueries(),
          }
        : undefined;
    toast.show(
      offlineDropText(i18n.t, info),
      offlineDropToastOptions(i18n.t('common.gotIt'), refresh),
    );
  };
}

/**
 * The app-level replay loop (CMP-FE-3). Flushes on start, when the
 * browser comes back online, when the app returns from the background,
 * after sign-in or a switch of organisation, and every BACKLOG_RETRY_MS
 * (a server that was down while the browser stayed "online" fires no
 * event).
 */
function useOutboxFlushTriggers(): void {
  useEffect(() => {
    const onOnline = () => void flushOutbox();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void flushOutbox();
    };
    const ownerKey = (o: OutboxOwner) => (o.userId ? `${o.userId}:${o.orgId ?? ''}` : '');
    let owner = ownerKey(currentOwner());
    const unsubscribe = useAuthStore.subscribe(() => {
      const next = ownerKey(currentOwner());
      if (next === owner) return;
      owner = next;
      // Signed in, or switched person or organisation: which writes are
      // this session's, and so shown as pending and replayed, changes.
      notifyOutboxChanged();
      if (next) void flushOutbox();
    });
    const backlogTimer = window.setInterval(() => void flushOutbox(), BACKLOG_RETRY_MS);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    // Backlog from a previous visit.
    void flushOutbox();
    return () => {
      unsubscribe();
      window.clearInterval(backlogTimer);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
}
