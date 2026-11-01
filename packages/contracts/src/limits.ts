/**
 * Plain limits and date helpers, with no zod import.
 *
 * P-5 (2026-10-31): the web imported ORDER_QTY_MAX from the package
 * barrel; every schema module calls `z.object(...)` at the top level,
 * which the bundler must keep, so the whole of zod and every schema
 * landed in the web's main chunk for one number. Web code imports these
 * from `@compass/contracts/limits`; `schemas/common.ts` re-exports them,
 * so server imports from the barrel are unchanged.
 */

/**
 * ORD-9 (2026-10-30): an order line quantity. A mistyped 1,000,000,000
 * overflowed numeric(12,3) as a 500, and 9,999,999 kg was saved without
 * a word. A million of anything per line is far beyond a kitchen order.
 */
export const ORDER_QTY_MAX = 999_999.999;

/**
 * CLS-14 / CLS-19 (2026-10-30, user decision): how far back a new daily
 * close or a back-filled sale may be dated.
 */
export const BACKDATE_LIMIT_DAYS = 90;

/** A calendar date `days` before `isoDate` (YYYY-MM-DD in, out). */
export function isoDateDaysBefore(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** SKU units (2026-07-30): the fixed vocabulary; `SkuUnitSchema` is built from it. */
export const SKU_UNITS = ['kg', 'L', 'pcs', 'pack', 'bunch', 'box', 'roll', 'pair'] as const;

/** SKU steps (M3.14): the canonical +/- grid; `SkuStepSchema` is built from it. */
export const SKU_STEPS = ['0.5', '1', '10', '50', '100'] as const;

/**
 * RE-ENG-1 / BUY-15 (2026-10-30): a purchase price the column stores —
 * numeric(14,2): above 0, at most 12 digits and 2 decimals.
 * `PurchasePriceSchema` uses the same rule.
 */
export const PURCHASE_PRICE_RE = /^\d{1,12}(\.\d{1,2})?$/;

export function isPurchasePrice(v: string): boolean {
  return PURCHASE_PRICE_RE.test(v) && Number(v) > 0;
}

/** CLS-19 (2026-10-30): a stocktake count has at most 8 integer digits. */
export const STOCKTAKE_COUNT_MAX = 99_999_999.999;

export type StocktakeCountProblem = 'empty' | 'negative' | 'notNumber' | 'decimals' | 'tooLarge';

/**
 * DX-INV-1 (2026-11-01): why a counted on-hand quantity can't be saved,
 * or null when it can. Empty, negative, letters, four decimals and a huge
 * number were all answered "quantity too large". The server refuses with
 * the matching `inventory.errors.count*` key; the stocktake sheet runs the
 * same check before Save. `value` is the plain decimal text (the web reads
 * the field with readDecimalText first, so "1,5" arrives as "1.5").
 */
export function stocktakeCountProblem(value: string): StocktakeCountProblem | null {
  const v = value.trim();
  if (v === '') return 'empty';
  if (/^-\s*(\d+\.?\d*|\.\d+)$/.test(v) && Number(v) < 0) return 'negative';
  if (!/^(\d+\.?\d*|\.\d+)$/.test(v)) return 'notNumber';
  const [whole = '', fraction = ''] = v.split('.');
  if (fraction.length > 3) return 'decimals';
  if (whole.replace(/^0+(?=\d)/, '').length > 8) return 'tooLarge';
  return null;
}

/** The catalog key the server and the stocktake sheet show for each problem. */
export const STOCKTAKE_COUNT_MESSAGE = {
  empty: 'inventory.errors.countRequired',
  negative: 'inventory.errors.countNegative',
  notNumber: 'inventory.errors.countNotNumber',
  decimals: 'inventory.errors.countDecimals',
  tooLarge: 'inventory.errors.countTooLarge',
} as const satisfies Record<StocktakeCountProblem, string>;
