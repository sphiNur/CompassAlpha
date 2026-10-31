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
 * D1 (2026-10-31): the sums stay on whole cents (addMoney), so a day's
 * figure is exactly the sum of its runs' (R2-HIS-1).
 *
 * Pure; tests in __tests__/historyGroups.test.ts.
 */
import { addMoney } from '@compass/contracts';
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
    day.total = addMoney(day.total, run.actualTotal);
    day.itemsTotal = addMoney(day.itemsTotal, run.itemsTotal);
    day.expensesTotal = addMoney(day.expensesTotal, run.expensesTotal);
    const hasSplit = run.actualCashTotal != null && run.actualTransferTotal != null;
    day.cash = hasSplit && day.cash !== null ? addMoney(day.cash, run.actualCashTotal) : null;
    day.transfer =
      hasSplit && day.transfer !== null ? addMoney(day.transfer, run.actualTransferTotal) : null;
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

export type HistoryDayStore = {
  storeId: string;
  total: number;
  cash: number;
  transfer: number;
  expensesTotal: number;
  /** Product lines summed over the day's trips. */
  itemCount: number;
  /** This store's line in each trip it was part of, in trip order. */
  lines: HistoryStoreLine[];
};

/** One row per store for the day sheet, largest spend first. */
export function dayStoreSummaries(day: HistoryDay): HistoryDayStore[] {
  const byStore = new Map<string, HistoryDayStore>();
  for (const line of day.storeLines) {
    let store = byStore.get(line.storeId);
    if (!store) {
      store = {
        storeId: line.storeId,
        total: 0,
        cash: 0,
        transfer: 0,
        expensesTotal: 0,
        itemCount: 0,
        lines: [],
      };
      byStore.set(line.storeId, store);
    }
    store.total = addMoney(store.total, line.total);
    store.cash = addMoney(store.cash, line.cash);
    store.transfer = addMoney(store.transfer, line.transfer);
    store.expensesTotal = addMoney(store.expensesTotal, line.expensesTotal);
    store.itemCount += line.itemCount;
    store.lines.push(line);
  }
  return [...byStore.values()].sort((a, b) => b.total - a.total);
}
