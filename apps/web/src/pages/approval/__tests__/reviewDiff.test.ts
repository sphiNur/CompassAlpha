import { describe, expect, it } from 'bun:test';
import { approvable, changedSinceSeen, snapshotOrder, zeroedInReview } from '../reviewDiff';

describe('changedSinceSeen (DX-APR-3)', () => {
  const seen = snapshotOrder(4, [
    { skuId: 'lamb', qty: '10' },
    { skuId: 'rice', qty: '2' },
  ]);
  it('nothing while the seq has not moved', () => {
    expect(changedSinceSeen(seen, snapshotOrder(4, [{ skuId: 'lamb', qty: '12' }])).size).toBe(0);
    expect(changedSinceSeen(null, seen).size).toBe(0);
  });
  it('marks changed, added and removed lines with the quantity first seen', () => {
    const now = snapshotOrder(7, [
      { skuId: 'lamb', qty: '12' },
      { skuId: 'rice', qty: '2' },
      { skuId: 'salt', qty: '1' },
    ]);
    expect([...changedSinceSeen(seen, now)]).toEqual([
      ['lamb', 10],
      ['salt', 0],
    ]);
    const removed = snapshotOrder(8, [{ skuId: 'lamb', qty: '10' }]);
    expect([...changedSinceSeen(seen, removed)]).toEqual([['rice', 2]]);
  });
});

describe('zeroedInReview / approvable (DX-APR-8)', () => {
  it('keeps lines a reviewer set to 0, not ones the staff dropped', () => {
    const items = [
      { skuId: 'a', qty: '0', contributorMemberId: 'staff', updatedByMemberId: 'boss' },
      { skuId: 'b', qty: '0', contributorMemberId: 'staff', updatedByMemberId: 'staff' },
      { skuId: 'c', qty: '3', contributorMemberId: 'staff', updatedByMemberId: 'boss' },
    ];
    expect(zeroedInReview(items).map((i) => i.skuId)).toEqual(['a']);
  });
  it('an order with no lines and no other items cannot be approved', () => {
    expect(approvable(0, 0)).toBe(false);
    expect(approvable(0, 1)).toBe(true);
    expect(approvable(2, 0)).toBe(true);
  });
});
