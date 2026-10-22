import { describe, expect, test } from 'bun:test';
import type { RunListRow } from '../../history/RunHistory';
import { groupRunsByDay } from '../historyGroups';

const run = (id: string, runDate: string, runIndex: number, extra: Partial<RunListRow> = {}) =>
  ({
    id,
    runDate,
    runIndex,
    status: 'finished',
    actualTotal: '100',
    actualCashTotal: '60',
    actualTransferTotal: '40',
    itemsTotal: '90',
    expensesTotal: '10',
    finishedAt: null,
    storeTotals: [
      {
        storeId: `store-${id}`,
        total: '100',
        cash: '60',
        transfer: '40',
        itemCount: 3,
      },
    ],
    ...extra,
  }) satisfies RunListRow;

describe('groupRunsByDay', () => {
  test('runs of one day become one entry with summed totals', () => {
    // newest first, as the server sends them: #2 before #1
    const days = groupRunsByDay([
      run('b', '2026-10-22', 1),
      run('a', '2026-10-22', 0),
      run('c', '2026-10-21', 0),
    ]);
    expect(days.map((d) => d.runDate)).toEqual(['2026-10-22', '2026-10-21']);
    const [day] = days;
    expect(day!.total).toBe(200);
    expect(day!.itemsTotal).toBe(180);
    expect(day!.expensesTotal).toBe(20);
    expect(day!.cash).toBe(120);
    expect(day!.transfer).toBe(80);
    // store lines in trip order, each pointing at its own run
    expect(day!.storeLines.map((l) => [l.storeId, l.trip, l.run.id])).toEqual([
      ['store-a', 1, 'a'],
      ['store-b', 2, 'b'],
    ]);
  });

  test('a run without the cash/transfer split makes the day split unknown', () => {
    const [day] = groupRunsByDay([
      run('a', '2026-10-22', 0),
      run('b', '2026-10-22', 1, { actualCashTotal: null, actualTransferTotal: null }),
    ]);
    expect(day!.cash).toBeNull();
    expect(day!.transfer).toBeNull();
    expect(day!.total).toBe(200);
  });

  test('a single-run day is one entry with trip 1', () => {
    const [day] = groupRunsByDay([run('a', '2026-10-20', 0)]);
    expect(day!.runs).toHaveLength(1);
    expect(day!.storeLines[0]!.trip).toBe(1);
  });
});
