import { Spinner } from '@compass/ui';
import { useI18n } from '../hooks/useI18n';

/** No data yet and React Query is waiting for the network to come back. */
export function isWaitingOffline(query: { data: unknown; fetchStatus: string }): boolean {
  return query.data === undefined && query.fetchStatus === 'paused';
}

/**
 * The spinner a section shows while its query has no data — or, offline
 * with no saved copy, a line saying so (R2-ENG-1, 2026-10-31). A paused
 * query never finishes until the network is back, so the spinner turned
 * forever and read as "still loading".
 */
export function PendingSpinner({
  query,
  size = 20,
}: {
  query: { data: unknown; fetchStatus: string };
  size?: number;
}) {
  const i18n = useI18n();
  if (isWaitingOffline(query)) {
    return (
      <p className="px-4 text-center text-old-body-sm text-[var(--c-fg-muted)]">
        {i18n.t('common.offlineNoData')}
      </p>
    );
  }
  return <Spinner size={size} />;
}
