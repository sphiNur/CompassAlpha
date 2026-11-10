import { settlementMoneyProblem, type SettlementMoneyProblem } from '@compass/contracts/limits';

/**
 * DX-CLS-3 / DX-CLS-4 (2026-11-01): why an amount in the daily close
 * can't be saved, so the line under the field can say it.
 *
 * Every bad amount used to read "enter a number, at most two decimals" —
 * a negative one, an empty one and a 14-digit one alike — and the
 * expense / wage lines only turned their edge red, with no words at all.
 * The rule is the server's own (CONF-08: `settlementMoneyProblem`): at most
 * 12 whole digits and 2 decimals, signed only where the field allows it,
 * and above zero for an expense or wage line. The field's text is trimmed.
 */
export type MoneyProblem = SettlementMoneyProblem;

export function moneyProblem(
  value: string,
  opts: { signed?: boolean; positive?: boolean } = {},
): MoneyProblem | null {
  return settlementMoneyProblem(value.trim(), opts);
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
