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
 * Pure; tests in __tests__/expenseMoney.test.ts.
 */
import { lineAmount, sumMoney } from '@compass/contracts/money';

type ExpenseIn = { qty: string; unitPrice: string | null | undefined };

/** One expense line, or null when its price is not shown. */
export function expenseLine(expense: ExpenseIn): string | null {
  if (expense.unitPrice == null || expense.unitPrice === '') return null;
  try {
    return lineAmount(expense.qty, expense.unitPrice);
  } catch {
    return null;
  }
}

/** The card total, or null when any expense's amount is hidden. */
export function expensesTotal(expenses: readonly ExpenseIn[]): string | null {
  const lines = expenses.map(expenseLine);
  if (lines.some((line) => line === null)) return null;
  return sumMoney(lines);
}
