import { describe, expect, test } from 'bun:test';
import {
  closeChanges,
  closeMoney,
  countFieldsToFix,
  detailTotals,
  detailsInvalid,
  draftFromRecord,
  editedFields,
  emptyDraft,
  isAllZeroClose,
  isValidOperatingExpense,
  isValidWageItem,
  linesEdited,
  newCloseHasInput,
  newOperatingExpense,
  newWageItem,
  newerVersionAction,
  normalizedMoney,
  settlementSaveInput,
  settlementSummary,
  sumItemAmounts,
  toMoneyInput,
  type OperatingExpenseDraft,
  type SettlementDraft,
  type SettlementRecord,
  type WageItemDraft,
} from '../draftModel';

function expense(patch: Partial<OperatingExpenseDraft> = {}): OperatingExpenseDraft {
  return { ...newOperatingExpense(), amount: '100', reason: 'Gas', ...patch };
}

function wage(patch: Partial<WageItemDraft> = {}): WageItemDraft {
  return {
    ...newWageItem(),
    memberId: 'm-1',
    personName: 'Ali',
    amount: '200',
    reason: 'Shift',
    ...patch,
  };
}

function draft(patch: Partial<SettlementDraft> = {}): SettlementDraft {
  return { ...emptyDraft(), ...patch };
}

function record(patch: Partial<SettlementRecord> = {}): SettlementRecord {
  return {
    id: 'set-1',
    storeId: 'store-1',
    date: '2026-11-10',
    note: 'Quiet day',
    version: 2,
    updatedByName: 'Cashier',
    updatedAt: '2026-11-10T18:00:00.000Z',
    onlineRevenue: '1500.00',
    invoicedCashRevenue: '250.50',
    operatingExpenses: '100.00',
    wagesPaid: '200.00',
    wagesAccrued: '0.00',
    nextPurchaseReserve: '0.00',
    priorPurchaseAdjustment: '-20.00',
    cashOnHand: '900.00',
    operatingExpenseItems: [{ id: 'e-1', amount: '100.00', reason: 'Gas', isHistorical: false }],
    wageItems: [
      {
        id: 'w-1',
        memberId: 'm-1',
        personName: 'Ali',
        status: 'paid',
        amount: '200.00',
        reason: 'Shift',
        isHistorical: false,
      },
    ],
    ...patch,
  };
}

describe('toMoneyInput', () => {
  test('drops the trailing zeros a database decimal carries', () => {
    expect(toMoneyInput('1500.00')).toBe('1500');
    expect(toMoneyInput('250.50')).toBe('250.5');
    expect(toMoneyInput('-20.00')).toBe('-20');
    expect(toMoneyInput('0.00')).toBe('0');
  });

  test('a missing amount is 0; one that is not an amount is kept to be fixed', () => {
    expect(toMoneyInput(null)).toBe('0');
    expect(toMoneyInput(undefined)).toBe('0');
    expect(toMoneyInput('abc')).toBe('abc');
  });
});

describe('draftFromRecord', () => {
  test('fills the form from a saved close, with no correction reason yet', () => {
    const form = draftFromRecord(record());
    expect(form.onlineRevenue).toBe('1500');
    expect(form.invoicedCashRevenue).toBe('250.5');
    expect(form.priorPurchaseAdjustment).toBe('-20');
    expect(form.note).toBe('Quiet day');
    expect(form.correctionReason).toBe('');
    expect(form.operatingExpenseItems).toEqual([
      expect.objectContaining({ persistedId: 'e-1', amount: '100', reason: 'Gas' }),
    ]);
    expect(form.wageItems).toEqual([
      expect.objectContaining({ persistedId: 'w-1', memberId: 'm-1', amount: '200' }),
    ]);
  });

  test('a close without a note has an empty one', () => {
    expect(draftFromRecord(record({ note: null })).note).toBe('');
  });

  test('each line gets its own local id', () => {
    const form = draftFromRecord(
      record({
        operatingExpenseItems: [
          { id: 'e-1', amount: '1', reason: 'a', isHistorical: false },
          { id: 'e-2', amount: '2', reason: 'b', isHistorical: false },
        ],
      }),
    );
    const [a, b] = form.operatingExpenseItems;
    expect(a!.id).not.toBe(b!.id);
  });
});

describe('editedFields and linesEdited (CLS-18)', () => {
  test('only the typed fields that differ are carried over', () => {
    const base = draftFromRecord(record());
    const typed = { ...base, cashOnHand: '950', note: 'Late delivery' };
    expect(editedFields(typed, base)).toEqual({ cashOnHand: '950', note: 'Late delivery' });
    expect(editedFields(base, base)).toEqual({});
  });

  test('lines compare by content, not by their random ids', () => {
    const base = draftFromRecord(record());
    const reloaded = draftFromRecord(record());
    expect(linesEdited(reloaded, base)).toBe(false);
    const changed = {
      ...base,
      operatingExpenseItems: [{ ...base.operatingExpenseItems[0]!, reason: 'Gas and oil' }],
    };
    expect(linesEdited(changed, base)).toBe(true);
  });
});

describe('a newer version saved elsewhere (CONF-26)', () => {
  const at = (patch: Partial<Parameters<typeof newerVersionAction>[0]> = {}) =>
    newerVersionAction({
      listedVersion: 3,
      shownVersion: 2,
      listReadAfterRecord: true,
      unsavedChanges: false,
      ...patch,
    });

  test('loads it when nothing is typed, and stops at the banner when something is', () => {
    expect(at()).toBe('reload');
    expect(at({ unsavedChanges: true })).toBe('conflict');
  });

  test('a close made elsewhere for a day the form holds as new counts too', () => {
    expect(at({ listedVersion: 1, shownVersion: 0 })).toBe('reload');
    expect(at({ listedVersion: 1, shownVersion: 0, unsavedChanges: true })).toBe('conflict');
  });

  test('the same or an older version, an unlisted day or an older list change nothing', () => {
    expect(at({ listedVersion: 2 })).toBeNull();
    expect(at({ listedVersion: 1 })).toBeNull();
    expect(at({ listedVersion: undefined })).toBeNull();
    expect(at({ listReadAfterRecord: false, unsavedChanges: true })).toBeNull();
  });
});

describe('normalizedMoney', () => {
  test('reads an amount as the API stores it', () => {
    expect(normalizedMoney('5')).toBe('5.00');
    expect(normalizedMoney(' 5.5 ')).toBe('5.50');
    expect(normalizedMoney('-3')).toBe('-3.00');
  });

  test('leaves text that is not an amount as typed', () => {
    expect(normalizedMoney('abc')).toBe('abc');
  });
});

describe('sumItemAmounts', () => {
  test('adds in cents (D1)', () => {
    expect(sumItemAmounts([{ amount: '0.10' }, { amount: '0.20' }])).toEqual({
      value: '0.30',
      valid: true,
    });
    expect(sumItemAmounts([])).toEqual({ value: '0.00', valid: true });
  });

  test('a line that is empty, zero or not an amount makes the total invalid', () => {
    for (const amount of ['', '0', '-5', 'abc', '1.234']) {
      expect(sumItemAmounts([{ amount: '10' }, { amount }]).valid).toBe(false);
    }
  });

  test('a total past the largest amount is invalid', () => {
    const max = '999999999999.99';
    expect(sumItemAmounts([{ amount: max }]).valid).toBe(true);
    expect(sumItemAmounts([{ amount: max }, { amount: '0.01' }]).valid).toBe(false);
  });
});

describe('line checks', () => {
  test('an expense line needs a reason and an amount above zero', () => {
    expect(isValidOperatingExpense(expense())).toBe(true);
    expect(isValidOperatingExpense(expense({ reason: '  ' }))).toBe(false);
    expect(isValidOperatingExpense(expense({ amount: '0' }))).toBe(false);
    expect(isValidOperatingExpense(expense({ amount: '' }))).toBe(false);
  });

  test('a historical total is kept as it is', () => {
    expect(isValidOperatingExpense(expense({ isHistorical: true, reason: '' }))).toBe(true);
    expect(isValidWageItem(wage({ isHistorical: true, memberId: null }), true)).toBe(true);
  });

  test('a wage line names an employee only when that is required', () => {
    expect(isValidWageItem(wage({ memberId: null }), false)).toBe(true);
    expect(isValidWageItem(wage({ memberId: null }), true)).toBe(false);
    expect(isValidWageItem(wage({ reason: '' }), false)).toBe(false);
  });
});

describe('totals', () => {
  test('wages split into paid and unpaid; the close records the three sums', () => {
    const form = draft({
      operatingExpenseItems: [expense({ amount: '10' }), expense({ amount: '2.5' })],
      wageItems: [
        wage({ amount: '100' }),
        wage({ amount: '40', status: 'unpaid' }),
        wage({ amount: '60', status: 'paid' }),
      ],
    });
    const totals = detailTotals(form);
    expect(totals.expenses.value).toBe('12.50');
    expect(totals.paidWages.value).toBe('160.00');
    expect(totals.unpaidWages.value).toBe('40.00');
    const money = closeMoney(form, totals);
    expect(money.operatingExpenses).toBe('12.50');
    expect(money.wagesPaid).toBe('160.00');
    expect(money.wagesAccrued).toBe('40.00');
    expect(money.cashOnHand).toBe('0');
  });

  test('the summary adds in cents and shows nothing for an invalid input (DX-CLS-4)', () => {
    const form = draft({ onlineRevenue: '0.1', invoicedCashRevenue: '0.2' });
    const lines = settlementSummary(form, detailTotals(form));
    expect(lines.totalRevenue).toBe(0.3);
    const broken = draft({ onlineRevenue: '-1', cashOnHand: 'x' });
    const brokenLines = settlementSummary(broken, detailTotals(broken));
    expect(brokenLines.totalRevenue).toBeNull();
    expect(brokenLines.endingCash).toBeNull();
  });

  test('only the purchase adjustment may be negative in the summary', () => {
    const form = draft({ priorPurchaseAdjustment: '-20' });
    expect(settlementSummary(form, detailTotals(form)).priorPurchaseAdjustment).toBe(-20);
  });
});

describe('closeChanges', () => {
  test('a new close always counts as changed', () => {
    expect(
      closeChanges(emptyDraft(), closeMoney(emptyDraft(), detailTotals(emptyDraft())), null),
    ).toEqual({ expenses: false, wages: false, any: true });
  });

  test('a form loaded from the record has no changes', () => {
    const form = draftFromRecord(record());
    expect(closeChanges(form, closeMoney(form, detailTotals(form)), record())).toEqual({
      expenses: false,
      wages: false,
      any: false,
    });
  });

  test('amounts compare as the API stores them, notes without outer spaces', () => {
    const form = { ...draftFromRecord(record()), cashOnHand: '900.0', note: ' Quiet day ' };
    expect(closeChanges(form, closeMoney(form, detailTotals(form)), record()).any).toBe(false);
  });

  test('a changed line marks its section', () => {
    const base = draftFromRecord(record());
    const expenses = {
      ...base,
      operatingExpenseItems: [{ ...base.operatingExpenseItems[0]!, reason: 'Gas and oil' }],
    };
    expect(closeChanges(expenses, closeMoney(expenses, detailTotals(expenses)), record())).toEqual({
      expenses: true,
      wages: false,
      any: true,
    });
    const wages = { ...base, wageItems: [{ ...base.wageItems[0]!, status: 'unpaid' as const }] };
    expect(closeChanges(wages, closeMoney(wages, detailTotals(wages)), record())).toEqual({
      expenses: false,
      wages: true,
      any: true,
    });
  });
});

describe('what stops the save', () => {
  test('a bad line, or a total past the largest amount', () => {
    const ok = draft({ operatingExpenseItems: [expense()], wageItems: [wage()] });
    expect(detailsInvalid(ok, detailTotals(ok), true)).toBe(false);
    const badLine = draft({ wageItems: [wage({ memberId: null })] });
    expect(detailsInvalid(badLine, detailTotals(badLine), true)).toBe(true);
    expect(detailsInvalid(badLine, detailTotals(badLine), false)).toBe(false);
  });

  test('counts each field to fix once (A11Y-2)', () => {
    const form = draft({
      onlineRevenue: 'abc',
      cashOnHand: '-1',
      operatingExpenseItems: [expense({ reason: '' })],
      wageItems: [wage({ memberId: null })],
    });
    expect(countFieldsToFix(form, true, false)).toBe(5);
    expect(countFieldsToFix(form, false, true)).toBe(3);
  });

  test('the purchase adjustment is the one amount that may be negative', () => {
    expect(countFieldsToFix(draft({ priorPurchaseAdjustment: '-5' }), true, true)).toBe(0);
  });
});

describe('a new close', () => {
  test('has input once anything is typed', () => {
    expect(newCloseHasInput(emptyDraft())).toBe(false);
    expect(newCloseHasInput(draft({ onlineRevenue: '0.00' }))).toBe(false);
    expect(newCloseHasInput(draft({ cashOnHand: '5' }))).toBe(true);
    expect(newCloseHasInput(draft({ note: 'x' }))).toBe(true);
    expect(newCloseHasInput(draft({ wageItems: [wage()] }))).toBe(true);
  });

  test('with every amount 0 and no lines asks before it is saved (CLS-24)', () => {
    expect(isAllZeroClose(emptyDraft())).toBe(true);
    expect(isAllZeroClose(draft({ onlineRevenue: '0.00' }))).toBe(true);
    expect(isAllZeroClose(draft({ onlineRevenue: '1' }))).toBe(false);
    expect(isAllZeroClose(draft({ operatingExpenseItems: [expense()] }))).toBe(false);
  });
});

describe('settlementSaveInput', () => {
  const base = {
    storeId: 'store-1',
    date: '2026-11-10',
    needsCorrectionReason: false,
    expensesChanged: false,
    wagesChanged: false,
  };

  test('a new close sends its lines, trimmed, and expects version 0', () => {
    const form = draft({
      onlineRevenue: ' 100 ',
      note: '  ',
      operatingExpenseItems: [expense({ amount: ' 5 ', reason: ' Gas ' })],
      wageItems: [wage({ memberId: null, personName: ' Old name ' })],
    });
    const input = settlementSaveInput({
      ...base,
      draft: form,
      money: closeMoney(form, detailTotals(form)),
      existing: null,
    });
    expect(input.onlineRevenue).toBe('100');
    expect(input.note).toBeNull();
    expect(input.correctionReason).toBeNull();
    expect(input.expectedVersion).toBe(0);
    expect(input.operatingExpenses).toBe('5.00');
    expect(input.operatingExpenseItems).toEqual([{ amount: '5', reason: 'Gas' }]);
    expect(input.wageItems).toEqual([
      { personName: 'Old name', status: 'paid', amount: '200', reason: 'Shift' },
    ]);
  });

  test('a correction leaves out the sections that did not change', () => {
    const form = { ...draftFromRecord(record()), correctionReason: ' Typo ' };
    const input = settlementSaveInput({
      ...base,
      draft: form,
      money: closeMoney(form, detailTotals(form)),
      existing: record(),
      wagesChanged: true,
      needsCorrectionReason: true,
    });
    expect('operatingExpenseItems' in input).toBe(false);
    expect(input.wageItems).toEqual([
      { id: 'w-1', memberId: 'm-1', status: 'paid', amount: '200', reason: 'Shift' },
    ]);
    expect(input.correctionReason).toBe('Typo');
    expect(input.expectedVersion).toBe(2);
  });
});
