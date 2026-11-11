/**
 * Review CONF-10 (2026-11-11): the inventory, dish and report inputs moved
 * out of the routers. The plain checks in limits.ts (what the web reads)
 * and the schemas (what the server enforces) must give the same answer,
 * with the same catalog key.
 */
import { describe, expect, it } from 'bun:test';
import type { ZodTypeAny } from 'zod';
import {
  INVENTORY_NOTE_MAX,
  QTY_TEXT_RE,
  RECIPE_QTY_MESSAGE,
  WASTAGE_QTY_MESSAGE,
  isPositiveQty,
  recipeQtyProblem,
  wastageQtyProblem,
} from './limits';
import { PositiveDecimalStringSchema } from './schemas/common';
import { DishIngredientSchema } from './schemas/catalog';
import { StocktakeInputSchema, WastageInputSchema } from './schemas/inventory';
import { PurchaseLinesInputSchema, dateRangeInOrder } from './schemas/report';
import * as barrel from './index';

function refusal(schema: ZodTypeAny, value: unknown): string | null {
  const result = schema.safeParse(value);
  return result.success ? null : (result.error.issues[0]?.message ?? 'refused');
}

const STORE = '00000000-0000-4000-8000-000000000001';
const SKU = '00000000-0000-4000-8000-000000000002';

describe('quantities (CONF-10)', () => {
  it('isPositiveQty is PositiveDecimalStringSchema', () => {
    for (const v of ['1', '0.001', '12.5', '1000000']) {
      expect(isPositiveQty(v)).toBe(true);
      expect(PositiveDecimalStringSchema.safeParse(v).success).toBe(true);
    }
    for (const v of ['', '0', '0.000', '1.2345', '-1', '1e3', '1,5', ' 1']) {
      expect(isPositiveQty(v)).toBe(false);
      expect(PositiveDecimalStringSchema.safeParse(v).success).toBe(false);
    }
    expect(QTY_TEXT_RE.test('0')).toBe(true);
  });

  it('a wastage is refused with the key the sheet shows', () => {
    const wastage = (qty: string, note = 'spoiled') =>
      refusal(WastageInputSchema, { storeId: STORE, skuId: SKU, qty, note });
    expect(wastageQtyProblem('2.5')).toBeNull();
    expect(wastage('2.5')).toBeNull();
    for (const qty of ['0', 'abc', '0.0001']) {
      expect(wastageQtyProblem(qty)).toBe('format');
      expect(wastage(qty)).toBe(WASTAGE_QTY_MESSAGE.format);
    }
    expect(wastageQtyProblem('100000000')).toBe('tooLarge');
    expect(wastage('100000000')).toBe(WASTAGE_QTY_MESSAGE.tooLarge);
    expect(wastage('99999999.999')).toBeNull();
    expect(wastage('1', '   ')).not.toBeNull();
    expect(wastage('1', 'x'.repeat(INVENTORY_NOTE_MAX))).toBeNull();
    expect(wastage('1', 'x'.repeat(INVENTORY_NOTE_MAX + 1))).not.toBeNull();
  });

  it('a stocktake note is capped at the same length', () => {
    const count = (note: string) =>
      refusal(StocktakeInputSchema, { storeId: STORE, skuId: SKU, target: '3', note });
    expect(count('x'.repeat(INVENTORY_NOTE_MAX))).toBeNull();
    expect(count('x'.repeat(INVENTORY_NOTE_MAX + 1))).not.toBeNull();
  });

  it('a recipe amount is refused with the key the dish editor shows', () => {
    const line = (qtyPerServing: string) =>
      refusal(DishIngredientSchema, { skuId: SKU, qtyPerServing });
    for (const ok of ['1', '0.0001', '12345678.1234']) {
      expect(recipeQtyProblem(ok)).toBeNull();
      expect(line(ok)).toBeNull();
    }
    for (const bad of ['abc', '0.00001', '123456789', '']) {
      expect(recipeQtyProblem(bad)).toBe('format');
      expect(line(bad)).toBe(RECIPE_QTY_MESSAGE.format);
    }
    expect(recipeQtyProblem('0.0000')).toBe('notPositive');
    expect(line('0.0000')).toBe(RECIPE_QTY_MESSAGE.notPositive);
  });
});

describe('finance range (CONF-10)', () => {
  const range = PurchaseLinesInputSchema.superRefine(dateRangeInOrder);
  it('a reversed range is refused on the end date', () => {
    const result = range.safeParse({ startDate: '2026-11-02', endDate: '2026-11-01' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('finance.range.invalid');
    expect(result.error?.issues[0]?.path).toEqual(['endDate']);
    expect(range.safeParse({ startDate: '2026-11-01', endDate: '2026-11-01' }).success).toBe(true);
  });
  it('the barrel exports the moved inputs', () => {
    expect(barrel.WastageInputSchema).toBe(WastageInputSchema);
    expect(barrel.PurchaseLinesInputSchema).toBe(PurchaseLinesInputSchema);
  });
});
