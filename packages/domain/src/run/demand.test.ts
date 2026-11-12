import { describe, expect, test } from 'bun:test';
import { sumDemand, sumDemandBy } from './demand';

describe('run demand (review RUNAPI-13)', () => {
  test('sums each product exactly, not as floats', () => {
    expect(
      sumDemand([
        { skuId: 'a', qty: '0.1' },
        { skuId: 'a', qty: '0.2' },
        { skuId: 'b', qty: '1.5' },
      ]),
    ).toEqual([
      { skuId: 'a', qty: '0.3' },
      { skuId: 'b', qty: '1.5' },
    ]);
  });

  test('a line of no quantity asks for nothing', () => {
    // A note on its own is stored as a line of quantity 0.
    expect(
      sumDemand([
        { skuId: 'a', qty: '0' },
        { skuId: 'b', qty: '0.000' },
        { skuId: 'c', qty: '2' },
      ]),
    ).toEqual([{ skuId: 'c', qty: '2' }]);
    expect(sumDemand([])).toEqual([]);
  });

  test('each product comes where it first appears', () => {
    expect(
      sumDemand([
        { skuId: 'b', qty: '1' },
        { skuId: 'a', qty: '1' },
        { skuId: 'b', qty: '2' },
      ]),
    ).toEqual([
      { skuId: 'b', qty: '3' },
      { skuId: 'a', qty: '1' },
    ]);
  });

  test('sumDemandBy sums each group, in the order the groups first appear', () => {
    const lines = [
      { sessionId: 's2', skuId: 'a', qty: '1' },
      { sessionId: 's1', skuId: 'b', qty: '0.25' },
      { sessionId: 's2', skuId: 'a', qty: '0.5' },
      { sessionId: 's1', skuId: 'a', qty: '2' },
    ];
    expect([...sumDemandBy(lines, (line) => line.sessionId)]).toEqual([
      ['s2', [{ skuId: 'a', qty: '1.5' }]],
      [
        's1',
        [
          { skuId: 'b', qty: '0.25' },
          { skuId: 'a', qty: '2' },
        ],
      ],
    ]);
  });

  test('sumDemandBy leaves out lines with no key and groups that ask for nothing', () => {
    const storeOf = new Map([
      ['s1', 'A'],
      ['s2', 'B'],
    ]);
    const lines = [
      // Store B's only line is a note: B is not a group at all, so it does
      // not take a place in the order before C.
      { sessionId: 's2', skuId: 'a', qty: '0' },
      { sessionId: 's-gone', skuId: 'a', qty: '9' },
      { sessionId: 's1', skuId: 'a', qty: '1' },
    ];
    const byStore = sumDemandBy(lines, (line) => storeOf.get(line.sessionId));
    expect([...byStore]).toEqual([['A', [{ skuId: 'a', qty: '1' }]]]);
  });
});
