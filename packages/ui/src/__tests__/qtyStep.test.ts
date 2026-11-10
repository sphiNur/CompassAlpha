import { describe, expect, test } from 'bun:test';
import { defaultPresets, stepQty } from '../components/QtyControl';
import { isMultipleOfStep } from '../qtyDraft';

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

describe('defaultPresets (UI-03)', () => {
  test('every preset is a quantity the server accepts', () => {
    // packages/contracts/src/limits.ts: the steps a product may have.
    for (const step of [0.01, 0.1, 0.5, 1, 10, 50, 100]) {
      for (const p of defaultPresets(step)) expect(isMultipleOfStep(p, step)).toBe(true);
    }
  });

  test('a product sold in packs of 50 is offered packs of 50', () => {
    expect(defaultPresets(50)).toEqual([50, 100, 150, 250, 500]);
    expect(defaultPresets(1)).toEqual([1, 2, 5, 10, 20, 50, 100]);
  });

  test('isMultipleOfStep compares in thousandths', () => {
    expect(isMultipleOfStep(0.3, 0.1)).toBe(true);
    expect(isMultipleOfStep(20, 50)).toBe(false);
    expect(isMultipleOfStep(7, undefined)).toBe(true);
  });
});
