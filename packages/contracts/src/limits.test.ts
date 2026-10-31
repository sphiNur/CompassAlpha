/**
 * P-5 (2026-10-31): limits.ts is what the web imports instead of the
 * barrel, so zod stays out of its bundle. Pin that it stays zod-free and
 * that the plain checks agree with the schemas the server enforces.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { isPurchasePrice, ORDER_QTY_MAX, SKU_STEPS, SKU_UNITS } from './limits';
import { OrderQtySchema } from './schemas/common';
import { SkuStepSchema, SkuUnitSchema } from './schemas/catalog';
import { PurchasePriceSchema } from './schemas/run';
import * as barrel from './index';

describe('limits.ts', () => {
  it('imports nothing (no zod)', () => {
    const src = readFileSync(new URL('./limits.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/^\s*import\s/m);
    expect(src).not.toMatch(/from\s+'zod'|require\('zod'\)/);
  });

  it('isPurchasePrice agrees with PurchasePriceSchema', () => {
    for (const v of ['1', '0.01', '12.5', '147.55', '999999999999.99', '0', '0.00', '1.234', '1234567890123', '-1', '1,5', '', 'abc', '.5']) {
      expect(isPurchasePrice(v)).toBe(PurchasePriceSchema.safeParse(v).success);
    }
  });

  it('the schemas are built from the same lists and cap', () => {
    expect([...SkuStepSchema.options]).toEqual([...SKU_STEPS]);
    expect([...SkuUnitSchema.options]).toEqual([...SKU_UNITS]);
    expect(OrderQtySchema.safeParse(String(ORDER_QTY_MAX)).success).toBe(true);
    expect(OrderQtySchema.safeParse('1000000').success).toBe(false);
  });

  it('the barrel still exports them for server code', () => {
    expect(barrel.ORDER_QTY_MAX).toBe(ORDER_QTY_MAX);
    expect(barrel.SKU_STEPS).toBe(SKU_STEPS);
    expect(barrel.isoDateDaysBefore('2026-03-01', 1)).toBe('2026-02-28');
  });
});
