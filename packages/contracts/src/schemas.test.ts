/**
 * Review TEST4-07 (2026-11): the input schemas had tests only for the
 * limits they share with the web. These pin the refusals: a value the
 * server must reject, with a catalog key the screen can show (a bare zod
 * sentence used to reach the form as "出错了").
 */
import { describe, expect, it } from 'bun:test';
import type { ZodTypeAny } from 'zod';
import {
  DateStringSchema,
  DecimalStringSchema,
  OrderQtySchema,
  PositiveDecimalStringSchema,
  TimeZoneSchema,
} from './schemas/common';
import { PurchaseQtySchema } from './schemas/run';
import { SettlementMoneySchema, SignedSettlementMoneySchema } from './schemas/settlement';

function verdict(schema: ZodTypeAny, value: unknown): string {
  const r = schema.safeParse(value);
  return r.success ? 'ok' : (r.error.issues[0]?.message ?? '?');
}

function check(schema: ZodTypeAny, cases: Record<string, string>) {
  for (const [value, want] of Object.entries(cases)) {
    expect({ value, got: verdict(schema, value) }).toEqual({ value, got: want });
  }
}

describe('DateStringSchema', () => {
  it('takes a day that exists, between 1900 and 2999', () => {
    const bad = 'common.errors.invalidDate';
    check(DateStringSchema, {
      '2026-11-10': 'ok',
      '2024-02-29': 'ok',
      '2026-02-29': bad,
      '2026-02-31': bad,
      '2026-13-01': bad,
      '0000-01-01': bad,
      '1899-12-31': bad,
      '3000-01-01': bad,
      '2026-1-5': bad,
      ' 2026-01-05': bad,
      '2026-01-05T00:00:00Z': bad,
    });
  });
});

describe('decimal strings', () => {
  it('DecimalStringSchema: up to three decimals, a dot, an optional minus', () => {
    const bad = 'common.errors.invalidDecimal';
    check(DecimalStringSchema, {
      '0': 'ok',
      '-1.5': 'ok',
      '12.125': 'ok',
      '1.2345': bad,
      '1,5': bad,
      '.5': bad,
      '1.': bad,
      '': bad,
      '1e3': bad,
    });
  });

  it('PositiveDecimalStringSchema refuses zero and below', () => {
    const bad = 'common.errors.positiveDecimal';
    check(PositiveDecimalStringSchema, { '0.001': 'ok', '0': bad, '0.000': bad, '-1': bad });
  });

  it('OrderQtySchema caps the quantity either way', () => {
    check(OrderQtySchema, {
      '999999': 'ok',
      '-999999': 'ok',
      '1000000': 'order.errors.qtyTooLarge',
      '-1000000': 'order.errors.qtyTooLarge',
    });
  });

  it('PurchaseQtySchema: positive, nine digits, three decimals', () => {
    const bad = 'run.errors.qtyFormat';
    check(PurchaseQtySchema, {
      '1': 'ok',
      '999999999.999': 'ok',
      '0': bad,
      '1.2345': bad,
      '1234567890': bad,
      '-1': bad,
    });
  });
});

describe('daily-close money', () => {
  it('SettlementMoneySchema: two decimals, twelve digits, never negative', () => {
    const bad = 'settlement.errors.invalidMoney';
    check(SettlementMoneySchema, {
      '0': 'ok',
      '999999999999.99': 'ok',
      '1.005': bad,
      '1234567890123': bad,
      '-5.00': bad,
      '1,50': bad,
    });
  });

  it('SignedSettlementMoneySchema also takes a credit (negative)', () => {
    check(SignedSettlementMoneySchema, {
      '-5.00': 'ok',
      '-999999999999.99': 'ok',
      '--5': 'settlement.errors.invalidMoney',
    });
  });
});

describe('TimeZoneSchema', () => {
  it('takes a zone the runtime knows, trimmed', () => {
    expect(TimeZoneSchema.parse(' Asia/Tashkent ')).toBe('Asia/Tashkent');
    check(TimeZoneSchema, {
      UTC: 'ok',
      'Mars/Olympus': 'admin.errors.timeZoneUnknown',
      '': 'admin.errors.timeZoneUnknown',
    });
  });
});
