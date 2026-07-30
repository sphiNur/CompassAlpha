import type { ReactNode } from 'react';
import { useUiLabels } from '../labels';
import { Banner } from './Banner';
import { EmptyState } from './EmptyState';
import { Spinner } from './Spinner';

interface QueryLike<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  isFetching?: boolean;
  error?: { message?: string } | null;
  refetch?: () => void;
}

interface DataStateProps<T> {
  query: QueryLike<T>;
  emptyWhen?: (data: T) => boolean;
  empty?: ReactNode;
  loading?: ReactNode;
  errorTitle?: ReactNode;
  children: (data: T) => ReactNode;
}

export function DataState<T>({
  query,
  emptyWhen,
  empty,
  loading,
  errorTitle,
  children,
}: DataStateProps<T>) {
  // 2026-07-30: these four strings were English literals in a package with
  // no i18n dependency, so every loading/empty/error state in the app was
  // untranslated. See packages/ui/src/labels.tsx.
  const labels = useUiLabels();
  if (query.isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-[var(--c-fg-muted)]">
        {loading ?? <Spinner size={28} />}
      </div>
    );
  }
  if (query.isError) {
    return (
      <Banner tone="danger" title={errorTitle ?? labels.errorTitle}>
        {query.error?.message ?? labels.errorUnknown}
      </Banner>
    );
  }
  if (!query.data) {
    return <EmptyState title={labels.emptyNoData} />;
  }
  if (emptyWhen?.(query.data)) {
    return <>{empty ?? <EmptyState title={labels.emptyNothingYet} />}</>;
  }
  return <>{children(query.data)}</>;
}
