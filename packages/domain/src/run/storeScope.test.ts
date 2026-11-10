import { describe, expect, test } from 'bun:test';
import { applyRun, decideRun, emptyRunState } from './index';
import type { RunCommand } from './commands';
import { RUN_CLOCK as clock, confirmStoreAllOk, confirmStoreItem, deliver, planAndPurchase, planRun, purchaseItem, purchaser, revisePurchase, runStepper } from '../testing';

const { step } = runStepper(clock);

// 2026-10-21 audit CA-29 / CA-30: store-scope and receipt-phase guards.
describe('run.storeScope', () => {
  const planOnly = () => {
    let s = emptyRunState('run-scope');
    s = step(s, planRun({ plannedItems: [{ skuId: 'sku-1', qty: '4' }] }));
    return s;
  };
  const buy = (storeId: string, runStoreIds?: string[]): RunCommand =>
    purchaseItem({
      skuId: 'sku-1',
      unitPrice: '1000',
      actualQty: '4',
      storeSplits: [{ storeId, qty: '4' }],
      ...(runStoreIds ? { runStoreIds } : {}),
    });
  const deliveredTo = (storeId = 'A') => {
    let s = planAndPurchase();
    s = step(s, { type: 'StartDelivery', actor: purchaser() });
    s = step(s, { type: 'DeliverToStore', storeId, actor: purchaser() });
    return s;
  };
  const confirmItem = (storeId: string, skuId = 'sku-1'): RunCommand =>
    confirmStoreItem({ storeId, skuId });

  test('PurchaseItem rejects a split to a store outside runStoreIds', () => {
    expect(() => decideRun(planOnly(), buy('Z', ['A', 'B']), clock)).toThrow(
      'run.errors.storeNotInRun',
    );
    expect(decideRun(planOnly(), buy('B', ['A', 'B']), clock).map((e) => e.type)).toEqual([
      'PurchaseStarted',
      'ItemPurchased',
    ]);
  });

  test('RevisePurchase rejects moving a split to a store outside runStoreIds', () => {
    const s = planAndPurchase();
    const revise = (storeId: string): RunCommand =>
      revisePurchase({
        skuId: 'sku-1',
        unitPrice: '1000',
        actualQty: '4',
        storeSplits: [{ storeId, qty: '4' }],
        reason: 'fix',
        runStoreIds: ['A'],
      });
    expect(() => decideRun(s, revise('Z'), clock)).toThrow('run.errors.storeNotInRun');
    expect(decideRun(s, revise('A'), clock)).toHaveLength(1);
  });

  test('AddPurchaserItem uses runStoreIds even before anything is bought', () => {
    const add = (storeId: string): RunCommand => ({
      type: 'AddPurchaserItem',
      skuId: 'sku-extra',
      supplierId: null,
      unitPrice: '1000',
      actualQty: '1',
      receiptPhotoUrl: null,
      storeSplits: [{ storeId, qty: '1' }],
      paymentMethod: 'cash',
      reason: 'chef asked',
      runStoreIds: ['A'],
      actor: purchaser(),
    });
    expect(() => decideRun(planOnly(), add('Z'), clock)).toThrow('run.errors.storeNotInRun');
    expect(decideRun(planOnly(), add('A'), clock).length).toBeGreaterThan(0);
  });

  test('BUY-11: re-adding a removed expense id is a no-op, in the command and the reducer', () => {
    const addExpense: RunCommand = {
      type: 'AddRunExpense',
      expenseId: 'exp-1',
      label: 'porter',
      qty: '1',
      unitPrice: '20000',
      storeSplits: [{ storeId: 'A', qty: '1' }],
      paymentMethod: 'cash',
      receiptPhotoUrl: null,
      reason: 'porter for the heavy sacks',
      runStoreIds: ['A'],
      actor: purchaser(),
    };
    let s = planAndPurchase();
    const added = decideRun(s, addExpense, clock);
    s = added.reduce(applyRun, s);
    s = step(s, {
      type: 'RemoveRunExpense',
      expenseId: 'exp-1',
      reason: 'typo',
      actor: purchaser(),
    });
    expect(decideRun(s, addExpense, clock)).toEqual([]);
    // An Added event already in a log (written before this fix) no
    // longer counts the expense back either.
    s = added.map((e) => ({ ...e, seq: s.seq + 1 })).reduce(applyRun, s);
    expect(s.expenses).toHaveLength(0);
  });

  test('BUY-4: undoing a purchaser-added row removes it, so delivery can start and it can be re-added', () => {
    const add: RunCommand = {
      type: 'AddPurchaserItem',
      skuId: 'sku-extra',
      supplierId: null,
      unitPrice: '1000',
      actualQty: '1',
      receiptPhotoUrl: null,
      storeSplits: [{ storeId: 'A', qty: '1' }],
      paymentMethod: 'cash',
      reason: 'chef asked',
      runStoreIds: ['A'],
      actor: purchaser(),
    };
    let s = planAndPurchase();
    s = step(s, add);
    s = step(s, { type: 'UndoPurchase', skuId: 'sku-extra', reason: '', actor: purchaser() });
    expect(s.items.has('sku-extra')).toBe(false);
    expect(decideRun(s, { type: 'StartDelivery', actor: purchaser() }, clock)).toHaveLength(1);
    expect(decideRun(s, add, clock).map((e) => e.type)).toEqual(['PurchaserItemAdded']);
  });

  test('DeliverToStore rejects a store that neither holds goods nor belongs to the run', () => {
    let s = planAndPurchase();
    s = step(s, { type: 'StartDelivery', actor: purchaser() });
    expect(() =>
      decideRun(
        s,
        { type: 'DeliverToStore', storeId: 'Z', runStoreIds: ['A', 'B'], actor: purchaser() },
        clock,
      ),
    ).toThrow('run.errors.storeNotInRun');
    // A run store without goods, and a store holding a split, both pass.
    expect(
      decideRun(
        s,
        { type: 'DeliverToStore', storeId: 'B', runStoreIds: ['A', 'B'], actor: purchaser() },
        clock,
      ),
    ).toHaveLength(1);
    expect(
      decideRun(s, { type: 'DeliverToStore', storeId: 'A', actor: purchaser() }, clock),
    ).toHaveLength(1);
  });

  test('ConfirmStoreItem requires the store to have been delivered', () => {
    let s = planAndPurchase();
    s = step(s, { type: 'StartDelivery', actor: purchaser() });
    expect(() => decideRun(s, confirmItem('A'), clock)).toThrow('run.errors.storeNotDelivered');
  });

  test('ConfirmStoreItem is refused once the store has confirmed', () => {
    let s = deliveredTo('A');
    s = confirmStoreAllOk(s, 'A');
    expect(() =>
      decideRun(s, { ...confirmItem('A'), status: 'short', note: 'late' } as RunCommand, clock),
    ).toThrow('run.errors.storeAlreadyConfirmed');
  });

  test('ConfirmStoreItem rejects a SKU that was not split to that store', () => {
    let s = planAndPurchase({
      storeSplits: [
        { storeId: 'A', qty: '2' },
        { storeId: 'B', qty: '2' },
      ],
    });
    s = deliver(s);
    expect(() => decideRun(s, confirmItem('A', 'sku-unknown'), clock)).toThrow(
      'run.errors.itemNotInRun',
    );
    expect(decideRun(s, confirmItem('A'), clock)).toHaveLength(1);
  });
});
