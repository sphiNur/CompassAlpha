import { describe, expect, test } from 'bun:test';
import { stepQty } from '../components/QtyControl';

describe('stepQty (DX-ORD-2)', () => {
  test('adds and removes one step, trimming float drift', () => {
    expect(stepQty(0.1, 1, 0.2, 0, 10)).toBe(0.3);
    expect(stepQty(1, -1, 0.5, 0, 10)).toBe(0.5);
  });

  test('clamps to min and max', () => {
    expect(stepQty(0, -1, 0.5, 0, 10)).toBe(0);
    expect(stepQty(9.8, 1, 0.5, 0, 10)).toBe(10);
  });

  test('a hold ramp that reads the value it last wrote climbs every tick', () => {
    // The ramp keeps one closure for the whole press; the fix makes it read
    // the latest value from a ref instead of the value at press time.
    const ref = { current: 0 };
    for (let tick = 0; tick < 19; tick++) {
      ref.current = stepQty(ref.current, 1, 0.5, 0, 1000);
    }
    expect(ref.current).toBe(9.5);
  });
});
