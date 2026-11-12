/**
 * What a maintenance purge deletes, by kind (CMP-OPS-6). Review ADM2-34
 * (2026-11-12): moved here from the web with the table map; the API's
 * purge-kinds.test.ts checks that every table a purge deletes from is in
 * the map.
 */
import { describe, expect, test } from 'bun:test';
import { PURGE_KIND_BY_TABLE, PURGE_KINDS, purgeCountsByKind } from './limits';

describe('purgeCountsByKind (CMP-OPS-6)', () => {
  test('table names become kinds; parts of one thing are added; zeros dropped', () => {
    expect(
      purgeCountsByKind({
        'domain.events': 118,
        'domain.snapshots': 2,
        'read_model.order_sessions_v': 7,
        'read_model.market_runs_v': 3,
        'sync.outbox': 0,
      }),
    ).toEqual([
      { kind: 'orders', n: 7 },
      { kind: 'runs', n: 3 },
      { kind: 'history', n: 120 },
    ]);
  });

  test('a table this build does not know goes under "other", last', () => {
    expect(purgeCountsByKind({ 'read_model.something_new_v': 4, 'ops.notifications': 1 })).toEqual([
      { kind: 'notifications', n: 1 },
      { kind: 'other', n: 4 },
    ]);
  });

  test('every kind but "other" names at least one table', () => {
    const named = new Set(Object.values(PURGE_KIND_BY_TABLE));
    expect(PURGE_KINDS.filter((kind) => kind !== 'other' && !named.has(kind))).toEqual([]);
  });
});
