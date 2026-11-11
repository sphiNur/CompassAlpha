import { describe, expect, test } from 'bun:test';
import { runDetailMoney, type RunMoneyLine } from '../runMoney';

const line = (over: Partial<RunMoneyLine>): RunMoneyLine => ({
  storeId: 'store-a',
  kind: 'item',
  skuId: 'sku-1',
  expenseId: null,
  amount: '0',
  paymentMethod: 'cash',
  ...over,
});

describe('runDetailMoney (review RUNWEB2-03)', () => {
  const lines = [
    line({ skuId: 'sku-1', amount: '10.05' }),
    line({ skuId: 'sku-1', storeId: 'store-b', amount: '20.10', paymentMethod: 'transfer' }),
    line({ skuId: 'sku-2', storeId: 'store-b', amount: '0.10' }),
    line({ kind: 'expense', skuId: null, expenseId: 'taxi', amount: '5' }),
    line({
      kind: 'expense',
      skuId: null,
      expenseId: 'taxi',
      storeId: 'store-b',
      amount: '10',
      paymentMethod: 'transfer',
    }),
  ];

  test('the run: items / expenses / total and cash / transfer, in exact cents', () => {
    expect(runDetailMoney(lines)).toMatchObject({
      total: '45.25',
      itemsTotal: '30.25',
      expensesTotal: '15.00',
      cash: '15.15',
      transfer: '30.10',
    });
  });

  test('each store, largest first, with its products and expenses counted', () => {
    expect(runDetailMoney(lines).byStore).toEqual([
      {
        storeId: 'store-b',
        total: '30.20',
        itemsTotal: '20.20',
        expensesTotal: '10.00',
        cash: '0.10',
        transfer: '30.10',
        itemCount: 2,
        expenseCount: 1,
      },
      {
        storeId: 'store-a',
        total: '15.05',
        itemsTotal: '10.05',
        expensesTotal: '5.00',
        cash: '15.05',
        transfer: '0.00',
        itemCount: 1,
        expenseCount: 1,
      },
    ]);
  });

  test('per product, per split and per expense', () => {
    const money = runDetailMoney(lines);
    expect(money.bySku.get('sku-1')).toMatchObject({
      total: '30.15',
      cash: '10.05',
      transfer: '20.10',
    });
    expect(money.bySplit.get('sku-1|store-b')?.total).toBe('20.10');
    expect(money.bySplit.get('sku-2|store-b')?.total).toBe('0.10');
    expect(money.byExpense.get('taxi')?.total).toBe('15.00');
    expect(money.bySku.has('sku-3')).toBe(false);
  });

  test('a line paid neither way counts in the total only, as run.history counts it', () => {
    const money = runDetailMoney([line({ amount: '7', paymentMethod: null })]);
    expect(money).toMatchObject({ total: '7.00', cash: '0.00', transfer: '0.00' });
  });

  test('no lines: zeros and no stores', () => {
    expect(runDetailMoney([])).toMatchObject({
      total: '0.00',
      cash: '0.00',
      transfer: '0.00',
      byStore: [],
    });
  });
});
