import { describe, expect, test } from 'bun:test';
import { snapStepToCanonical } from '../skuStep';

describe('snapStepToCanonical', () => {
  test('keeps canonical steps as the database returns them (numeric with three decimals)', () => {
    expect(snapStepToCanonical('0.500')).toBe('0.5');
    expect(snapStepToCanonical('1.000')).toBe('1');
    expect(snapStepToCanonical('10.000')).toBe('10');
    expect(snapStepToCanonical('50.000')).toBe('50');
    expect(snapStepToCanonical('100.000')).toBe('100');
  });

  test('passes exact canonical strings through', () => {
    for (const step of ['0.5', '1', '10', '50', '100']) expect(snapStepToCanonical(step)).toBe(step);
  });

  test('collapses legacy off-grid steps without up-snapping to a bulk step', () => {
    expect(snapStepToCanonical('0.25')).toBe('0.5');
    expect(snapStepToCanonical('5')).toBe('1');
    expect(snapStepToCanonical('25.000')).toBe('1');
    expect(snapStepToCanonical('abc')).toBe('1');
  });
});
