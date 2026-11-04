import { describe, expect, test } from 'bun:test';
import { submittedSnapshot } from './submitted';
import type { OrderEvent } from './events';

const at = new Date('2026-11-05T08:00:00Z');
function stream(...defs: Array<[OrderEvent['type'], Record<string, unknown>]>): OrderEvent[] {
  return defs.map(([type, payload], i) => ({
    streamId: 's1',
    seq: i + 1,
    occurredAt: at,
    actorUserId: null,
    actorMemberId: null,
    type,
    payload,
  })) as unknown as OrderEvent[];
}
const start: [OrderEvent['type'], Record<string, unknown>] = [
  'DraftStarted',
  { orgId: 'o', storeId: 'st', initiatedByMemberId: 'a', orderDate: '2026-11-05' },
];
const adj = (skuId: string, qty: string, by: string, forM = by): [OrderEvent['type'], Record<string, unknown>] => [
  'ItemAdjusted',
  { skuId, qty, prevQty: '0', byMemberId: by, forMemberId: forM },
];

describe('submittedSnapshot', () => {
  test('keeps what was submitted when the reviewer changes lines', () => {
    const snap = submittedSnapshot(
      's1',
      stream(
        start,
        adj('apple', '3', 'a'),
        adj('pear', '1', 'b'),
        adj('apple', '2', 'b'),
        ['SessionExtrasSet', { extras: [{ name: 'Ice', qty: '1', unit: 'pcs' }], byMemberId: 'a' }],
        ['Submitted', { itemCount: 2, byMemberId: 'a' }],
        adj('apple', '1', 'mgr', 'a'),
        adj('pear', '0', 'mgr', 'b'),
        adj('plum', '4', 'mgr', 'a'),
        ['Approved', { byMemberId: 'mgr' }],
      ),
    );
    expect(snap?.seq).toBe(6);
    expect([...snap!.totals]).toEqual([
      ['apple', 5],
      ['pear', 1],
    ]);
    expect(snap?.extras).toEqual([{ name: 'Ice', qty: '1', unit: 'pcs' }]);
  });

  test('a rejected order sent again is compared with its latest submission', () => {
    const snap = submittedSnapshot(
      's1',
      stream(
        start,
        adj('apple', '3', 'a'),
        ['Submitted', { itemCount: 1, byMemberId: 'a' }],
        ['Rejected', { byMemberId: 'mgr', reason: 'too much' }],
        adj('apple', '2', 'a'),
        ['Submitted', { itemCount: 1, byMemberId: 'a' }],
      ),
    );
    expect(snap?.totals.get('apple')).toBe(2);
  });

  test('null for a draft, or a stream with a gap', () => {
    expect(submittedSnapshot('s1', stream(start, adj('apple', '1', 'a')))).toBeNull();
    const gap = stream(start, adj('apple', '1', 'a'), ['Submitted', { itemCount: 1, byMemberId: 'a' }]);
    gap.splice(1, 1);
    expect(submittedSnapshot('s1', gap)).toBeNull();
  });
});
