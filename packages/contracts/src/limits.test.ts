/**
 * P-5 (2026-10-31): limits.ts is what the web imports instead of the
 * barrel, so zod stays out of its bundle. Pin that it stays zod-free and
 * that the plain checks agree with the schemas the server enforces.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  ATTENDANCE_ACCURACY_SLACK_M,
  ATTENDANCE_GRACE_MINUTES,
  ATTENDANCE_MAX_ACCURACY_M,
  ATTENDANCE_OVERTIME_AFTER_MINUTES,
  ATTENDANCE_RADIUS_M,
  isPurchasePrice,
  locationVerdict,
  ORDER_QTY_MAX,
  SKU_STEPS,
  SKU_UNITS,
  SORT_INDEX_RANGE,
  settlementMoneyProblem,
  stocktakeCountProblem,
  TAX_RATE_MESSAGE,
  taxRateProblem,
  taxRateToSend,
  wholeNumberIn,
} from './limits';
import { OrderQtySchema } from './schemas/common';
import {
  SettlementOperatingExpenseItemSchema,
  SettlementMoneySchema,
  SignedSettlementMoneySchema,
} from './schemas/settlement';
import { SkuStepSchema, SkuUnitSchema, SortIndexSchema } from './schemas/catalog';
import { PurchasePriceSchema } from './schemas/run';
import { AttendancePolicySaveInputSchema } from './schemas/attendance';
import * as barrel from './index';

describe('limits.ts', () => {
  it('imports nothing (no zod)', () => {
    // Review TEST4-16: read the way a bundler reads it, so an `export …
    // from`, a dynamic `import()` or a `require` counts too; a regex over
    // the source saw only `import` at the start of a line. Type-only
    // imports are left out, as they are from the bundle.
    const src = readFileSync(new URL('./limits.ts', import.meta.url), 'utf8');
    expect(new Bun.Transpiler({ loader: 'ts' }).scanImports(src)).toEqual([]);
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

  it('taxRateProblem: the finance sheet and orgFinanceUpdate ask one rule (ADM1-14)', () => {
    for (const ok of ['0', '0.00', '7', '12.5', '12.50', '50', '50.00']) {
      expect(taxRateProblem(ok)).toBeNull();
    }
    for (const bad of ['', '12,5', '-1', '7.125', '1e1', '.5', '12.', 'abc', '1000']) {
      expect(taxRateProblem(bad)).toBe('format');
    }
    for (const high of ['50.01', '51', '100', '999.99']) {
      expect(taxRateProblem(high)).toBe('range');
    }
    expect(TAX_RATE_MESSAGE).toEqual({
      format: 'admin.errors.taxRateFormat',
      range: 'admin.errors.taxRateOutOfRange',
    });
  });

  it('taxRateToSend sends a number still being typed as the server takes it', () => {
    expect(taxRateToSend('12.')).toBe('12');
    expect(taxRateToSend('.5')).toBe('0.5');
    expect(taxRateToSend('12.50')).toBe('12.5');
    expect(taxRateToSend('007')).toBe('7');
    // Not a reading of the field: left for taxRateProblem to name.
    expect(taxRateToSend('')).toBe('');
    expect(taxRateToSend('12,5')).toBe('12,5');
    for (const typed of ['12.', '.5', '12.50', '0', '49.99']) {
      expect(taxRateProblem(taxRateToSend(typed))).toBeNull();
    }
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

  it('locationVerdict is the one rule for the clock-in area (ATT-08)', () => {
    const at = (distanceM: number, accuracyM: number) =>
      locationVerdict({ distanceM, accuracyM, radiusM: 100 });
    expect([at(100, 0), at(101, 0)]).toEqual(['inside', 'outside']);
    // The fix's own uncertainty counts, up to the slack.
    expect([at(130, 30), at(131, 30)]).toEqual(['inside', 'outside']);
    const slack = ATTENDANCE_ACCURACY_SLACK_M;
    expect([at(100 + slack, 200), at(101 + slack, 200)]).toEqual(['inside', 'outside']);
    // A fix coarser than the cap places no one, even at the centre.
    expect(at(0, ATTENDANCE_MAX_ACCURACY_M)).toBe('inside');
    expect(at(0, ATTENDANCE_MAX_ACCURACY_M + 1)).toBe('inaccurate');
  });

  it('wholeNumberIn reads only a whole number inside the range (NEW-06)', () => {
    const range = { min: 0, max: 120 };
    expect(wholeNumberIn('0', range)).toBe(0);
    expect(wholeNumberIn('120', range)).toBe(120);
    expect(wholeNumberIn('007', range)).toBe(7);
    // An emptied field is not 0, and nothing else Number() accepts is read.
    for (const text of ['', ' ', '121', '-1', '1.5', '12.', '1e2', '0x10', ' 5', '5 ']) {
      expect({ text, read: wholeNumberIn(text, range) }).toEqual({ text, read: null });
    }
  });

  it('the attendance form and the policy schema share one range per rule (NEW-06)', () => {
    const policy = (over: Record<string, unknown>) =>
      AttendancePolicySaveInputSchema.safeParse({
        storeId: '00000000-0000-4000-8000-000000000001',
        requireDevice: false,
        requireGeo: false,
        geo: null,
        graceMinutes: 5,
        overtimeAfterMinutes: 30,
        ...over,
      }).success;
    const geo = (radiusM: number) => ({ geo: { lat: 0, lng: 0, radiusM } });
    const rules = [
      [ATTENDANCE_RADIUS_M, geo],
      [ATTENDANCE_GRACE_MINUTES, (n: number) => ({ graceMinutes: n })],
      [ATTENDANCE_OVERTIME_AFTER_MINUTES, (n: number) => ({ overtimeAfterMinutes: n })],
    ] as const;
    for (const [range, field] of rules) {
      for (const n of [range.min - 1, range.min, range.max, range.max + 1]) {
        expect({ n, form: wholeNumberIn(String(n), range) !== null }).toEqual({
          n,
          form: policy(field(n)),
        });
      }
    }
  });

  it('a sort position takes a minus sign and the schema’s range (NEW-07)', () => {
    expect(wholeNumberIn('-5', SORT_INDEX_RANGE)).toBe(-5);
    expect(Object.is(wholeNumberIn('-0', SORT_INDEX_RANGE), 0)).toBe(true);
    for (const text of ['', '-', '--1', '1-', '-1.5', '+1', ' -1']) {
      expect({ text, read: wholeNumberIn(text, SORT_INDEX_RANGE) }).toEqual({ text, read: null });
    }
    // A range that starts at zero still refuses the sign (NEW-06).
    expect(wholeNumberIn('-0', ATTENDANCE_GRACE_MINUTES)).toBeNull();
    const { min, max } = SORT_INDEX_RANGE;
    for (const n of [min - 1, min, max, max + 1]) {
      expect({ n, form: wholeNumberIn(String(n), SORT_INDEX_RANGE) !== null }).toEqual({
        n,
        form: SortIndexSchema.safeParse(n).success,
      });
    }
  });
});
