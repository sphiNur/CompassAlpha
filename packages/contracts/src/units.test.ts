import { describe, expect, test } from 'bun:test';
import { CANONICAL_UNITS, SKU_UNITS, WHOLE_NUMBER_UNITS, isCanonicalUnit } from './limits';
import { CanonicalUnitSchema } from './schemas/order';

// ORD-13 (2026-11-11): the order page kept its own copy of this list, and
// the copy went without `box` when R2-COPY-3 added it to the contract.
describe('the units an off-catalog order line may name', () => {
  test('are exactly what the schema accepts', () => {
    expect(CanonicalUnitSchema.options).toEqual([...CANONICAL_UNITS]);
    for (const unit of CANONICAL_UNITS) expect(isCanonicalUnit(unit)).toBe(true);
    for (const unit of ['kgs', '公斤', 'KG', '']) {
      expect(isCanonicalUnit(unit)).toBe(false);
      expect(CanonicalUnitSchema.safeParse(unit).success).toBe(false);
    }
  });

  test('cover every unit a catalog product uses', () => {
    expect(SKU_UNITS.filter((unit) => !isCanonicalUnit(unit))).toEqual([]);
  });

  test('count in whole numbers only where the unit is counted, box included', () => {
    expect([...WHOLE_NUMBER_UNITS].filter((unit) => !isCanonicalUnit(unit))).toEqual([]);
    expect(CANONICAL_UNITS.filter((unit) => WHOLE_NUMBER_UNITS.has(unit))).toEqual([
      'pcs',
      'pack',
      'pair',
      'bunch',
      'roll',
      'box',
    ]);
  });
});
