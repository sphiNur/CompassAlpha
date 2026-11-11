import { useUiLabels } from '../labels';
import { EmptyState } from './EmptyState';
import { LoadingState, type LoadingStateVariant } from './LoadingState';

/**
 * React Query's offline case (R2-ENG-1 / HIS-18, 2026-10-31): with no
 * saved copy, a query waits ('paused') for the network instead of
 * failing, and loads by itself once the network is back. Read as "no
 * data", it says "there is nothing" where it should say "you are
 * offline". Review UI-13 (2026-11-11): one check and one message for
 * DataState and the screens that lay out their states themselves; the
 * check was written out in DataState, PendingSpinner and a sales panel.
 */
export function isWaitingOffline(query: { data: unknown; fetchStatus?: string }): boolean {
  return query.data === undefined && query.fetchStatus === 'paused';
}

/** What a screen says while `isWaitingOffline`. */
export function OfflineState({ compact, className }: { compact?: boolean; className?: string }) {
  const labels = useUiLabels();
  return <EmptyState compact={compact} title={labels.offlineNoData} className={className} />;
}

/**
 * A query with nothing to show yet, on a screen that lays out its states
 * itself: loading, or offline with no saved copy. Was the app's
 * PendingSpinner, a bare spinner that said nothing to a screen reader.
 */
export function PendingState({
  query,
  variant = 'compact',
  className,
}: {
  query: { data: unknown; fetchStatus?: string };
  variant?: Exclude<LoadingStateVariant, 'inline'>;
  className?: string;
}) {
  if (isWaitingOffline(query)) {
    return <OfflineState compact={variant === 'compact'} className={className} />;
  }
  return <LoadingState variant={variant} className={className} />;
}
