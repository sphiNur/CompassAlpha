/**
 * DX-HIS-2 (2026-11-01): the money an expense card shows.
 *
 * Without prices.view the server sends an expense's unitPrice as null
 * (D6), and the card read it with Number(null) = 0: "1 · 0 UZS" and
 * "1 × = 0 UZS" for a 40,000 taxi, as if it were free. It also added
 * floats. Now an expense with no price shows no amount at all, and the
 * card total — only when every expense has a price — is the D1 sum:
 * each line rounded half-up to cents, added in cents.
 *
 * RUNWEB2-02 (2026-11-09): a line is one store's share (D1), as on the
 * settlement sheet, in history and on the server. The card used to take
 * the whole expense as one line: 12,345 shared 0.333 / 0.333 / 0.334 read
 * 12,345.00 here and 12,345.01 everywhere else. It now calls the
 * settlement rule and only adds "no price, no amount".
 *
 * Pure; tests in __tests__/expenseMoney.test.ts.
 */
import { sumMoney } from '@compass/contracts/money';
import { expenseLine as settlementExpenseLine } from './settlement';

type ExpenseIn = {
  qty: string;
  unitPrice: string | null | undefined;
  storeSplits?: ReadonlyArray<{ qty: string; unitPrice?: string | null }> | null;
};

/** One expense's amount, or null when its price is not shown. */
export function expenseLine(expense: ExpenseIn): string | null {
  if (expense.unitPrice == null || expense.unitPrice === '') return null;
  return settlementExpenseLine({ ...expense, unitPrice: expense.unitPrice }).toFixed(2);
}

/** The card total, or null when any expense's amount is hidden. */
export function expensesTotal(expenses: readonly ExpenseIn[]): string | null {
  const lines = expenses.map(expenseLine);
  if (lines.some((line) => line === null)) return null;
  return sumMoney(lines);
}
