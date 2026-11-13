/**
 * The run history screen: the History tab's list of days and its totals.
 * Extracted verbatim from RunPage.tsx (Phase 4 step 2 of the 2026-07
 * frontend audit's run-domain split).
 *
 * Review RUNWEB2-09 (2026-11-12): this file held the whole history
 * subsystem (1,400 lines). Each part is its own file in this folder now:
 *   - HistoryDayRow          one day of the list.
 *   - RunHistoryDaySheet     a day of several trips, as a whole.
 *   - RunHistoryDetailSheet  one run's breakdown (items, prices, per-store
 *                            settlement, expenses), with HistoryItemRow,
 *                            StoreSettlementList, HistoryExpenseList and
 *                            the super-admin RunCorrectionForms.
 *   - MoneySummaryPanel      the money at the top of both sheets.
 *
 * 2026-07-30: `RunHistorySection` — the summary card that used to sit
 * at the bottom of RunPage — is gone. History is its own bottom-nav
 * tab now (pages/HistoryPage.tsx), so the card had no caller: its
 * whole job was to be the doorway from the run page, and that doorway
 * was also the reason only `run.purchase` holders could see history at
 * all. Recover it from git if a "last run / month so far" summary is
 * ever wanted back on the run page.
 *
 * Detail reads use the store-trimmed `run.historyDetail` query; its money
 * is the server's (runs/lib/historyBreakdown.ts). Only super-admin
 * correction actions mutate a finished run.
 */
import { addMoney } from '@compass/contracts/money';
import { useState, type ReactNode } from 'react';
import { Button, Card, EmptyState, LoadingState, OfflineState, SectionLabel } from '@compass/ui';
import { formatMoney } from '../../../lib/format';
import { useI18n } from '../../../hooks/useI18n';
import { useCurrency } from '../../../hooks/useCurrency';
import { groupRunsByDay, type HistoryDay } from '../lib/historyGroups';
import type { RunListRow, SkuLite, StoreLite } from '../types';
import type { HistoryDetailTarget } from './detailTarget';
import { HistoryDayRow } from './HistoryDayRow';
import { RunHistoryDaySheet } from './RunHistoryDaySheet';
import { RunHistoryDetailSheet } from './RunHistoryDetailSheet';

// ====================================================================
// HISTORY VIEW
// ====================================================================
// The user explicitly asked: "配送完成、验货完成之后需要入档,需要能看到
// 每天购买的记录,数量价格这些都要能看到历史记录" — after delivery and
// confirmation, sessions should be archived; we need to see daily
// purchase history, quantities, prices.
//
// Implementation: run.history returns the finished and cancelled runs,
// filtered and paged on the server. Tapping a row opens the detail sheet,
// which fetches run.historyDetail for the full breakdown (items, prices,
// store splits).

interface HistoryPagination {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasPrevious: boolean;
  hasNext: boolean;
  /** DX-HIS-5: positions of the page's first / last run (pages hold whole days). */
  firstRun?: number;
  lastRun?: number;
  onPrevious: () => void;
  onNext: () => void;
}

export function RunHistoryPage({
  runs,
  loading,
  fetching = false,
  failed = false,
  waitingOffline = false,
  totalCount,
  summaryTotal,
  summaryItemsTotal,
  summaryExpensesTotal,
  pagination,
  toolbar,
  hasSearchOrFilters = false,
  onClearSearchOrFilters,
  storeById,
  skuById,
}: {
  runs: RunListRow[];
  loading: boolean;
  fetching?: boolean;
  /** F11: the list failed to load — no "0 · 0" count/total in the header. */
  failed?: boolean;
  /**
   * R2-SHL-2 (2026-10-31): offline with no saved copy of the list — say
   * so, rather than "loading…" under a "0 · 0 UZS" header.
   */
  waitingOffline?: boolean;
  totalCount?: number;
  summaryTotal?: string;
  /** 2026-10-21 CA-11: parts of summaryTotal. */
  summaryItemsTotal?: string;
  summaryExpensesTotal?: string;
  pagination?: HistoryPagination;
  toolbar?: ReactNode;
  hasSearchOrFilters?: boolean;
  onClearSearchOrFilters?: () => void;
  storeById: Map<string, StoreLite>;
  skuById: Map<string, SkuLite>;
}) {
  const i18n = useI18n();
  const [detailFor, setDetailFor] = useState<HistoryDetailTarget | null>(null);
  /** 2026-10-23: a day with several trips opens a day summary first. */
  const [dayFor, setDayFor] = useState<HistoryDay | null>(null);
  const currency = useCurrency();
  const total =
    summaryTotal ?? String(runs.reduce((sum, run) => addMoney(sum, run.actualTotal), 0));
  const count = totalCount ?? runs.length;
  // DX-HIS-5 (2026-11-01): a page holds whole days, so it can hold more or
  // fewer runs than pageSize; the server says which ones.
  const firstResult =
    pagination?.firstRun ??
    (pagination && pagination.totalCount > 0 ? (pagination.page - 1) * pagination.pageSize + 1 : 0);
  const lastResult =
    pagination?.lastRun ??
    (pagination ? Math.min(pagination.page * pagination.pageSize, pagination.totalCount) : count);

  return (
    <div className="flex flex-col gap-3 px-4 pb-24 pt-3">
      {/* A tab page: no title row. A lone <h1> reading "历史记录" above a
          card whose own header reads "历史记录  12 · 1,234,567.8 UZS" said
          the same word twice. The card header IS the page heading
          (`as="h1"`); the bottom nav names the page. Review UI-14: the
          Back variant of the title row had no caller and is gone. */}
      {toolbar}
      <Card className={fetching && !loading ? 'opacity-70 transition-opacity' : undefined}>
        <SectionLabel
          as="h1"
          // HIS-20 (2026-10-30): with a search, the total is of the whole
          // runs that matched, not of the product searched for.
          // R2-SHL-2: no count or total until there is a list to count.
          meta={
            failed || loading || waitingOffline
              ? undefined
              : // HIS-17 (2026-10-31): the rows are days, the count is trips —
                // say "3 trips" so a day holding two doesn't read as missing.
                // RUNWEB2-24: the amount sits in the catalog's sentence
                // (「…（符合条件的合计）」), not glued before it.
                `${i18n.t('run.history.tripCount', { n: count })} · ${
                  hasSearchOrFilters
                    ? i18n.t('run.history.matchedRunsTotal', {
                        total: formatMoney(total, currency),
                      })
                    : formatMoney(total, currency)
                }`
          }
        >
          {i18n.t('run.history.title')}
        </SectionLabel>
        {/* 2026-10-21 CA-11: total = items + expenses, shown as its parts
            whenever expenses are part of it. */}
        {!loading && Number(summaryExpensesTotal ?? 0) > 0 ? (
          <div className="px-4 pb-2 text-old-label tabular-nums text-[var(--c-fg-muted)]">
            {i18n.t('run.money.itemsExpenses', {
              items: formatMoney(summaryItemsTotal ?? '0'),
              expenses: formatMoney(summaryExpensesTotal ?? '0'),
            })}
          </div>
        ) : null}
        {waitingOffline ? (
          <OfflineState />
        ) : loading ? (
          <LoadingState />
        ) : failed ? null : runs.length === 0 ? (
          // R2-HIS-2 (2026-10-31): a failed load shows its error banner
          // above; "no runs match — clear all" under it blamed the filters.
          // RUNWEB2-21: the kit's empty state; with no runs at all it said
          // "past runs — tap to see details" over an empty list.
          <EmptyState
            title={i18n.t(hasSearchOrFilters ? 'run.history.noMatches' : 'run.history.empty')}
            action={
              hasSearchOrFilters && onClearSearchOrFilters ? (
                <Button variant="secondary" size="sm" onClick={onClearSearchOrFilters}>
                  {i18n.t('run.history.clearAll')}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="flex flex-col" role="list">
            {/* 2026-10-23: one entry per day. A day's second trip (or a run
                moved onto the day) used to be its own "date #2" row, so
                one day's spend read as two days; see lib/historyGroups. */}
            {groupRunsByDay(runs).map((day) => (
              <HistoryDayRow
                key={day.runDate}
                day={day}
                storeById={storeById}
                onOpenRun={setDetailFor}
                onOpenDay={setDayFor}
              />
            ))}
          </ul>
        )}
      </Card>
      {pagination && pagination.totalCount > 0 ? (
        // RUNWEB2-33: wraps on a narrow phone (the Russian page buttons are
        // long) instead of running off the screen.
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-3 px-1">
          <span className="min-w-0 text-old-label tabular-nums text-[var(--c-fg-muted)]">
            {i18n.t('run.history.tripRange', {
              from: firstResult,
              to: lastResult,
              total: pagination.totalCount,
            })}
          </span>
          <div className="ml-auto flex flex-wrap justify-end gap-x-2 gap-y-3">
            <Button
              variant="secondary"
              size="sm"
              disabled={!pagination.hasPrevious || fetching}
              onClick={pagination.onPrevious}
            >
              {i18n.t('run.history.previousPage')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={!pagination.hasNext || fetching}
              onClick={pagination.onNext}
            >
              {i18n.t('run.history.nextPage')}
            </Button>
          </div>
        </div>
      ) : null}
      <RunHistoryDaySheet
        day={dayFor}
        storeById={storeById}
        onOpenRun={(target) => {
          setDayFor(null);
          setDetailFor(target);
        }}
        onClose={() => setDayFor(null)}
      />
      <RunHistoryDetailSheet
        target={detailFor}
        skuById={skuById}
        storeById={storeById}
        onClose={() => setDetailFor(null)}
      />
    </div>
  );
}
