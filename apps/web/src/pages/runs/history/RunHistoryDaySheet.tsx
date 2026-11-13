/**
 * Day summary for a day with several runs (2026-10-23).
 *
 * The run detail sheet is per run, so a day of two trips had no place
 * that showed the day as a whole. This one does, from the history rows
 * already loaded (no extra request): the day's total with items /
 * expenses and cash / transfer, each store's settlement summed over the
 * trips, and the trips themselves. A store or a trip opens the usual
 * run detail sheet for the item lines.
 */
import { useMemo } from 'react';
import { Button, SectionLabel, Sheet, surfaceClass } from '@compass/ui';
import { useDateFormat, useI18n } from '../../../hooks/useI18n';
import { formatMoney } from '../../../lib/format';
import { dayStoreSummaries, type HistoryDay } from '../lib/historyGroups';
import type { RunListRow, StoreLite } from '../types';
import { detailTargetOf, type HistoryDetailTarget } from './detailTarget';
import { MoneySummaryPanel } from './MoneySummaryPanel';

export function RunHistoryDaySheet({
  day,
  storeById,
  onOpenRun,
  onClose,
}: {
  day: HistoryDay | null;
  storeById: Map<string, StoreLite>;
  onOpenRun: (target: HistoryDetailTarget) => void;
  onClose: () => void;
}) {
  const i18n = useI18n();
  const dates = useDateFormat();
  const stores = useMemo(() => (day ? dayStoreSummaries(day) : []), [day]);
  const trips = useMemo(
    () => (day ? [...day.runs].sort((a, b) => a.runIndex - b.runIndex) : []),
    [day],
  );
  const open = (run: RunListRow, initialStoreId?: string) =>
    onOpenRun(detailTargetOf(run, initialStoreId));
  const storeName = (id: string) => storeById.get(id)?.name ?? i18n.t('common.unknownStore');
  const rowClass =
    'flex w-full flex-col gap-1 border-b border-[var(--c-divider)] px-4 py-3 text-left last:border-b-0 active:bg-[var(--c-bg)]';

  return (
    <Sheet
      open={!!day}
      onOpenChange={(open) => !open && onClose()}
      title={dates.calendarDay(day?.runDate)}
      description={day ? i18n.t('run.history.tripCount', { n: day.runs.length }) : undefined}
    >
      {!day ? null : (
        <div className="flex flex-col gap-4 py-3">
          <MoneySummaryPanel
            total={day.total}
            itemsTotal={day.itemsTotal}
            expensesTotal={day.expensesTotal}
            cash={day.cash}
            transfer={day.transfer}
          />

          {stores.length > 0 ? (
            <div>
              <SectionLabel padded={false} className="mb-2">
                {i18n.t('run.history.storesHeading')}
              </SectionLabel>
              <ul className={`flex flex-col ${surfaceClass}`}>
                {stores.map((st) => {
                  const body = (
                    <>
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 flex-1 truncate text-old-body font-semibold">
                          {storeName(st.storeId)}
                        </span>
                        <span className="text-old-body font-semibold tabular-nums">
                          {formatMoney(st.total)}
                        </span>
                      </div>
                      <div className="flex items-baseline justify-between gap-2 text-old-label text-[var(--c-fg-muted)]">
                        <span>{i18n.t('run.label.itemsCount', { n: st.itemCount })}</span>
                        <span className="tabular-nums">
                          {i18n.t('run.money.cashTransfer', {
                            cash: formatMoney(st.cash),
                            transfer: formatMoney(st.transfer),
                          })}
                        </span>
                      </div>
                    </>
                  );
                  // One trip: the row opens it. Several: one link per trip.
                  return st.lines.length === 1 ? (
                    <li key={st.storeId}>
                      <button
                        type="button"
                        onClick={() => open(st.lines[0]!.run, st.storeId)}
                        className={rowClass}
                      >
                        {body}
                        <span className="text-old-label text-[var(--c-fg-muted)]">
                          {i18n.t('run.history.trip', { n: st.lines[0]!.trip })}
                        </span>
                      </button>
                    </li>
                  ) : (
                    <li
                      key={st.storeId}
                      className="flex flex-col gap-1 border-b border-[var(--c-divider)] px-4 py-3 last:border-b-0"
                    >
                      {body}
                      <div className="flex flex-wrap gap-x-1.5 gap-y-3 pt-1">
                        {st.lines.map((line) => (
                          <Button
                            size="sm"
                            variant="secondary"
                            key={line.run.id}
                            onClick={() => open(line.run, st.storeId)}
                          >
                            {i18n.t('run.history.trip', { n: line.trip })} ·{' '}
                            <span className="tabular-nums">{formatMoney(line.total)}</span>
                          </Button>
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}

          <div>
            <SectionLabel padded={false} className="mb-2">
              {i18n.t('run.history.tripsHeading')}
            </SectionLabel>
            <ul className={`flex flex-col ${surfaceClass}`}>
              {trips.map((run) => (
                <li key={run.id}>
                  <button type="button" onClick={() => open(run)} className={rowClass}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-old-body font-semibold">
                        {i18n.t('run.history.trip', { n: run.runIndex + 1 })}
                      </span>
                      <span className="text-old-body font-semibold tabular-nums">
                        {run.actualTotal ? formatMoney(run.actualTotal) : '—'}
                      </span>
                    </div>
                    <span className="truncate text-old-label text-[var(--c-fg-muted)]">
                      {(run.storeTotals ?? [])
                        .map((st) => storeName(st.storeId))
                        .join(i18n.t('common.listSeparator'))}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Sheet>
  );
}
