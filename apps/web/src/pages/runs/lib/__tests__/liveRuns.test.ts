import { describe, expect, test } from 'bun:test';
import { NEW_RUN, liveRunsOf, pickActiveRun, runListGate } from '../liveRuns';

const run = (id: string, status: string, runDate = '2026-10-20', runIndex = 0) => ({
  id,
  status,
  runDate,
  runIndex,
});

describe('pickActiveRun (CA-04)', () => {
  const rows = [
    run('buy', 'purchasing', '2026-10-21', 0),
    run('d2', 'delivering', '2026-10-20', 1),
    run('d1', 'delivering', '2026-10-20', 0),
    run('fin', 'finished', '2026-10-19', 0),
  ];

  test('defaults to the buying run', () => {
    expect(pickActiveRun(rows, { canAmend: false, selectedKey: null })?.id).toBe('buy');
  });

  test('falls back to the oldest delivering run when nothing is being bought', () => {
    const noBuy = rows.filter((r) => r.id !== 'buy');
    expect(pickActiveRun(noBuy, { canAmend: false, selectedKey: null })?.id).toBe('d1');
  });

  test('honours an explicit open run and ignores a closed one', () => {
    expect(pickActiveRun(rows, { canAmend: false, selectedKey: 'd2' })?.id).toBe('d2');
    expect(pickActiveRun(rows, { canAmend: false, selectedKey: 'fin' })?.id).toBe('buy');
  });

  test('NEW_RUN shows the preview only while no run is being bought', () => {
    const noBuy = rows.filter((r) => r.id !== 'buy');
    expect(pickActiveRun(noBuy, { canAmend: false, selectedKey: NEW_RUN })).toBeNull();
    expect(pickActiveRun(rows, { canAmend: false, selectedKey: NEW_RUN })?.id).toBe('buy');
  });

  test('amenders land on the amending run; others never see it', () => {
    const withAmend = [...rows, run('am', 'amending', '2026-10-01')];
    expect(pickActiveRun(withAmend, { canAmend: true, selectedKey: null })?.id).toBe('am');
    expect(pickActiveRun(withAmend, { canAmend: false, selectedKey: 'am' })?.id).toBe('buy');
    expect(liveRunsOf(withAmend, false).map((r) => r.id)).toEqual(['d1', 'd2', 'buy']);
  });
});

describe('runListGate (P-2: no false empty state while run.list loads)', () => {
  test('no data yet and fetching: loading, not the planning branch', () => {
    expect(runListGate({ data: undefined, isError: false, fetchStatus: 'fetching' })).toBe('loading');
  });

  test('failed with no data: error; offline with no data: offline', () => {
    expect(runListGate({ data: undefined, isError: true, fetchStatus: 'idle' })).toBe('error');
    expect(runListGate({ data: undefined, isError: false, fetchStatus: 'paused' })).toBe('offline');
  });

  test('any data (even an empty list, or old data under a failed refetch): ready', () => {
    expect(runListGate({ data: [], isError: false, fetchStatus: 'idle' })).toBe('ready');
    expect(runListGate({ data: [], isError: true, fetchStatus: 'idle' })).toBe('ready');
  });
});
