/**
 * One day of the history list: its date and totals, then each store's
 * purchase that day (2026-10-23: one entry per day, not per run).
 */
import { Badge } from '@compass/ui';
import { useDateFormat, useI18n } from '../../../hooks/useI18n';
import { formatMoney } from '../../../lib/format';
import type { HistoryDay } from '../lib/historyGroups';
import type { RunListRow, StoreLite } from '../types';
import { detailTargetOf, type HistoryDetailTarget } from './detailTarget';

// A11Y-1 (2026-10-31): flex-wrap — at 200% zoom the totals drop under the
// date instead of running off the screen.
const HEADER_CLASS =
  'flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-3 text-left';

export function HistoryDayRow({
  day,
  storeById,
  onOpenRun,
  onOpenDay,
}: {
  day: HistoryDay;
  storeById: Map<string, StoreLite>;
  onOpenRun: (target: HistoryDetailTarget) => void;
  /** A day with several trips opens the day summary first. */
  onOpenDay: (day: HistoryDay) => void;
}) {
  const i18n = useI18n();
  const dates = useDateFormat();
  const single = day.runs.length === 1 ? day.runs[0]! : null;
  const open = (run: RunListRow, initialStoreId?: string) =>
    onOpenRun(detailTargetOf(run, initialStoreId));
  const headerBody = (
    <>
      {/* UIUX-B1 (2026-07-06): constant success Badge with the raw status
          enum deleted (list is finished-only — it never varied, and leaked
          English; UI-2). The mono total takes the freed right slot (L2
          settlement row). */}
      <div className="min-w-[7rem] flex-1 text-old-body font-semibold tabular-nums">
        {/* D16 / RE-COPY-1: date in the UI language; the trip number's
            sign comes from the catalog. */}
        {single && single.runIndex > 0
          ? i18n.t('run.history.runTitle', {
              date: dates.calendarDay(day.runDate),
              n: single.runIndex + 1,
            })
          : dates.calendarDay(day.runDate)}
        {/* D5 (2026-10-31): a run reopened for amending stays listed,
            marked as such. */}
        {day.runs.some((r) => r.status === 'amending') ? (
          <Badge tone="warn" className="ml-2 align-middle">
            {i18n.t('run.status.amending')}
          </Badge>
        ) : null}
        {!single ? (
          <span className="ml-2 text-old-label font-normal text-[var(--c-fg-muted)]">
            {i18n.t('run.history.tripCount', { n: day.runs.length })}
          </span>
        ) : null}
      </div>
      <span className="ml-auto flex shrink-0 flex-col items-end">
        <span className="text-old-body tabular-nums">
          {day.runs.some((r) => r.actualTotal) ? formatMoney(day.total) : '—'}
        </span>
        {day.expensesTotal > 0 ? (
          <span className="text-old-label tabular-nums text-[var(--c-fg-muted)]">
            {i18n.t('run.money.itemsExpenses', {
              items: formatMoney(day.itemsTotal),
              expenses: formatMoney(day.expensesTotal),
            })}
          </span>
        ) : null}
        {day.cash !== null && day.transfer !== null && day.total > 0 ? (
          <span className="text-old-label tabular-nums text-[var(--c-fg-muted)]">
            {i18n.t('run.money.cashTransfer', {
              cash: formatMoney(day.cash),
              transfer: formatMoney(day.transfer),
            })}
          </span>
        ) : null}
      </span>
    </>
  );
  // Trips without per-store rows (legacy) still need a way in.
  const bareTrips = single ? [] : day.runs.filter((r) => (r.storeTotals?.length ?? 0) === 0);
  return (
    <li className="border-b border-[var(--c-divider)] last:border-b-0">
      {single ? (
        <button
          type="button"
          onClick={() => open(single)}
          className={`${HEADER_CLASS} active:bg-[var(--c-surface-2)]`}
        >
          {headerBody}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => onOpenDay(day)}
          className={`${HEADER_CLASS} active:bg-[var(--c-surface-2)]`}
        >
          {headerBody}
        </button>
      )}
      {day.storeLines.length > 0 || bareTrips.length > 0 ? (
        <div className="border-t border-[var(--c-divider)] px-4 py-2.5">
          <div className="mb-1.5 text-old-label font-semibold text-[var(--c-fg-muted)]">
            {i18n.t('run.history.storePurchases')}
          </div>
          <div className="flex flex-col gap-1">
            {day.storeLines.map((line) => {
              const storeName = storeById.get(line.storeId)?.name ?? i18n.t('common.unknownStore');
              return (
                <button
                  key={`${line.run.id}:${line.storeId}`}
                  type="button"
                  onClick={() => open(line.run, line.storeId)}
                  // Flattened (2026-07-05): dropped the nested rounded-card
                  // + ring-hairline + surface-2 (a card inside the history
                  // Card). These rows already sit in the Card's own
                  // bordered region, so a plain row reads cleaner.
                  className="flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2 text-left active:bg-[var(--c-surface-2)]"
                >
                  <span className="min-w-0 flex-1 truncate text-old-body-sm font-medium">
                    {storeName}
                    {!single ? (
                      <span className="ml-1.5 text-old-label font-normal text-[var(--c-fg-muted)]">
                        {i18n.t('run.history.trip', { n: line.trip })}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-old-label text-[var(--c-fg-muted)]">
                    {i18n.t('run.label.itemsCount', { n: line.itemCount })}
                  </span>
                  <span className="shrink-0 text-old-label font-semibold tabular-nums">
                    {formatMoney(line.total)}
                  </span>
                </button>
              );
            })}
            {bareTrips.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => open(run)}
                className="flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2 text-left active:bg-[var(--c-surface-2)]"
              >
                <span className="min-w-0 flex-1 truncate text-old-body-sm font-medium">
                  {i18n.t('run.history.trip', { n: run.runIndex + 1 })}
                </span>
                <span className="shrink-0 text-old-label font-semibold tabular-nums">
                  {run.actualTotal ? formatMoney(run.actualTotal) : '—'}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </li>
  );
}
