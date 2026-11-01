import { describe, expect, test } from 'bun:test';
import { purgeCountsByKind, resetConfirmMatches, wipeConfirmMatches } from '../purgeCounts';

describe('purgeCountsByKind (CMP-OPS-6)', () => {
  test('table names become kinds; parts of one thing are added; zeros dropped', () => {
    expect(
      purgeCountsByKind({
        'domain.events': 118,
        'domain.snapshots': 2,
        'read_model.order_sessions_v': 7,
        'read_model.market_runs_v': 3,
        'sync.outbox': 0,
        'inventory.store_daily_settlements': 1,
        'inventory.store_daily_settlement_revisions': 1,
      }),
    ).toEqual([
      { kind: 'orders', n: 7 },
      { kind: 'runs', n: 3 },
      { kind: 'dailyCloses', n: 2 },
      { kind: 'history', n: 120 },
    ]);
  });

  test('a table this build does not know goes under "other", last', () => {
    expect(purgeCountsByKind({ 'read_model.something_new_v': 4, 'ops.notifications': 1 })).toEqual([
      { kind: 'notifications', n: 1 },
      { kind: 'other', n: 4 },
    ]);
  });
});

describe('resetConfirmMatches (CMP-OPS-5)', () => {
  test('only the exact date confirms', () => {
    expect(resetConfirmMatches('2026-10-31', '2026-10-31')).toBe(true);
    expect(resetConfirmMatches(' 2026-10-31 ', '2026-10-31')).toBe(true);
    expect(resetConfirmMatches('2026-10-30', '2026-10-31')).toBe(false);
    expect(resetConfirmMatches('', '2026-10-31')).toBe(false);
    expect(resetConfirmMatches('', '')).toBe(false);
  });
});

describe('resetConfirmMatches on a phone number pad (DX-CAT-4)', () => {
  test('the digits of the date confirm it, in any separator', () => {
    expect(resetConfirmMatches('20261031', '2026-10-31')).toBe(true);
    expect(resetConfirmMatches('2026/10/31', '2026-10-31')).toBe(true);
    expect(resetConfirmMatches('2026.10.31', '2026-10-31')).toBe(true);
  });
  test('another order of the digits does not', () => {
    expect(resetConfirmMatches('31.10.2026', '2026-10-31')).toBe(false);
    expect(resetConfirmMatches('2026103', '2026-10-31')).toBe(false);
  });
});

describe('wipeConfirmMatches (DX-CAT-17)', () => {
  test('the visible workspace name confirms, spaces around ignored', () => {
    expect(wipeConfirmMatches('Eden', 'Eden')).toBe(true);
    expect(wipeConfirmMatches(' Eden ', 'Eden')).toBe(true);
  });
  test('anything else does not', () => {
    expect(wipeConfirmMatches('default', 'Eden')).toBe(false);
    expect(wipeConfirmMatches('eden', 'Eden')).toBe(false);
    expect(wipeConfirmMatches('', '')).toBe(false);
  });
});
