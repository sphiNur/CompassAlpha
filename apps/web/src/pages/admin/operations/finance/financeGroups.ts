/**
 * Finance's three views over one list of purchase lines: by day, by
 * stall and by store. Review ADM2-10 (2026-11-11): the section built each
 * view with its own copy of the same loop.
 */
import { addMoney } from '@compass/contracts/money';

export type FinanceView = 'daily' | 'bySupplier' | 'byStore';

/** The fields of a purchase line (report.purchaseLines) the grouping reads. */
export interface FinanceLineLike {
  runDate: string;
  storeId: string;
  supplierId: string | null;
  kind: 'item' | 'expense';
  paymentMethod: 'cash' | 'transfer';
  /** Null without prices.view for the line's store (D6). */
  lineTotal: string | null;
}

/** The stall view's group for expenses, which have no stall. */
export const EXPENSE_GROUP = '__expense';
/** The stall view's group for bought items with no stall recorded. */
export const NO_SUPPLIER_GROUP = '__none';

export interface FinanceGroup<L> {
  /** The day (YYYY-MM-DD), the stall id or one of the two groups above, or the store id. */
  key: string;
  /** Money in UZS, added in whole cents (addMoney). */
  cash: number;
  transfer: number;
  /** D6: lines without an amount; the group's money is then unknown. */
  unpriced: number;
  lines: L[];
}

/** The group a line belongs to in a view. */
export function financeGroupKey(line: FinanceLineLike, view: FinanceView): string {
  if (view === 'daily') return line.runDate;
  if (view === 'byStore') return line.storeId;
  // Expenses have no stall; they get their own group rather than swelling
  // the group of bought items with no stall recorded.
  return line.kind === 'expense' ? EXPENSE_GROUP : (line.supplierId ?? NO_SUPPLIER_GROUP);
}

/**
 * The lines grouped for a view, in the order the view lists them: the
 * newest day first, or the most money first. Lines keep their order
 * within a group.
 */
export function groupFinanceLines<L extends FinanceLineLike>(
  lines: readonly L[],
  view: FinanceView,
): FinanceGroup<L>[] {
  const groups = new Map<string, FinanceGroup<L>>();
  for (const line of lines) {
    const key = financeGroupKey(line, view);
    let group = groups.get(key);
    if (!group) {
      group = { key, cash: 0, transfer: 0, unpriced: 0, lines: [] };
      groups.set(key, group);
    }
    if (line.lineTotal === null) group.unpriced += 1;
    if (line.paymentMethod === 'transfer')
      group.transfer = addMoney(group.transfer, line.lineTotal);
    else group.cash = addMoney(group.cash, line.lineTotal);
    group.lines.push(line);
  }
  const list = [...groups.values()];
  return view === 'daily'
    ? list.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0))
    : list.sort((a, b) => addMoney(b.cash, b.transfer) - addMoney(a.cash, a.transfer));
}
