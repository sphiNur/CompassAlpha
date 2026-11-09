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

/**
 * CONF-08 (2026-11-09): an amount in the daily close, stored as
 * numeric(14,2): digits, at most 12 before the point and 2 after; a minus
 * only where the field allows one (the previous procurement's carry);
 * above zero for an expense or wage line. The server's schemas and the
 * close page ask this one function, so their rules cannot drift apart, and
 * the page says which rule a field breaks (DX-CLS-3). `value` is the text
 * as sent; the page trims its fields first.
 */
export type SettlementMoneyProblem =
  | 'empty'
  | 'negative'
  | 'notNumber'
  | 'decimals'
  | 'tooLarge'
  | 'zero';

export function settlementMoneyProblem(
  value: string,
  opts: { signed?: boolean; positive?: boolean } = {},
): SettlementMoneyProblem | null {
  if (value === '') return 'empty';
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  if (!/^\d+(?:\.\d+)?$/.test(unsigned)) return 'notNumber';
  if (negative && !opts.signed) return 'negative';
  const [whole = '', fraction = ''] = unsigned.split('.');
  if (fraction.length > 2) return 'decimals';
  if (whole.length > 12) return 'tooLarge';
  if (opts.positive && !/[1-9]/.test(unsigned)) return 'zero';
  return null;
}

/** CONF-08: the largest amount a daily close total may reach, in cents. */
export const SETTLEMENT_MAX_CENTS = 99_999_999_999_999n;

/** CONF-08: at most this many expense lines, and wage lines, in one close. */
export const SETTLEMENT_DETAIL_ITEMS_MAX = 100;

/** The face-registration consent text the person agreed to. */
export const ATTENDANCE_FACE_CONSENT_VERSION = 1;

/**
 * Where a phone's fix still places someone at the store: a fix coarser
 * than this cannot, and the phone's own uncertainty counts for up to the
 * slack. The phone checks the same before it opens the camera
 * (2026-11-07), so nobody does the face check only to hear they are too
 * far; the server decides.
 */
export const ATTENDANCE_MAX_ACCURACY_M = 300;
export const ATTENDANCE_ACCURACY_SLACK_M = 50;

/**
 * A colleague clocked on someone's phone (owner decision 2026-11-07):
 * for this long the phone that did it can take it back ("not them", the
 * face was taken for the wrong colleague), and that colleague is not
 * clocked again on any phone (a punch sent twice would otherwise be their
 * clock-in and, a minute later, their clock-out).
 */
export const ATTENDANCE_UNDO_WINDOW_MS = 2 * 60_000;
