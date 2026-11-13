/**
 * The daily close's form model (review CONF-06): the draft the page
 * edits, built from a saved record, compared with it, checked, and turned
 * into the save request. Pure, so it is tested on its own
 * (__tests__/draftModel.test.ts); it was the top 230 lines of
 * SettlementPage.
 */
import type { SettlementWageItem } from '@compass/contracts';
import { addMoney, centsToMoney, lineCents, toCents } from '@compass/contracts/money';
import {
  SETTLEMENT_MAX_CENTS,
  settlementMoneyProblem,
  type SettlementMoneyProblem,
} from '@compass/contracts/limits';
import { newClientId } from '../../lib/clientId';

export type MoneyField =
  | 'onlineRevenue'
  | 'invoicedCashRevenue'
  | 'operatingExpenses'
  | 'wagesPaid'
  | 'wagesAccrued'
  | 'nextPurchaseReserve'
  | 'priorPurchaseAdjustment'
  | 'cashOnHand';

export type OperatingExpenseDraft = {
  id: string;
  persistedId: string | null;
  amount: string;
  reason: string;
  isHistorical: boolean;
};
export type WageItemDraft = {
  id: string;
  persistedId: string | null;
  memberId: string | null;
  personName: string;
  status: SettlementWageItem['status'];
  amount: string;
  reason: string;
  isHistorical: boolean;
};
export type OperatingExpenseRecordItem = {
  id: string | null;
  amount: string;
  reason: string;
  isHistorical: boolean;
};
export type WageRecordItem = {
  id: string | null;
  memberId: string | null;
  personName: string;
  status: SettlementWageItem['status'];
  amount: string;
  reason: string;
  isHistorical: boolean;
};

export type SettlementRecord = Record<MoneyField, string> & {
  id: string;
  storeId: string;
  date: string;
  note: string | null;
  version: number;
  updatedByName: string | null;
  updatedAt: string;
  operatingExpenseItems: OperatingExpenseRecordItem[];
  wageItems: WageRecordItem[];
};

export type SettlementDraft = Record<MoneyField, string> & {
  note: string;
  correctionReason: string;
  operatingExpenseItems: OperatingExpenseDraft[];
  wageItems: WageItemDraft[];
};

export const MONEY_FIELDS: readonly MoneyField[] = [
  'onlineRevenue',
  'invoicedCashRevenue',
  'operatingExpenses',
  'wagesPaid',
  'wagesAccrued',
  'nextPurchaseReserve',
  'priorPurchaseAdjustment',
  'cashOnHand',
];
export const DIRECT_MONEY_FIELDS: readonly Exclude<
  MoneyField,
  'operatingExpenses' | 'wagesPaid' | 'wagesAccrued'
>[] = [
  'onlineRevenue',
  'invoicedCashRevenue',
  'nextPurchaseReserve',
  'priorPurchaseAdjustment',
  'cashOnHand',
];

export const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;
export function emptyDraft(): SettlementDraft {
  return {
    onlineRevenue: '0',
    invoicedCashRevenue: '0',
    operatingExpenses: '0',
    wagesPaid: '0',
    wagesAccrued: '0',
    nextPurchaseReserve: '0',
    priorPurchaseAdjustment: '0',
    cashOnHand: '0',
    note: '',
    correctionReason: '',
    operatingExpenseItems: [],
    wageItems: [],
  };
}

/** Keep database decimal strings safe for a number input without rounding. */
export function toMoneyInput(value: string | null | undefined): string {
  const raw = String(value ?? '0').trim();
  if (settlementMoneyProblem(raw, { signed: true })) return raw || '0';
  return raw.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

export function draftFromRecord(record: SettlementRecord): SettlementDraft {
  return {
    onlineRevenue: toMoneyInput(record.onlineRevenue),
    invoicedCashRevenue: toMoneyInput(record.invoicedCashRevenue),
    operatingExpenses: toMoneyInput(record.operatingExpenses),
    wagesPaid: toMoneyInput(record.wagesPaid),
    wagesAccrued: toMoneyInput(record.wagesAccrued),
    nextPurchaseReserve: toMoneyInput(record.nextPurchaseReserve),
    priorPurchaseAdjustment: toMoneyInput(record.priorPurchaseAdjustment),
    cashOnHand: toMoneyInput(record.cashOnHand),
    note: record.note ?? '',
    correctionReason: '',
    operatingExpenseItems: (record.operatingExpenseItems ?? []).map((item) => ({
      id: newClientId(),
      persistedId: item.id,
      amount: toMoneyInput(item.amount),
      reason: item.reason,
      isHistorical: item.isHistorical,
    })),
    wageItems: (record.wageItems ?? []).map((item) => ({
      id: newClientId(),
      persistedId: item.id,
      memberId: item.memberId,
      personName: item.personName,
      status: item.status,
      amount: toMoneyInput(item.amount),
      reason: item.reason,
      isHistorical: item.isHistorical,
    })),
  };
}

export type CarriedFields = Partial<
  Pick<SettlementDraft, MoneyField | 'note' | 'correctionReason'>
>;

/** The typed fields that differ from the record the form was loaded from. */
export function editedFields(draft: SettlementDraft, base: SettlementDraft): CarriedFields {
  const carried: CarriedFields = {};
  for (const key of [...MONEY_FIELDS, 'note', 'correctionReason'] as const) {
    if (draft[key] !== base[key]) carried[key] = draft[key];
  }
  return carried;
}

/** Expense / wage lines compared by content (the local row ids are random). */
export function linesEdited(draft: SettlementDraft, base: SettlementDraft): boolean {
  const lines = (d: SettlementDraft) =>
    JSON.stringify([
      d.operatingExpenseItems.map(({ id: _id, ...rest }) => rest),
      d.wageItems.map(({ id: _id, ...rest }) => rest),
    ]);
  return lines(draft) !== lines(base);
}

/** The closes the page lists under the form; the form reads the same list. */
export const RECENT_CLOSES_LIMIT = 7;

/**
 * Review CONF-26: what the form does when the recent closes, refreshed by
 * a `settlement.changed` push, give the day on screen a newer version than
 * the form holds. With nothing typed it loads that version; with unsaved
 * input it shows the conflict banner now, not after Save. `null`: nothing.
 * A list read before the form's record says nothing about it.
 */
export function newerVersionAction({
  listedVersion,
  shownVersion,
  listReadAfterRecord,
  unsavedChanges,
}: {
  /** The day's version in the recent closes, if it is listed. */
  listedVersion: number | undefined;
  /** The version the form holds; 0 when the day has no close yet. */
  shownVersion: number;
  listReadAfterRecord: boolean;
  unsavedChanges: boolean;
}): 'reload' | 'conflict' | null {
  if (listedVersion === undefined || !listReadAfterRecord) return null;
  if (listedVersion <= shownVersion) return null;
  return unsavedChanges ? 'conflict' : 'reload';
}

export function moneyNumber(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Match the API's two-decimal normalization when deciding if this is a
 * correction. CONF-08: the amount rule and the cents are the shared ones
 * (contracts limits / money), as on the server.
 */
export function normalizedMoney(value: string): string {
  const raw = value.trim();
  return isMoney(raw, true) ? centsToMoney(toCents(raw)) : raw;
}

export function isMoney(value: string, signed = false): boolean {
  return settlementMoneyProblem(value.trim(), { signed }) === null;
}

/** A valid, unsigned amount in cents; null otherwise. */
export function moneyToCents(value: string): bigint | null {
  const raw = value.trim();
  return isMoney(raw) ? toCents(raw) : null;
}

export function sumItemAmounts(items: readonly { amount: string }[]): {
  value: string;
  valid: boolean;
} {
  let cents = 0n;
  for (const item of items) {
    const itemCents = moneyToCents(item.amount);
    if (itemCents === null || itemCents <= 0n) return { value: '0.00', valid: false };
    cents += itemCents;
    if (cents > SETTLEMENT_MAX_CENTS) return { value: '0.00', valid: false };
  }
  return { value: centsToMoney(cents), valid: true };
}

export function isValidOperatingExpense(item: OperatingExpenseDraft): boolean {
  return (
    item.isHistorical || (item.reason.trim().length > 0 && (moneyToCents(item.amount) ?? 0n) > 0n)
  );
}

/** S4 (2026-11-13): a wage line's reason is optional. */
export function isValidWageItem(item: WageItemDraft, requireSelectedMember: boolean): boolean {
  return (
    item.isHistorical ||
    ((!requireSelectedMember || !!item.memberId) && (moneyToCents(item.amount) ?? 0n) > 0n)
  );
}

/**
 * S4 (2026-11-13): the amount a wage line takes when its employee is
 * chosen: their daily wage, unless an amount is already typed or none is
 * set.
 */
export function wageAmountOnPick(currentAmount: string, dailyWage: string | null): string {
  if (currentAmount.trim() !== '' || dailyWage === null) return currentAmount;
  return toCents(dailyWage) > 0n ? toMoneyInput(dailyWage) : currentAmount;
}

export function comparableOperatingExpenseItems(items: readonly OperatingExpenseDraft[]) {
  return items.map((item) => ({
    id: item.persistedId,
    amount: normalizedMoney(item.amount),
    reason: item.reason.trim(),
    isHistorical: item.isHistorical,
  }));
}

export function comparableRecordOperatingExpenseItems(
  items: readonly OperatingExpenseRecordItem[],
) {
  return items.map((item) => ({
    id: item.id,
    amount: normalizedMoney(item.amount),
    reason: item.reason.trim(),
    isHistorical: item.isHistorical,
  }));
}

export function comparableWageItems(items: readonly WageItemDraft[] | readonly WageRecordItem[]) {
  return items.map((item) => ({
    id: 'persistedId' in item ? item.persistedId : item.id,
    memberId: item.memberId,
    personName: item.personName.trim(),
    status: item.status,
    amount: normalizedMoney(item.amount),
    reason: item.reason.trim(),
    isHistorical: item.isHistorical,
  }));
}

export function sameDetailItems(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** An empty expense line. */
export function newOperatingExpense(): OperatingExpenseDraft {
  return { id: newClientId(), persistedId: null, amount: '', reason: '', isHistorical: false };
}

/** An expense template as the close offers it (settlement.expenseTemplates). */
export type ExpenseTemplate = {
  id: string;
  label: string;
  defaultQty: string;
  /** Null without prices.view in the close's store. */
  defaultUnitPrice: string | null;
};

/**
 * S5 (2026-11-13): an expense line from a template: its label as the
 * reason and, when its price is shown, qty × price (rounded as every
 * line, D1) as the amount. Without a price, or at 0, the amount is left
 * to type.
 */
export function expenseFromTemplate(template: ExpenseTemplate): OperatingExpenseDraft {
  const cents =
    template.defaultUnitPrice === null
      ? 0n
      : lineCents(template.defaultQty, template.defaultUnitPrice);
  return {
    ...newOperatingExpense(),
    amount: cents > 0n ? toMoneyInput(centsToMoney(cents)) : '',
    reason: template.label,
  };
}

/** An empty wage line: paid, no employee chosen yet. */
export function newWageItem(id: string = newClientId()): WageItemDraft {
  return {
    id,
    persistedId: null,
    memberId: null,
    personName: '',
    status: 'paid',
    amount: '',
    reason: '',
    isHistorical: false,
  };
}

export type ItemTotal = ReturnType<typeof sumItemAmounts>;

/** The totals the expense and wage lines add up to. */
export function detailTotals(draft: SettlementDraft): {
  expenses: ItemTotal;
  paidWages: ItemTotal;
  unpaidWages: ItemTotal;
} {
  return {
    expenses: sumItemAmounts(draft.operatingExpenseItems),
    paidWages: sumItemAmounts(draft.wageItems.filter((item) => item.status === 'paid')),
    unpaidWages: sumItemAmounts(draft.wageItems.filter((item) => item.status === 'unpaid')),
  };
}

/** Every amount the close records: the lines give the three totals. */
export function closeMoney(
  draft: SettlementDraft,
  totals: ReturnType<typeof detailTotals>,
): Record<MoneyField, string> {
  return {
    onlineRevenue: draft.onlineRevenue,
    invoicedCashRevenue: draft.invoicedCashRevenue,
    operatingExpenses: totals.expenses.value,
    wagesPaid: totals.paidWages.value,
    wagesAccrued: totals.unpaidWages.value,
    nextPurchaseReserve: draft.nextPurchaseReserve,
    priorPurchaseAdjustment: draft.priorPurchaseAdjustment,
    cashOnHand: draft.cashOnHand,
  };
}

/** How the form differs from the saved close. */
export interface CloseChanges {
  /** The expense lines differ from the saved ones. */
  expenses: boolean;
  /** The wage lines differ from the saved ones. */
  wages: boolean;
  /** Anything differs. Always true for a new close. */
  any: boolean;
}

export function closeChanges(
  draft: SettlementDraft,
  money: Record<MoneyField, string>,
  existing: SettlementRecord | null,
): CloseChanges {
  if (!existing) return { expenses: false, wages: false, any: true };
  const expenses = !sameDetailItems(
    comparableOperatingExpenseItems(draft.operatingExpenseItems),
    comparableRecordOperatingExpenseItems(existing.operatingExpenseItems ?? []),
  );
  const wages = !sameDetailItems(
    comparableWageItems(draft.wageItems),
    comparableWageItems(existing.wageItems ?? []),
  );
  return {
    expenses,
    wages,
    any:
      MONEY_FIELDS.some(
        (field) => normalizedMoney(money[field]) !== normalizedMoney(existing[field]),
      ) ||
      expenses ||
      wages ||
      draft.note.trim() !== (existing.note ?? '').trim(),
  };
}

/** Whether a line, or what the lines add up to, stops the save. */
export function detailsInvalid(
  draft: SettlementDraft,
  totals: ReturnType<typeof detailTotals>,
  wageSelectionRequired: boolean,
): boolean {
  return (
    !totals.expenses.valid ||
    !totals.paidWages.valid ||
    !totals.unpaidWages.valid ||
    draft.operatingExpenseItems.some((item) => !isValidOperatingExpense(item)) ||
    draft.wageItems.some((item) => !isValidWageItem(item, wageSelectionRequired))
  );
}

/** The summary card's lines; null while a field they add up is invalid. */
export interface SettlementSummaryLines {
  totalRevenue: number | null;
  paidOutflows: number | null;
  futureCommitments: number | null;
  priorPurchaseAdjustment: number | null;
  endingCash: number | null;
}

/**
 * DX-CLS-4 (2026-11-01): a line whose inputs are not valid amounts shows
 * "—" instead of e.g. "-5 UZS" or "99,999,999,999,999 UZS". DX-PFE-12:
 * added in cents, so 0.10 + 0.20 shows 0.30 (D1).
 */
export function settlementSummary(
  draft: SettlementDraft,
  totals: ReturnType<typeof detailTotals>,
): SettlementSummaryLines {
  return {
    totalRevenue:
      isMoney(draft.onlineRevenue) && isMoney(draft.invoicedCashRevenue)
        ? addMoney(moneyNumber(draft.onlineRevenue), moneyNumber(draft.invoicedCashRevenue))
        : null,
    paidOutflows:
      totals.expenses.valid && totals.paidWages.valid
        ? addMoney(moneyNumber(totals.expenses.value), moneyNumber(totals.paidWages.value))
        : null,
    futureCommitments:
      totals.unpaidWages.valid && isMoney(draft.nextPurchaseReserve)
        ? addMoney(moneyNumber(totals.unpaidWages.value), moneyNumber(draft.nextPurchaseReserve))
        : null,
    priorPurchaseAdjustment: isMoney(draft.priorPurchaseAdjustment, true)
      ? moneyNumber(draft.priorPurchaseAdjustment)
      : null,
    endingCash: isMoney(draft.cashOnHand) ? moneyNumber(draft.cashOnHand) : null,
  };
}

/** Whether `field` holds a valid amount (only the purchase adjustment may be negative). */
export function directMoneyValid(
  draft: SettlementDraft,
  field: (typeof DIRECT_MONEY_FIELDS)[number],
): boolean {
  return isMoney(draft[field], field === 'priorPurchaseAdjustment');
}

/**
 * A11Y-2: how many fields stop the save, for the banner under the form
 * ("2 栏需要改正") and the save button, which jumps to the first of them.
 */
export function countFieldsToFix(
  draft: SettlementDraft,
  wageSelectionRequired: boolean,
  correctionReady: boolean,
): number {
  return (
    DIRECT_MONEY_FIELDS.filter((field) => !directMoneyValid(draft, field)).length +
    draft.operatingExpenseItems.filter((item) => !isValidOperatingExpense(item)).length +
    draft.wageItems.filter((item) => !isValidWageItem(item, wageSelectionRequired)).length +
    (correctionReady ? 0 : 1)
  );
}

/**
 * 2026-11-13: the first thing, in screen order, that keeps the save
 * button grey, so the bar can say it ("Expense 1 · Amount: enter the
 * amount."). An expense from a template has no amount for a member who
 * cannot see prices, and the grey button gave no reason. Null when the
 * form itself does not stop the save.
 */
export type SaveBlocker =
  | {
      kind: 'money';
      field: (typeof DIRECT_MONEY_FIELDS)[number];
      problem: SettlementMoneyProblem;
    }
  | { kind: 'expenseAmount'; n: number; problem: SettlementMoneyProblem }
  | { kind: 'expenseReason'; n: number }
  | { kind: 'wageEmployee'; n: number }
  | { kind: 'wageAmount'; n: number; problem: SettlementMoneyProblem }
  | { kind: 'totalTooLarge' }
  | { kind: 'correctionReason' }
  | { kind: 'noChanges' };

export function firstSaveBlocker(q: {
  draft: SettlementDraft;
  totals: ReturnType<typeof detailTotals>;
  wageSelectionRequired: boolean;
  correctionReady: boolean;
  hasChanges: boolean;
}): SaveBlocker | null {
  const { draft } = q;
  const money = (field: (typeof DIRECT_MONEY_FIELDS)[number]): SaveBlocker | null => {
    const problem = settlementMoneyProblem(draft[field].trim(), {
      signed: field === 'priorPurchaseAdjustment',
    });
    return problem ? { kind: 'money', field, problem } : null;
  };
  const lineAmount = (amount: string) => settlementMoneyProblem(amount.trim(), { positive: true });
  const expense = (): SaveBlocker | null => {
    for (const [index, item] of draft.operatingExpenseItems.entries()) {
      if (item.isHistorical) continue;
      const problem = lineAmount(item.amount);
      if (problem) return { kind: 'expenseAmount', n: index + 1, problem };
      if (item.reason.trim().length === 0) return { kind: 'expenseReason', n: index + 1 };
    }
    return null;
  };
  const wage = (): SaveBlocker | null => {
    for (const [index, item] of draft.wageItems.entries()) {
      if (item.isHistorical) continue;
      if (q.wageSelectionRequired && !item.memberId) return { kind: 'wageEmployee', n: index + 1 };
      const problem = lineAmount(item.amount);
      if (problem) return { kind: 'wageAmount', n: index + 1, problem };
    }
    return null;
  };
  const totalsValid =
    q.totals.expenses.valid && q.totals.paidWages.valid && q.totals.unpaidWages.valid;
  return (
    money('onlineRevenue') ??
    money('invoicedCashRevenue') ??
    expense() ??
    wage() ??
    money('nextPurchaseReserve') ??
    money('priorPurchaseAdjustment') ??
    money('cashOnHand') ??
    (totalsValid ? null : { kind: 'totalTooLarge' }) ??
    (q.correctionReady ? null : { kind: 'correctionReason' }) ??
    (q.hasChanges ? null : { kind: 'noChanges' })
  );
}

/** A new close has input: an amount that is not 0, a note, or a line. */
export function newCloseHasInput(draft: SettlementDraft): boolean {
  return (
    DIRECT_MONEY_FIELDS.some((field) => normalizedMoney(draft[field]) !== '0.00') ||
    draft.note.trim().length > 0 ||
    draft.operatingExpenseItems.length > 0 ||
    draft.wageItems.length > 0
  );
}

/**
 * CLS-24 / R2-INT-3 (2026-10-31): a new close with every amount 0 and no
 * lines is usually an untouched form, not a closed-and-empty day; it
 * needs a yes before it is stored.
 */
export function isAllZeroClose(draft: SettlementDraft): boolean {
  return (
    DIRECT_MONEY_FIELDS.every((field) => normalizedMoney(draft[field]) === '0.00') &&
    draft.operatingExpenseItems.length === 0 &&
    draft.wageItems.length === 0
  );
}

/** What settlement.save is sent for `draft`. */
export function settlementSaveInput(q: {
  storeId: string;
  date: string;
  draft: SettlementDraft;
  money: Record<MoneyField, string>;
  existing: SettlementRecord | null;
  expensesChanged: boolean;
  wagesChanged: boolean;
  needsCorrectionReason: boolean;
}) {
  const { draft, existing } = q;
  const operatingExpenseItems = draft.operatingExpenseItems.map((item) => ({
    ...(item.persistedId ? { id: item.persistedId } : {}),
    amount: item.amount.trim(),
    reason: item.reason.trim(),
  }));
  const wageItems = draft.wageItems.map((item) => ({
    ...(item.persistedId ? { id: item.persistedId } : {}),
    ...(item.memberId ? { memberId: item.memberId } : { personName: item.personName.trim() }),
    status: item.status,
    amount: item.amount.trim(),
    reason: item.reason.trim(),
  }));
  return {
    storeId: q.storeId,
    date: q.date,
    onlineRevenue: draft.onlineRevenue.trim(),
    invoicedCashRevenue: draft.invoicedCashRevenue.trim(),
    // Detail rows are the source of truth; the scalars are sent only so
    // the API can reject a malformed/mismatched client rather than ever
    // saving a total that does not equal its explanation.
    operatingExpenses: q.money.operatingExpenses,
    wagesPaid: q.money.wagesPaid,
    wagesAccrued: q.money.wagesAccrued,
    // Preserve raw historical arrays when this section did not change. In
    // particular, a total-only old close must never be rewritten with a
    // display-only virtual detail row merely because revenue was corrected.
    ...(existing && !q.expensesChanged ? {} : { operatingExpenseItems }),
    ...(existing && !q.wagesChanged ? {} : { wageItems }),
    nextPurchaseReserve: draft.nextPurchaseReserve.trim(),
    priorPurchaseAdjustment: draft.priorPurchaseAdjustment.trim(),
    cashOnHand: draft.cashOnHand.trim(),
    note: draft.note.trim() || null,
    correctionReason: q.needsCorrectionReason ? draft.correctionReason.trim() : null,
    expectedVersion: existing?.version ?? 0,
  };
}
