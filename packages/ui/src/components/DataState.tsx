import type { ReactNode } from 'react';
import { useUiLabels } from '../labels';
import { Banner } from './Banner';
import { Button } from './Button';
import { resolveDataStateError } from './dataStateError';
import { EmptyState } from './EmptyState';
import { Spinner } from './Spinner';

interface QueryLike<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  isFetching?: boolean;
  error?: { message?: string } | null;
  refetch?: () => unknown;
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
    return <QueryErrorBanner query={query} title={errorTitle} />;
  }
  if (!query.data) {
    return <EmptyState title={labels.emptyNoData} />;
  }
  if (emptyWhen?.(query.data)) {
    return <>{empty ?? <EmptyState title={labels.emptyNothingYet} />}</>;
  }
  return <>{children(query.data)}</>;
}

/**
 * DataState's error state on its own, for screens that lay out loading /
 * empty / list themselves (CLS-1 / F11, 2026-10-30: the inventory list
 * checked only `isLoading`, so a failed load read "no stock data yet" and
 * offered actions on top of it). Translated message plus a retry, so a
 * dropped connection is recoverable without leaving the page.
 */
export function QueryErrorBanner({
  query,
  title,
}: {
  query: Pick<QueryLike<unknown>, 'isFetching' | 'error' | 'refetch'>;
  title?: ReactNode;
}) {
  // 2026-10-21 FE-10: translated message (not the raw i18n key) plus a
  // retry, so a dropped connection is recoverable without leaving the page.
  const labels = useUiLabels();
  const refetch = query.refetch;
  return (
    <Banner
      tone="danger"
      title={title ?? labels.errorTitle}
      action={
        refetch ? (
          <Button
            size="sm"
            variant="secondary"
            loading={query.isFetching}
            disabled={query.isFetching}
            onClick={() => {
              void refetch();
            }}
          >
            {labels.retry}
          </Button>
        ) : null
      }
    >
      {resolveDataStateError(query.error, labels.translateError, labels.errorUnknown)}
    </Banner>
  );
}
