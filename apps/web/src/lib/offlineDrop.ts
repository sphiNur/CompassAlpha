/**
 * RE-DLV-4 / R2-DLV-3 (2026-10-31): when a write saved offline is refused
 * on replay, say WHICH action did not sync and, when the server said why,
 * why — "确认收货没能同步：还有 2 项待核对" instead of the generic "a saved
 * change didn't sync, please review", which left people guessing which of
 * their taps was lost.
 */
import type { CatalogKey as Key } from '@compass/i18n';
import type { OfflineDropInfo } from './outbox/engine';
import type { ReplayedProcedure } from './outbox/replayHandlers';
import { isErrorKey, withoutFinalStop } from './errorText';
import { formatMoney, formatQty } from './format';

/** The action label for each run / receiving procedure (order changes use the generic text). */
const ACTION_KEYS: { readonly [P in ReplayedProcedure]?: Key } = {
  'run.purchaseItem': 'offline.action.purchaseItem',
  'run.markUnavailable': 'offline.action.markUnavailable',
  'run.deliverToStore': 'offline.action.deliverToStore',
  'run.addPurchaserItem': 'offline.action.addPurchaserItem',
  'run.addExpense': 'offline.action.addExpense',
  'run.confirmStoreItem': 'offline.action.confirmStoreItem',
  'run.markStoreItemsOk': 'offline.action.markStoreItemsOk',
  'run.confirmStore': 'offline.action.confirmStore',
};
/** The same map by any name: a dropped entry may come from another bundle. */
const actionKeyByName: Readonly<Record<string, Key | undefined>> = ACTION_KEYS;

/**
 * Plan 2.4 (2026-11-23): what the dropped write was, from its own input:
 * "Rice 4 × 12,000", "Onion 2", "Taxi 1 × 30,000". The notice named only
 * the action, and with ten purchases dropped after a run was finished
 * nobody could tell which to enter again. `nameOf` finds a product's name
 * (the cached catalogue); without it the line still has the numbers.
 * Null when the input names nothing worth showing.
 */
export function droppedWhat(
  input: unknown,
  nameOf: (skuId: string) => string | undefined,
): string | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const name = (text(i.skuId) && nameOf(text(i.skuId)!)) || text(i.label);
  const qty = text(i.actualQty) ?? text(i.qty) ?? text(i.receivedQty);
  const price = text(i.unitPrice);
  const amount = qty
    ? price
      ? `${formatQty(qty)} × ${formatMoney(price)}`
      : formatQty(qty)
    : undefined;
  const parts = [name, amount].filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(' ') : null;
}

/** The toast text for a dropped entry. Exported for tests. */
export function offlineDropText(
  t: (key: Key, values?: Record<string, string | number>) => string,
  info: OfflineDropInfo,
  what?: string | null,
): string {
  const text = offlineDropSentence(t, info);
  return what ? `${text} ${t('offline.drop.detail', { what })}` : text;
}

function offlineDropSentence(
  t: (key: Key, values?: Record<string, string | number>) => string,
  info: OfflineDropInfo,
): string {
  // CA-25: an order change refused because the day it was made on is
  // over says so (was OrderPage's own drop handler before CMP-FE-3).
  if (info.message === 'order.errors.staleOfflineEdit') return t('order.errors.staleOfflineEdit');
  const actionKey = actionKeyByName[info.procedure];
  if (!actionKey) return t('run.toast.syncFailed');
  const action = t(actionKey);
  // A key this build does not know is not shown (isErrorKey). The
  // template ends the reason's sentence itself (I18N1-20: errors end with
  // a full stop), so drop the reason's own.
  if (info.reason === 'rejected' && isErrorKey(info.message)) {
    const reason = withoutFinalStop(t(info.message));
    return t('offline.drop.withReason', { action, reason });
  }
  return t('offline.drop.generic', { action });
}

/**
 * DX-DLV-06 (2026-11-01): a write that was saved offline and then refused
 * is lost; a 3.5-second toast went by before people read it, and the
 * page then said "nothing to receive" as if nothing had happened. The
 * toast now stays until it is dismissed with 知道了. The app shows it
 * from hooks/useOutboxReplay.ts.
 */
export function offlineDropToastOptions(
  gotIt: string,
  /** Refresh for a stale version (UX-22), or Retry for a write given up on (plan 2.4). */
  refresh?: { label: string; onClick: () => void },
): {
  tone: 'danger';
  ttlMs: 0;
  actions: Array<{ label: string; onClick?: () => void; emphasis?: 'primary' }>;
} {
  // UX-22: a write refused for a stale version also offers Refresh.
  const actions = refresh
    ? [{ ...refresh, emphasis: 'primary' as const }, { label: gotIt }]
    : [{ label: gotIt }];
  return { tone: 'danger', ttlMs: 0, actions };
}
