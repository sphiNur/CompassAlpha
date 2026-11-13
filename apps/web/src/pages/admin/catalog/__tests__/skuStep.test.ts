import { describe, expect, test } from 'bun:test';
import { CANONICAL_UNITS, SKU_STEPS } from '@compass/contracts/limits';
import { defaultStepForUnit, snapStepToCanonical, stepAfterUnitChange } from '../skuStep';

describe('snapStepToCanonical', () => {
  test('keeps canonical steps as the database returns them (numeric with three decimals)', () => {
    expect(snapStepToCanonical('0.500')).toBe('0.5');
    expect(snapStepToCanonical('1.000')).toBe('1');
    expect(snapStepToCanonical('10.000')).toBe('10');
    expect(snapStepToCanonical('50.000')).toBe('50');
    expect(snapStepToCanonical('100.000')).toBe('100');
  });

  test('passes exact canonical strings through', () => {
    for (const step of ['0.5', '1', '10', '50', '100'] as const) {
      expect(snapStepToCanonical(step)).toBe(step);
    }
  });

  test('collapses legacy off-grid steps without up-snapping to a bulk step', () => {
    expect(snapStepToCanonical('0.25')).toBe('0.5');
    expect(snapStepToCanonical('5')).toBe('1');
    expect(snapStepToCanonical('25.000')).toBe('1');
    expect(snapStepToCanonical('abc')).toBe('1');
  });
});

describe('the step a unit starts with (S2)', () => {
  test('kg and L by half, g and ml by a hundred, counted units by one', () => {
    expect(defaultStepForUnit('kg')).toBe('0.5');
    expect(defaultStepForUnit('L')).toBe('0.5');
    expect(defaultStepForUnit('g')).toBe('100');
    expect(defaultStepForUnit('ml')).toBe('100');
    for (const unit of ['pcs', 'pack', 'pair', 'bunch', 'roll', 'box']) {
      expect(defaultStepForUnit(unit)).toBe('1');
    }
  });

  test('every default is on the step grid, for every unit the contracts know', () => {
    for (const unit of CANONICAL_UNITS) {
      expect(SKU_STEPS as readonly string[]).toContain(defaultStepForUnit(unit));
    }
  });

  test('a unit change follows the unit until the step is chosen by hand', () => {
    expect(stepAfterUnitChange('kg', { step: '1', stepTouched: false })).toBe('0.5');
    expect(stepAfterUnitChange('pcs', { step: '0.5', stepTouched: false })).toBe('1');
    expect(stepAfterUnitChange('kg', { step: '10', stepTouched: true })).toBe('10');
    expect(stepAfterUnitChange('pcs', { step: '0.5', stepTouched: true })).toBe('0.5');
  });
});
