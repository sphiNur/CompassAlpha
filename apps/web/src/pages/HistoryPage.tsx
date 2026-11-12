/**
 * Purchase history as a top-level, server-paginated destination.
 *
 * Search and every financial filter are sent to the API before LIMIT/OFFSET;
 * the page never downloads an org-wide ledger and filters it in the browser.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Field,
  FieldGroup,
  Input,
  QueryErrorBanner,
  SearchInput,
  Select,
  Sheet,
  pillButtonClass,
} from '@compass/ui';
import type { PaymentMethod } from '@compass/contracts';
import { trpc } from '../lib/trpc';
import { useDateFormat, useI18n } from '../hooks/useI18n';
import { RunHistoryPage } from './runs/history/RunHistory';
import { useAuthStore } from '../stores/authStore';
import { useReportStore } from '../hooks/useReportStore';
// 2026-10-21 audit CA-23: shared with the Finance presets (one local-
// calendar date helper instead of two copies).
import { localDateValue } from '../lib/calendarDate';

type PaymentFilter = 'all' | PaymentMethod | 'mixed';
type SortOrder = 'newest' | 'oldest';

interface HistoryFilters {
  /** Not used for the query: the store comes from useReportStore. */
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

/** HIS-13 (2026-10-30): days counted on the org's calendar. */
function presetRange(days: number, timeZone?: string): Pick<HistoryFilters, 'dateFrom' | 'dateTo'> {
  const end = new Date();
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  return { dateFrom: localDateValue(start, timeZone), dateTo: localDateValue(end, timeZone) };
}

export function HistoryPage() {
  const i18n = useI18n();
  const dates = useDateFormat();
  const orgTimeZone = useAuthStore((s) => s.session?.member.timezone);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [otherFilters, setFilters] = useState<HistoryFilters>(EMPTY_FILTERS);
  const [draftFilters, setDraftFilters] = useState<HistoryFilters>(EMPTY_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const pageSize = 20;

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const storesQuery = trpc.catalog.stores.useQuery({ permission: 'prices.view' });
  // CMP-HIS-1 (2026-10-31): start on the top bar's store, not all stores.
  const reportStore = useReportStore(storesQuery.data ?? (storesQuery.isError ? [] : undefined));
  const filters: HistoryFilters = useMemo(
    () => ({ ...otherFilters, storeId: reportStore.storeId }),
    [otherFilters, reportStore.storeId],
  );
  const applyFilters = (next: HistoryFilters) => {
    reportStore.setStoreId(next.storeId);
    setFilters(next);
  };

  // RUNWEB2-27: a page belongs to one search and filter set. A new set
  // reads page 1 in the same render, wherever it changed (the sheet, a
  // chip, the search, the top bar's store), so no request goes out for
  // page N of the new set. An effect that reset the page ran a render
  // late and fetched that page first.
  const pagingKey = JSON.stringify([debouncedSearch, filters]);
  const [paging, setPaging] = useState({ key: pagingKey, page: 1 });
  const page = paging.key === pagingKey ? paging.page : 1;
  const setPage = (next: (current: number) => number) =>
    setPaging({ key: pagingKey, page: next(page) });

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
    { placeholderData: (previous) => previous, enabled: reportStore.ready },
  );
  // Historical rows must retain names for SKUs archived after purchase.
  const skusQuery = trpc.catalog.skus.useQuery({ includeArchived: true });

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
        names: sku.names,
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
    applyFilters(EMPTY_FILTERS);
    setDraftFilters(EMPTY_FILTERS);
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
        {/* md: the same 44px as the search field beside it (D18). */}
        <Button
          variant={activeFilterCount > 0 ? 'primary' : 'secondary'}
          className="shrink-0"
          onClick={() => {
            setDraftFilters(filters);
            setFiltersOpen(true);
          }}
        >
          {activeFilterCount > 0
            ? i18n.t('run.history.filters', { n: activeFilterCount })
            : i18n.t('run.history.filtersButton')}
        </Button>
      </div>

      {historyQuery.isError ? <QueryErrorBanner query={historyQuery} /> : null}

      {/* DX-VIS-6 / DX-VIS-8 (2026-11-01): the chips tap at 44px; 12px
          between wrapped rows keeps one row's tap area off the next. */}
      <div
        className="flex flex-wrap items-center gap-x-1.5 gap-y-3"
        aria-label={i18n.t('run.history.activeFilters', { n: activeFilterCount })}
      >
        {/* CMP-HIS-1: always say which stores the list and its total cover. */}
        {filters.storeId ? (
          <FilterChip
            label={storeById.get(filters.storeId)?.name ?? i18n.t('common.unknownStore')}
            onRemove={() => reportStore.setStoreId('')}
          />
        ) : (
          <span className="px-1 text-old-label font-semibold text-[var(--c-fg-muted)]">
            {i18n.t('run.history.allStores')}
          </span>
        )}
        {hasSearchOrFilters ? (
          <>
          {filters.dateFrom || filters.dateTo ? (
            <FilterChip
              // RUNWEB2-24: the days as the list shows them, not ISO.
              label={`${dates.calendarDay(filters.dateFrom) || '…'} – ${dates.calendarDay(filters.dateTo) || '…'}`}
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
          {/* RUNWEB2-23: the kit's text button. */}
          <Button variant="ghost" size="sm" onClick={clearAll}>
            {i18n.t('run.history.clearAll')}
          </Button>
          </>
        ) : null}
      </div>

      <Sheet
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        title={i18n.t('run.history.filterTitle')}
        description={i18n.t('run.history.filterDescription')}
        disableAutoFocus
        footer={
          // Review RUNWEB2-10: stacked like every two-button sheet footer.
          // Side by side at 1:2, "Reset filters" was cut short on a phone.
          <div className="flex flex-col gap-2">
            <Button
              block
              disabled={invalidDateRange}
              onClick={() => {
                applyFilters(draftFilters);
                setFiltersOpen(false);
              }}
            >
              {i18n.t('run.history.applyFilters')}
            </Button>
            <Button block variant="pearl" onClick={() => setDraftFilters(EMPTY_FILTERS)}>
              {i18n.t('run.history.resetFilters')}
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

          <FieldGroup
            label={i18n.t('run.history.dateRange')}
            error={invalidDateRange ? i18n.t('run.errors.invalidDateRange') : null}
          >
            <div className="mb-2 flex flex-wrap gap-2">
              {[7, 30, 90].map((days) => (
                <Button
                  key={days}
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    setDraftFilters((current) => ({ ...current, ...presetRange(days, orgTimeZone) }))
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
          </FieldGroup>

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
      failed={historyQuery.isError && !data}
      waitingOffline={!data && historyQuery.fetchStatus === 'paused'}
      totalCount={data?.pageInfo.totalCount ?? 0}
      summaryTotal={data?.summary.total ?? '0'}
      summaryItemsTotal={data?.summary.itemsTotal ?? '0'}
      summaryExpensesTotal={data?.summary.expensesTotal ?? '0'}
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
    />
  );
}

/**
 * An active filter; a tap removes it. Review RUNWEB2-23 / RUNWEB2-32: the
 * kit's chip look, and a name that says what the tap does (the "×" is
 * hidden from screen readers).
 */
function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  const i18n = useI18n();
  return (
    <button
      type="button"
      onClick={onRemove}
      aria-label={i18n.t('run.history.removeFilter', { label })}
      className={`${pillButtonClass()} gap-1`}
    >
      <span className="max-w-40 truncate">{label}</span>
      <span aria-hidden className="text-[var(--c-fg-muted)]">
        ×
      </span>
    </button>
  );
}
