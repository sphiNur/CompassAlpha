/**
 * 2026-10-21 CA-04 / CA-06: which delivering run a store confirms, and
 * the received-qty rule on problem lines.
 */
import { describe, it, expect } from 'bun:test';
import {
  checkReceivedQty,
  defaultDeliveringRunId,
  deliveringRunsForStore,
  initialReceivedQty,
  runsListView,
} from '../confirmLogic';

const run = (
  id: string,
  runDate: string,
  runIndex: number,
  status = 'delivering',
  stores: string[] = ['A'],
) => ({
  id,
  status,
  runDate,
  runIndex,
  storeTotals: stores.map((storeId) => ({ storeId, itemCount: 2 })),
});

describe('deliveringRunsForStore', () => {
  it('keeps only delivering runs with goods for the store, oldest first', () => {
    const rows = [
      run('r3', '2026-10-21', 0, 'delivering', ['A']),
      run('r2', '2026-10-20', 1, 'delivering', ['A', 'B']),
      run('r1', '2026-10-20', 0, 'delivering', ['B']),
      run('r0', '2026-10-19', 0, 'finished', ['A']),
      run('rp', '2026-10-21', 1, 'purchasing', ['A']),
    ];
    expect(deliveringRunsForStore(rows, 'A').map((r) => r.id)).toEqual(['r2', 'r3']);
    expect(deliveringRunsForStore(rows, 'B').map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('falls back to the first delivering run when none has goods for the store', () => {
    const rows = [run('r2', '2026-10-21', 0), run('r1', '2026-10-20', 0)];
    expect(deliveringRunsForStore(rows, 'Z').map((r) => r.id)).toEqual(['r1']);
    expect(deliveringRunsForStore([], 'A')).toEqual([]);
  });
});

describe('defaultDeliveringRunId', () => {
  const c = [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }];
  it('picks the oldest run the store has not signed for', () => {
    expect(defaultDeliveringRunId(c, new Map([['r1', true]]))).toBe('r2');
    expect(defaultDeliveringRunId(c, new Map())).toBe('r1');
  });
  it('falls back to the oldest when all are signed, null when none', () => {
    const all = new Map([
      ['r1', true],
      ['r2', true],
      ['r3', true],
    ]);
    expect(defaultDeliveringRunId(c, all)).toBe('r1');
    expect(defaultDeliveringRunId([], new Map())).toBeNull();
  });
});

describe('checkReceivedQty', () => {
  it('ok sends nothing', () => {
    expect(checkReceivedQty('ok', '5', '2')).toEqual({ ok: true, value: null });
  });
  it('short requires a value from 0 to below the split', () => {
    expect(checkReceivedQty('short', '', '2')).toEqual({ ok: false, reason: 'required' });
    expect(checkReceivedQty('short', '1,5', '2')).toEqual({ ok: true, value: '1.5' });
    expect(checkReceivedQty('short', '2', '2')).toEqual({ ok: false, reason: 'notShort' });
    expect(checkReceivedQty('short', '2.5', '2')).toEqual({ ok: false, reason: 'exceeds' });
    expect(checkReceivedQty('short', '-1', '2')).toEqual({ ok: false, reason: 'invalid' });
    expect(checkReceivedQty('short', '1.2345', '2')).toEqual({ ok: false, reason: 'invalid' });
  });
  it('wrong / quality default to 0', () => {
    expect(checkReceivedQty('wrong', '', '2')).toEqual({ ok: true, value: '0' });
    expect(checkReceivedQty('quality', '1', '2')).toEqual({ ok: true, value: '1' });
  });
});

describe('initialReceivedQty', () => {
  it('prefills 0 for wrong/quality, empty for short, keeps an existing value', () => {
    expect(initialReceivedQty('short', null)).toBe('');
    expect(initialReceivedQty('wrong', undefined)).toBe('0');
    expect(initialReceivedQty('quality', null)).toBe('0');
    expect(initialReceivedQty('short', '1.5')).toBe('1.5');
  });
});

describe('runsListView (2026-10-21 FE-01 / F4-02)', () => {
  it('first load is loading, not "nothing to confirm"', () => {
    expect(runsListView({ isLoading: true, isError: false, hasData: false })).toEqual({
      kind: 'loading',
    });
  });
  it('a failure with nothing cached is an error, not empty', () => {
    expect(runsListView({ isLoading: false, isError: true, hasData: false })).toEqual({
      kind: 'error',
    });
  });
  it('cached runs survive a failed refetch, flagged stale', () => {
    expect(runsListView({ isLoading: false, isError: true, hasData: true })).toEqual({
      kind: 'ready',
      stale: true,
    });
  });
  it('loaded data is ready', () => {
    expect(runsListView({ isLoading: false, isError: false, hasData: true })).toEqual({
      kind: 'ready',
      stale: false,
    });
  });
});
