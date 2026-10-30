import { useI18n } from '../hooks/useI18n';

/**
 * "N changes waiting to sync" under a page's top bar while the offline
 * outbox holds writes (ORD-3 on 下单; BUY-8 on 采购 and 验收, 2026-10-30).
 * Without it a row saved offline, or while the server was unreachable,
 * looked exactly like one that was never saved.
 */
export function PendingSyncNotice({ count }: { count: number }) {
  const i18n = useI18n();
  if (count <= 0) return null;
  return (
    <div role="status" className="px-4 pt-2 text-old-label text-[var(--c-warning-fg)]">
      {i18n.t('order.pendingSync', { n: count })}
    </div>
  );
}
