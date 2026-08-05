/**
 * Purchase history as a top-level, server-paginated destination.
 *
 * Search and every financial filter are sent to the API before LIMIT/OFFSET;
 * the page never downloads an org-wide ledger and filters it in the browser.
 */
import { useEffect, useMemo, useState } from 'react';
import { Banner, Button, Field, Input, SearchInput, Select, Sheet } from '@compass/ui';
import { trpc } from '../lib/trpc';
import { useI18n, useProductName } from '../hooks/useI18n';
import { RunHistoryPage } from './runs/history/RunHistory';

type PaymentFilter = 'all' | 'cash' | 'transfer' | 'mixed';
type SortOrder = 'newest' | 'oldest';

interface HistoryFilters {
  storeId: string;
  dateFrom: string;
  dateTo: string;
  payment: PaymentFilter;
  sort: SortOrder;
}

const EMPTY_FILTERS: HistoryFilters = {
  storeId: '',
  dateFrom: '',
  dateTo: '',
  payment: 'all',
  sort: 'newest',
};

function localDateValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function presetRange(days: number): Pick<HistoryFilters, 'dateFrom' | 'dateTo'> {
  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  return { dateFrom: localDateValue(start), dateTo: localDateValue(end) };
}

export function HistoryPage() {
  const i18n = useI18n();
  const productName = useProductName();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [filters, setFilters] = useState<HistoryFilters>(EMPTY_FILTERS);
  const [draftFilters, setDraftFilters] = useState<HistoryFilters>(EMPTY_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [page, setPage] = useState(1);
  const pageSize = 20;

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, filters]);

  const historyQuery = trpc.run.history.useQuery(
    {
      search: debouncedSearch || undefined,
      storeId: filters.storeId || undefined,
      dateFrom: filters.dateFrom || undefined,
      dateTo: filters.dateTo || undefined,
      payment: filters.payment === 'all' ? undefined : filters.payment,
      sort: filters.sort,
      page,
      pageSize,
    },
    { placeholderData: (previous) => previous },
  );
  // Historical rows must retain names for SKUs archived after purchase.
  const skusQuery = trpc.catalog.skus.useQuery({ includeArchived: true });
  const storesQuery = trpc.catalog.stores.useQuery({ permission: 'prices.view' });

  const skuById = useMemo(() => {
    const map = new Map<
      string,
      {
        id: string;
        names: Record<string, string>;
        unit: string;
        step: string;
        categoryId: string | null;
      }
    >();
    for (const sku of skusQuery.data ?? []) {
      map.set(sku.id, {
        id: sku.id,
        names: sku.names as Record<string, string>,
        unit: sku.unit,
        step: sku.step,
        categoryId: sku.categoryId ?? null,
      });
    }
    return map;
  }, [skusQuery.data]);

  const storeById = useMemo(() => {
    const map = new Map<string, { id: string; name: string; code: string | null }>();
    for (const store of storesQuery.data ?? []) map.set(store.id, store);
    return map;
  }, [storesQuery.data]);

  const activeFilterCount =
    Number(Boolean(filters.storeId)) +
    Number(Boolean(filters.dateFrom || filters.dateTo)) +
    Number(filters.payment !== 'all') +
    Number(filters.sort !== 'newest');
  const hasSearchOrFilters = Boolean(debouncedSearch) || activeFilterCount > 0;
  const invalidDateRange = Boolean(
    draftFilters.dateFrom && draftFilters.dateTo && draftFilters.dateFrom > draftFilters.dateTo,
  );
  const clearAll = () => {
    setSearch('');
    setDebouncedSearch('');
    setFilters(EMPTY_FILTERS);
    setDraftFilters(EMPTY_FILTERS);
    setPage(1);
  };

  const data = historyQuery.data;
  const toolbar = (
    <>
      <div className="flex gap-2">
        <SearchInput
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
          onClear={() => setSearch('')}
          placeholder={i18n.t('run.history.searchPlaceholder')}
          aria-label={i18n.t('run.history.searchPlaceholder')}
          clearAriaLabel={i18n.t('common.clear')}
          className="flex-1"
        />
        <Button
          variant={activeFilterCount > 0 ? 'primary' : 'secondary'}
          size="sm"
          onClick={() => {
            setDraftFilters(filters);
            setFiltersOpen(true);
          }}
        >
          {i18n.t('run.history.filters', { n: activeFilterCount })}
        </Button>
      </div>

      {historyQuery.isError ? (
        <Banner
          tone="danger"
          title={i18n.t('common.error')}
          action={
            <Button variant="pearl" size="sm" onClick={() => void historyQuery.refetch()}>
              {i18n.t('common.retry')}
            </Button>
          }
        />
      ) : null}

      {hasSearchOrFilters ? (
        <div
          className="flex flex-wrap items-center gap-1.5"
          aria-label={i18n.t('run.history.activeFilters')}
        >
          {filters.storeId ? (
            <FilterChip
              label={storeById.get(filters.storeId)?.name ?? filters.storeId.slice(0, 8)}
              onRemove={() => setFilters((current) => ({ ...current, storeId: '' }))}
            />
          ) : null}
          {filters.dateFrom || filters.dateTo ? (
            <FilterChip
              label={`${filters.dateFrom || '…'} – ${filters.dateTo || '…'}`}
              onRemove={() => setFilters((current) => ({ ...current, dateFrom: '', dateTo: '' }))}
            />
          ) : null}
          {filters.payment !== 'all' ? (
            <FilterChip
              label={i18n.t(`run.history.payment.${filters.payment}`)}
              onRemove={() => setFilters((current) => ({ ...current, payment: 'all' }))}
            />
          ) : null}
          {filters.sort !== 'newest' ? (
            <FilterChip
              label={i18n.t('run.history.sort.oldest')}
              onRemove={() => setFilters((current) => ({ ...current, sort: 'newest' }))}
            />
          ) : null}
          <button
            type="button"
            className="px-2 py-1 text-label font-semibold text-[var(--c-action)]"
            onClick={clearAll}
          >
            {i18n.t('run.history.clearAll')}
          </button>
        </div>
      ) : null}

      <Sheet
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        title={i18n.t('run.history.filterTitle')}
        description={i18n.t('run.history.filterDescription')}
        disableAutoFocus
        footer={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="lg"
              className="flex-1"
              onClick={() => setDraftFilters(EMPTY_FILTERS)}
            >
              {i18n.t('run.history.resetFilters')}
            </Button>
            <Button
              size="lg"
              className="flex-[2]"
              disabled={invalidDateRange}
              onClick={() => {
                setFilters(draftFilters);
                setFiltersOpen(false);
              }}
            >
              {i18n.t('run.history.applyFilters')}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4 py-2">
          <Field label={i18n.t('run.history.storeFilter')}>
            <Select
              value={draftFilters.storeId}
              onChange={(event) =>
                setDraftFilters((current) => ({ ...current, storeId: event.currentTarget.value }))
              }
            >
              <option value="">{i18n.t('run.history.allStores')}</option>
              {(storesQuery.data ?? []).map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
            </Select>
          </Field>

          <div>
            <div className="mb-2 text-label font-semibold text-[var(--c-fg-muted)]">
              {i18n.t('run.history.dateRange')}
            </div>
            <div className="mb-2 flex flex-wrap gap-2">
              {[7, 30, 90].map((days) => (
                <Button
                  key={days}
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    setDraftFilters((current) => ({ ...current, ...presetRange(days) }))
                  }
                >
                  {i18n.t('run.history.lastDays', { n: days })}
                </Button>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label={i18n.t('run.history.dateFrom')}>
                <Input
                  type="date"
                  value={draftFilters.dateFrom}
                  max={draftFilters.dateTo || undefined}
                  invalid={invalidDateRange}
                  onChange={(event) =>
                    setDraftFilters((current) => ({
                      ...current,
                      dateFrom: event.currentTarget.value,
                    }))
                  }
                />
              </Field>
              <Field label={i18n.t('run.history.dateTo')}>
                <Input
                  type="date"
                  value={draftFilters.dateTo}
                  min={draftFilters.dateFrom || undefined}
                  invalid={invalidDateRange}
                  onChange={(event) =>
                    setDraftFilters((current) => ({
                      ...current,
                      dateTo: event.currentTarget.value,
                    }))
                  }
                />
              </Field>
            </div>
            {invalidDateRange ? (
              <div className="mt-1 text-label text-[var(--c-danger)]">
                {i18n.t('run.history.invalidDateRange')}
              </div>
            ) : null}
          </div>

          <Field label={i18n.t('run.history.paymentFilter')}>
            <Select
              value={draftFilters.payment}
              onChange={(event) =>
                setDraftFilters((current) => ({
                  ...current,
                  payment: event.currentTarget.value as PaymentFilter,
                }))
              }
            >
              {(['all', 'cash', 'transfer', 'mixed'] as const).map((payment) => (
                <option key={payment} value={payment}>
                  {i18n.t(`run.history.payment.${payment}`)}
                </option>
              ))}
            </Select>
          </Field>

          <Field label={i18n.t('run.history.sortLabel')}>
            <Select
              value={draftFilters.sort}
              onChange={(event) =>
                setDraftFilters((current) => ({
                  ...current,
                  sort: event.currentTarget.value as SortOrder,
                }))
              }
            >
              <option value="newest">{i18n.t('run.history.sort.newest')}</option>
              <option value="oldest">{i18n.t('run.history.sort.oldest')}</option>
            </Select>
          </Field>
        </div>
      </Sheet>
    </>
  );

  return (
    <RunHistoryPage
      runs={data?.rows ?? []}
      loading={historyQuery.isLoading}
      fetching={historyQuery.isFetching}
      totalCount={data?.pageInfo.totalCount ?? 0}
      summaryTotal={data?.summary.total ?? '0'}
      pagination={
        data
          ? {
              ...data.pageInfo,
              onPrevious: () => setPage((current) => Math.max(1, current - 1)),
              onNext: () => setPage((current) => current + 1),
            }
          : undefined
      }
      toolbar={toolbar}
      hasSearchOrFilters={hasSearchOrFilters}
      onClearSearchOrFilters={clearAll}
      storeById={storeById}
      skuById={skuById}
      productName={productName}
      i18n={i18n}
    />
  );
}

function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <button
      type="button"
      onClick={onRemove}
      className="inline-flex min-h-8 items-center gap-1 rounded-[var(--r-pill)] bg-[var(--c-surface-2)] px-3 text-label font-medium ring-hairline"
    >
      <span className="max-w-40 truncate">{label}</span>
      <span aria-hidden className="text-[var(--c-fg-muted)]">
        ×
      </span>
    </button>
  );
}
