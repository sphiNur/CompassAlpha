import type { ReactNode } from 'react';
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
  if (query.isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-[var(--c-fg-muted)]">
        {loading ?? <Spinner size={28} />}
      </div>
    );
  }
  if (query.isError) {
    return (
      <Banner tone="danger" title={errorTitle ?? 'Something went wrong'}>
        {query.error?.message ?? 'Unknown error'}
      </Banner>
    );
  }
  if (!query.data) {
    return <EmptyState title="No data" />;
  }
  if (emptyWhen?.(query.data)) {
    return <>{empty ?? <EmptyState title="Nothing here yet" />}</>;
  }
  return <>{children(query.data)}</>;
}
