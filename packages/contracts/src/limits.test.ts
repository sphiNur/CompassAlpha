/**
 * P-5 (2026-10-31): limits.ts is what the web imports instead of the
 * barrel, so zod stays out of its bundle. Pin that it stays zod-free and
 * that the plain checks agree with the schemas the server enforces.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  isPurchasePrice,
  ORDER_QTY_MAX,
  SKU_STEPS,
  SKU_UNITS,
  settlementMoneyProblem,
  stocktakeCountProblem,
} from './limits';
import { OrderQtySchema } from './schemas/common';
import {
  SettlementOperatingExpenseItemSchema,
  SettlementMoneySchema,
  SignedSettlementMoneySchema,
} from './schemas/settlement';
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

  it('stocktakeCountProblem names one reason per bad count (DX-INV-1)', () => {
    expect(stocktakeCountProblem('')).toBe('empty');
    expect(stocktakeCountProblem('  ')).toBe('empty');
    expect(stocktakeCountProblem('-3')).toBe('negative');
    expect(stocktakeCountProblem('-0.5')).toBe('negative');
    expect(stocktakeCountProblem('abc')).toBe('notNumber');
    expect(stocktakeCountProblem('1e3')).toBe('notNumber');
    expect(stocktakeCountProblem('1,5')).toBe('notNumber');
    expect(stocktakeCountProblem('20.0001')).toBe('decimals');
    expect(stocktakeCountProblem('100000000')).toBe('tooLarge');
    expect(stocktakeCountProblem('99999999999')).toBe('tooLarge');
    for (const ok of ['0', '20', '20.5', '0.125', '99999999.999', '00012']) {
      expect(stocktakeCountProblem(ok)).toBeNull();
    }
    expect(barrel.stocktakeCountProblem).toBe(stocktakeCountProblem);
  });

  it('settlementMoneyProblem keeps the daily close rule the schemas had (CONF-08)', () => {
    // The two patterns the schemas, the page and its field lines each carried.
    const unsigned = /^\d{1,12}(\.\d{1,2})?$/;
    const signed = /^-?\d{1,12}(\.\d{1,2})?$/;
    const samples = [
      '0',
      '0.5',
      '0010.5',
      '320000.50',
      '999999999999.99',
      '',
      '-5',
      '-0',
      '-0.05',
      'abc',
      '1.2.3',
      '12.345',
      '1234567890123',
      ' 1',
      '1 ',
      '.5',
      '1.',
      '1e3',
      '1,5',
      '-',
    ];
    for (const v of samples) {
      expect(settlementMoneyProblem(v) === null).toBe(unsigned.test(v));
      expect(settlementMoneyProblem(v, { signed: true }) === null).toBe(signed.test(v));
      expect(SettlementMoneySchema.safeParse(v).success).toBe(unsigned.test(v));
      expect(SignedSettlementMoneySchema.safeParse(v).success).toBe(signed.test(v));
    }
    expect(settlementMoneyProblem('-5')).toBe('negative');
    expect(settlementMoneyProblem('12.345')).toBe('decimals');
    expect(settlementMoneyProblem('1234567890123')).toBe('tooLarge');
    expect(settlementMoneyProblem('0.00', { positive: true })).toBe('zero');
    expect(settlementMoneyProblem('0.01', { positive: true })).toBeNull();
  });

  it('an expense or wage line above zero, refused with a catalog key', () => {
    const line = (amount: string) =>
      SettlementOperatingExpenseItemSchema.safeParse({ amount, reason: 'gas' });
    expect(line('12.50').success).toBe(true);
    const zero = line('0.00');
    expect(zero.success).toBe(false);
    expect(zero.error?.issues[0]?.message).toBe('settlement.errors.invalidDetails');
    expect(line('12.345').error?.issues[0]?.message).toBe('settlement.errors.invalidMoney');
  });
});
