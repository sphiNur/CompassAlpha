/**
 * History list: one entry per DAY, not per run (2026-10-23).
 *
 * A day can hold several runs (#1, #2 … — a second trip, or a run moved
 * onto the day with "change purchase date"). The list used to show each
 * as its own "2026-10-22" / "2026-10-22 #2" row, so one day's spend read
 * as two days. Rows are grouped by runDate (input order kept — the
 * server sorts newest first) with the day's totals summed; each store
 * line still points at the run it came from, because the detail sheet is
 * per run.
 *
 * Pure; tests in __tests__/historyGroups.test.ts.
 */
import type { RunListRow, RunListStoreTotal } from '../history/RunHistory';

export type HistoryStoreLine = RunListStoreTotal & {
  run: RunListRow;
  /** 1-based trip number, shown only when the day has several runs. */
  trip: number;
};

export type HistoryDay = {
  runDate: string;
  runs: RunListRow[];
  total: number;
  itemsTotal: number;
  expensesTotal: number;
  /** null when any run predates the cash/transfer split. */
  cash: number | null;
  transfer: number | null;
  storeLines: HistoryStoreLine[];
};

const num = (v: string | null | undefined) => Number(v ?? 0) || 0;

export function groupRunsByDay(runs: readonly RunListRow[]): HistoryDay[] {
  const days: HistoryDay[] = [];
  const byDate = new Map<string, HistoryDay>();
  for (const run of runs) {
    let day = byDate.get(run.runDate);
    if (!day) {
      day = {
        runDate: run.runDate,
        runs: [],
        total: 0,
        itemsTotal: 0,
        expensesTotal: 0,
        cash: 0,
        transfer: 0,
        storeLines: [],
      };
      byDate.set(run.runDate, day);
      days.push(day);
    }
    day.runs.push(run);
    day.total += num(run.actualTotal);
    day.itemsTotal += num(run.itemsTotal);
    day.expensesTotal += num(run.expensesTotal);
    const hasSplit = run.actualCashTotal != null && run.actualTransferTotal != null;
    day.cash = hasSplit && day.cash !== null ? day.cash + num(run.actualCashTotal) : null;
    day.transfer =
      hasSplit && day.transfer !== null ? day.transfer + num(run.actualTransferTotal) : null;
  }
  for (const day of days) {
    // Trip numbers in run order (#1 first), whatever the list order.
    const ordered = [...day.runs].sort((a, b) => a.runIndex - b.runIndex);
    const tripOf = new Map(ordered.map((r, i) => [r.id, i + 1]));
    day.storeLines = ordered.flatMap((run) =>
      (run.storeTotals ?? []).map((st) => ({ ...st, run, trip: tripOf.get(run.id)! })),
    );
  }
  return days;
}
