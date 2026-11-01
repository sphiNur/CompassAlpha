import { describe, expect, it } from 'bun:test';

import { evenSplitQty, proportionalSplitQty } from '../splitQty';

/** The domain's tolerance in packages/domain/src/run/commands.ts. */
const TOLERANCE = 1e-6;

const sum = (values: Iterable<string>): number => {
  let total = 0;
  for (const v of values) total += Number(v);
  return total;
};

describe('evenSplitQty', () => {
  it('splits a shared cost of 1 across 3 stores instead of flooring to zero', () => {
    // The regression. Math.floor(1/3) gave {A:'0', B:'0', C:'1'}, the
    // submit path dropped the zero shares, and one store paid the whole
    // porter fee while the sheet promised an even split.
    const out = evenSplitQty(['a', 'b', 'c'], '1');
    expect([...out.values()]).toEqual(['0.333', '0.333', '0.334']);
    for (const v of out.values()) expect(Number(v)).toBeGreaterThan(0);
  });

  it('produces shares that sum to the whole exactly', () => {
    for (const [n, qty] of [
      [2, '1'],
      [3, '1'],
      [3, '2.5'],
      [4, '1'],
      [6, '7'],
      [7, '1'],
      [9, '10'],
    ] as const) {
      const ids = Array.from({ length: n }, (_, i) => `s${i}`);
      const out = evenSplitQty(ids, qty);
      expect(out.size).toBe(n);
      expect(Math.abs(sum(out.values()) - Number(qty))).toBeLessThanOrEqual(
        TOLERANCE,
      );
    }
  });

  it('keeps every share within one scale step of a fair share', () => {
    const out = evenSplitQty(['a', 'b', 'c'], '1');
    const fair = 1 / 3;
    for (const v of out.values()) {
      expect(Math.abs(Number(v) - fair)).toBeLessThanOrEqual(0.001);
    }
  });

  it('does not rewrite the string for a single store', () => {
    // Reformatting "2.5" to "2.500" under a typing cursor is its own bug.
    expect(evenSplitQty(['a'], '2.5').get('a')).toBe('2.5');
  });

  it('registers blanks when there is no usable quantity yet', () => {
    expect([...evenSplitQty(['a', 'b'], '').values()]).toEqual(['', '']);
    expect([...evenSplitQty(['a', 'b'], '0').values()]).toEqual(['', '']);
    expect([...evenSplitQty(['a', 'b'], 'abc').values()]).toEqual(['', '']);
  });

  it('returns an empty map for no stores', () => {
    expect(evenSplitQty([], '5').size).toBe(0);
  });
});

describe('proportionalSplitQty', () => {
  it('scales planned demand down to what was actually bought', () => {
    const out = proportionalSplitQty(
      [
        { storeId: 'a', qty: '1' },
        { storeId: 'b', qty: '1.5' },
        { storeId: 'c', qty: '0.5' },
      ],
      '2',
    );
    expect(out).toEqual([
      { storeId: 'a', qty: '0.667' },
      { storeId: 'b', qty: '1.000' },
      { storeId: 'c', qty: '0.333' },
    ]);
    expect(Math.abs(sum(out!.map((o) => o.qty)) - 2)).toBeLessThanOrEqual(
      TOLERANCE,
    );
  });

  it('sums to the actual quantity for awkward ratios', () => {
    const out = proportionalSplitQty(
      [
        { storeId: 'a', qty: '1' },
        { storeId: 'b', qty: '1' },
        { storeId: 'c', qty: '1' },
      ],
      '10',
    );
    expect(Math.abs(sum(out!.map((o) => o.qty)) - 10)).toBeLessThanOrEqual(
      TOLERANCE,
    );
  });

  it('scales up as well as down', () => {
    const out = proportionalSplitQty(
      [
        { storeId: 'a', qty: '1' },
        { storeId: 'b', qty: '3' },
      ],
      '8',
    );
    expect(out).toEqual([
      { storeId: 'a', qty: '2.000' },
      { storeId: 'b', qty: '6.000' },
    ]);
  });

  it('passes the raw string through for a single store', () => {
    expect(proportionalSplitQty([{ storeId: 'a', qty: '5' }], '2.5')).toEqual([
      { storeId: 'a', qty: '2.5' },
    ]);
  });

  it('returns null when there is nothing to scale', () => {
    expect(proportionalSplitQty([], '2')).toBeNull();
    expect(proportionalSplitQty([{ storeId: 'a', qty: '1' }], '0')).toBeNull();
    expect(proportionalSplitQty([{ storeId: 'a', qty: '1' }], '')).toBeNull();
    expect(proportionalSplitQty([{ storeId: 'a', qty: '1' }], 'x')).toBeNull();
    expect(
      proportionalSplitQty(
        [
          { storeId: 'a', qty: '0' },
          { storeId: 'b', qty: '0' },
        ],
        '2',
      ),
    ).toBeNull();
  });

  it('never emits a negative share when demand is lopsided', () => {
    const out = proportionalSplitQty(
      [
        { storeId: 'a', qty: '0.001' },
        { storeId: 'b', qty: '100' },
      ],
      '3',
    );
    // BUY-13: store a's share rounds to 0.000, which the server refuses;
    // the full purchase sheet takes over instead.
    expect(out).toBeNull();
  });
});

describe('proportionalSplitQty with a step (BUY-13)', () => {
  const demand = [
    { storeId: 'A', qty: '6' },
    { storeId: 'B', qty: '10' },
  ];
  it('gives whole pieces; the leftover piece goes to the larger fraction (DX-BUY-3)', () => {
    // Claims 5.625 and 9.375: A has the larger fraction, so A gets the
    // 15th piece (BUY-13 gave it to whichever store came last).
    expect(proportionalSplitQty(demand, '15', '1')).toEqual([
      { storeId: 'A', qty: '6.000' },
      { storeId: 'B', qty: '9.000' },
    ]);
  });
  it('gives up (full sheet) rather than send a zero share', () => {
    expect(proportionalSplitQty(demand, '0.001')).toBeNull();
    expect(proportionalSplitQty(demand, '1', '1')).toBeNull();
  });
});

describe('proportionalSplitQty largest remainder (DX-BUY-3)', () => {
  it('does not put the whole shortfall on the first store', () => {
    // Planned 1.5 + 2 at step 0.5, bought 2.5 (5 steps). BUY-13 rounded
    // CK down and gave RH the rest; the shares now follow the fractions.
    const out = proportionalSplitQty(
      [
        { storeId: 'CK', qty: '1.5' },
        { storeId: 'RH', qty: '2' },
      ],
      '2.5',
      '0.5',
    );
    // Claims 1.071 / 1.429 kg = 2.14 / 2.86 steps: RH has the larger fraction.
    expect(out).toEqual([
      { storeId: 'CK', qty: '1.000' },
      { storeId: 'RH', qty: '1.500' },
    ]);
  });

  it('breaks a tie toward the store that planned more, then list order', () => {
    expect(
      proportionalSplitQty(
        [
          { storeId: 'A', qty: '1' },
          { storeId: 'B', qty: '1' },
          { storeId: 'C', qty: '2' },
        ],
        '3',
        '1',
      ),
    ).toEqual([
      // Claims 0.75 / 0.75 / 1.5: C's fraction (0.5) is the smallest, so
      // A and B (0.75 each) get a step before C does.
      { storeId: 'A', qty: '1.000' },
      { storeId: 'B', qty: '1.000' },
      { storeId: 'C', qty: '1.000' },
    ]);
    expect(
      proportionalSplitQty(
        [
          { storeId: 'A', qty: '1.5' },
          { storeId: 'B', qty: '1.5' },
        ],
        '2.5',
        '0.5',
      ),
    ).toEqual([
      { storeId: 'A', qty: '1.500' },
      { storeId: 'B', qty: '1.000' },
    ]);
  });

  it('every share is a whole number of steps and the parts sum exactly', () => {
    const out = proportionalSplitQty(
      [
        { storeId: 'a', qty: '3' },
        { storeId: 'b', qty: '2' },
        { storeId: 'c', qty: '7' },
      ],
      '9',
      '0.5',
    )!;
    for (const o of out) expect((Number(o.qty) * 2) % 1).toBe(0);
    expect(sum(out.map((o) => o.qty))).toBe(9);
  });

  it('a remainder below one step goes to the next store in line', () => {
    const out = proportionalSplitQty(
      [
        { storeId: 'a', qty: '1' },
        { storeId: 'b', qty: '1' },
      ],
      '2.3',
      '0.5',
    )!;
    expect(out).toEqual([
      { storeId: 'a', qty: '1.300' },
      { storeId: 'b', qty: '1.000' },
    ]);
  });
});
