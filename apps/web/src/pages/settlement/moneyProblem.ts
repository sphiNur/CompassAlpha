/**
 * DX-CLS-3 / DX-CLS-4 (2026-11-01): why an amount in the daily close
 * can't be saved, so the line under the field can say it.
 *
 * Every bad amount used to read "enter a number, at most two decimals" —
 * a negative one, an empty one and a 14-digit one alike — and the
 * expense / wage lines only turned their edge red, with no words at all.
 * The rules are the page's own (SettlementPage `isMoney` / `moneyToCents`):
 * at most 12 whole digits and 2 decimals, signed only where the field
 * allows it, and above zero for an expense or wage line.
 */
export type MoneyProblem = 'empty' | 'negative' | 'notNumber' | 'decimals' | 'tooLarge' | 'zero';

export function moneyProblem(
  value: string,
  opts: { signed?: boolean; positive?: boolean } = {},
): MoneyProblem | null {
  const raw = value.trim();
  if (raw === '') return 'empty';
  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;
  if (!/^\d+(?:\.\d+)?$/.test(unsigned)) return 'notNumber';
  if (negative && !opts.signed) return 'negative';
  const [whole = '', fraction = ''] = unsigned.split('.');
  if (fraction.length > 2) return 'decimals';
  if (whole.length > 12) return 'tooLarge';
  if (opts.positive && !/[1-9]/.test(unsigned)) return 'zero';
  return null;
}

/** Catalog keys, each with a `{field}` placeholder for the field's name. */
export const MONEY_PROBLEM_MESSAGE = {
  // A top-level amount: an empty field means "nothing", which is 0.
  empty: 'settlement.errors.moneyEmpty',
  negative: 'settlement.errors.moneyNegative',
  notNumber: 'settlement.errors.moneyNotNumber',
  decimals: 'settlement.errors.moneyDecimals',
  tooLarge: 'settlement.errors.moneyTooLarge',
  zero: 'settlement.errors.itemAmountZero',
} as const satisfies Record<MoneyProblem, string>;

/** An expense or wage line needs an amount; "fill in 0" would be wrong there. */
export const ITEM_MONEY_PROBLEM_MESSAGE = {
  ...MONEY_PROBLEM_MESSAGE,
  empty: 'settlement.errors.itemAmountEmpty',
} as const satisfies Record<MoneyProblem, string>;
