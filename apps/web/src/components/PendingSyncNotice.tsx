import { useI18n } from '../hooks/useI18n';

/**
 * "N changes waiting to sync" under a page's top bar while the offline
 * outbox holds writes (ORD-3 on 下单; BUY-8 on 采购 and 验收, 2026-10-30).
 * Without it a row saved offline, or while the server was unreachable,
 * looked exactly like one that was never saved.
 */
export function PendingSyncNotice({ count, saving = false }: { count: number; saving?: boolean }) {
  const i18n = useI18n();
  // R2-ORD-5 (2026-10-31): a write still without an answer after a few
  // seconds says so; on a slow network it used to look saved for 30 s.
  if (count <= 0 && !saving) return null;
  return (
    <div role="status" className="px-4 pt-2 text-old-label text-[var(--c-warning-fg)]">
      {count > 0 ? i18n.t('order.pendingSync', { n: count }) : i18n.t('common.savingSlow')}
    </div>
  );
}
