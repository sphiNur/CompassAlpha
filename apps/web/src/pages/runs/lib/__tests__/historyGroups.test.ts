import { describe, expect, test } from 'bun:test';
import type { RunListRow } from '../../history/RunHistory';
import { dayStoreSummaries, groupRunsByDay } from '../historyGroups';

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

describe('dayStoreSummaries', () => {
  test('a store in two trips is one row with both trips', () => {
    const shared = (id: string, total: string) => ({
      storeId: 'lagman',
      total,
      cash: total,
      transfer: '0',
      itemCount: 2,
    });
    const [day] = groupRunsByDay([
      run('b', '2026-10-22', 1, {
        storeTotals: [
          shared('b', '50'),
          { storeId: 'x', total: '300', cash: '100', transfer: '200', itemCount: 4 },
        ],
      }),
      run('a', '2026-10-22', 0, { storeTotals: [shared('a', '80')] }),
    ]);
    const stores = dayStoreSummaries(day!);
    expect(stores.map((s) => s.storeId)).toEqual(['x', 'lagman']);
    const lagman = stores[1]!;
    expect(lagman.total).toBe(130);
    expect(lagman.cash).toBe(130);
    expect(lagman.transfer).toBe(0);
    expect(lagman.itemCount).toBe(4);
    expect(lagman.lines.map((l) => [l.trip, l.run.id])).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
  });
});
