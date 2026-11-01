/**
 * RE-DLV-4 / R2-DLV-3 (2026-10-31): when a write saved offline is refused
 * on replay, say WHICH action did not sync and, when the server said why,
 * why — "确认收货没能同步：还有 2 项待核对" instead of the generic "a saved
 * change didn't sync, please review", which left people guessing which of
 * their taps was lost.
 */
import { useToast } from '@compass/ui';
import { useI18n } from '../hooks/useI18n';
import type { OfflineDropInfo } from '../hooks/useOfflineQueue';
import { I18N_KEY_RE } from './errorText';

type Key = Parameters<ReturnType<typeof useI18n>['t']>[0];

/** The action label for each run / receiving procedure (order changes use the generic text). */
const ACTION_KEYS: Record<string, Key> = {
  'run.purchaseItem': 'offline.action.purchaseItem',
  'run.markUnavailable': 'offline.action.markUnavailable',
  'run.deliverToStore': 'offline.action.deliverToStore',
  'run.addPurchaserItem': 'offline.action.addPurchaserItem',
  'run.addExpense': 'offline.action.addExpense',
  'run.confirmStoreItem': 'offline.action.confirmStoreItem',
  'run.markStoreItemsOk': 'offline.action.markStoreItemsOk',
  'run.confirmStore': 'offline.action.confirmStore',
};

/** The toast text for a dropped entry. Exported for tests. */
export function offlineDropText(
  t: (key: Key, values?: Record<string, string | number>) => string,
  info: OfflineDropInfo,
): string {
  // CA-25: an order change refused because the day it was made on is
  // over says so (was OrderPage's own drop handler before CMP-FE-3).
  if (info.message === 'order.errors.staleOfflineEdit') return t('order.errors.staleOfflineEdit');
  const actionKey = ACTION_KEYS[info.procedure];
  if (!actionKey) return t('run.toast.syncFailed');
  const action = t(actionKey);
  if (info.reason === 'rejected' && info.message && I18N_KEY_RE.test(info.message)) {
    const reason = t(info.message as Key);
    // An unknown key comes back as itself; do not show a raw key.
    if (reason !== info.message) return t('offline.drop.withReason', { action, reason });
  }
  return t('offline.drop.generic', { action });
}

/**
 * DX-DLV-06 (2026-11-01): a write that was saved offline and then refused
 * is lost; a 3.5-second toast went by before people read it, and the
 * page then said "nothing to receive" as if nothing had happened. The
 * toast now stays until it is dismissed with 知道了.
 */
export function offlineDropToastOptions(gotIt: string): {
  tone: 'danger';
  ttlMs: 0;
  actions: Array<{ label: string }>;
} {
  return { tone: 'danger', ttlMs: 0, actions: [{ label: gotIt }] };
}

export function useOfflineDropToast(): (info: OfflineDropInfo) => void {
  const i18n = useI18n();
  const toast = useToast();
  return (info) =>
    toast.show(offlineDropText(i18n.t, info), offlineDropToastOptions(i18n.t('common.gotIt')));
}
