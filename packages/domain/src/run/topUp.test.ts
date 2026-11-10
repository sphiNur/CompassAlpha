import { describe, expect, test } from 'bun:test';
import { applyRun, decideRun, emptyRunState } from './index';
import type { RunCommand } from './commands';
import {
  RUN_CLOCK as clock,
  planAndPurchase,
  planRun,
  purchaser,
  revisePurchase,
  runStepper,
} from '../testing';

const { step } = runStepper(clock);

// 2026-10-30 owner decisions: BUY-5 top-ups and prices filled in after delivery.
describe('run.topUp (BUY-5)', () => {
  const attach = (qty: string): RunCommand => ({
    type: 'AttachSessions',
    sessionIds: ['sess-late'],
    addedPlannedItems: [{ skuId: 'sku-1', qty }],
    actor: purchaser(),
  });
  const revise = (actualQty: string, splits: Array<{ storeId: string; qty: string }>): RunCommand =>
    revisePurchase({
      skuId: 'sku-1',
      supplierId: 'sup-1',
      unitPrice: '12000',
      actualQty,
      storeSplits: splits,
      reason: 'top-up',
    });

  test('demand joining a bought item is "still need X" and holds delivery', () => {
    let s = planAndPurchase();
    s = step(s, attach('5'));
    expect(s.items.get('sku-1')?.topUpQty).toBe('5');
    expect(s.items.get('sku-1')?.status).toBe('purchased');
    expect(() => decideRun(s, { type: 'StartDelivery', actor: purchaser() }, clock)).toThrow(
      'run.errors.topUpPending',
    );
  });

  test('buying the difference clears it; so does saying it will not be bought', () => {
    let s = planAndPurchase();
    s = step(s, attach('5'));
    const bought = step(
      s,
      revise('9', [
        { storeId: 'A', qty: '4' },
        { storeId: 'B', qty: '5' },
      ]),
    );
    expect(bought.items.get('sku-1')?.topUpQty).toBeNull();
    expect(decideRun(bought, { type: 'StartDelivery', actor: purchaser() }, clock)).toHaveLength(1);

    const dismissed = decideRun(
      s,
      { type: 'DismissTopUp', skuId: 'sku-1', note: 'enough', actor: purchaser() },
      clock,
    );
    expect(dismissed.map((e) => e.type)).toEqual(['TopUpDismissed']);
    const after = dismissed.reduce(applyRun, s);
    expect(after.items.get('sku-1')?.topUpQty).toBeNull();
    expect(
      decideRun(after, { type: 'DismissTopUp', skuId: 'sku-1', actor: purchaser() }, clock),
    ).toEqual([]);
  });

  test('RE-BUY-2: a price-only or partial revision leaves the rest of the top-up', () => {
    let s = planAndPurchase();
    s = step(s, attach('5'));
    const priceOnly = step(s, revise('4', [{ storeId: 'A', qty: '4' }]));
    expect(priceOnly.items.get('sku-1')?.topUpQty).toBe('5');
    const partial = step(
      s,
      revise('6', [
        { storeId: 'A', qty: '4' },
        { storeId: 'B', qty: '2' },
      ]),
    );
    expect(partial.items.get('sku-1')?.topUpQty).toBe('3');
    expect(() => decideRun(partial, { type: 'StartDelivery', actor: purchaser() }, clock)).toThrow(
      'run.errors.topUpPending',
    );
  });

  test('RE-BUY-3: an order joining a purchaser-added item makes it a demand row that survives an undo', () => {
    let s = planAndPurchase();
    s = step(s, {
      type: 'AddPurchaserItem',
      skuId: 'sku-extra',
      supplierId: null,
      unitPrice: '1000',
      actualQty: '2',
      receiptPhotoUrl: null,
      storeSplits: [{ storeId: 'A', qty: '2' }],
      paymentMethod: 'cash',
      reason: 'chef asked',
      runStoreIds: ['A'],
      actor: purchaser(),
    });
    s = step(s, {
      type: 'AttachSessions',
      sessionIds: ['sess-late'],
      addedPlannedItems: [{ skuId: 'sku-extra', qty: '3' }],
      actor: purchaser(),
    });
    const joined = s.items.get('sku-extra')!;
    expect(joined.addedByPurchaser).toBe(false);
    expect(joined.plannedQty).toBe('3');
    s = step(s, {
      type: 'UndoPurchase',
      skuId: 'sku-extra',
      reason: 'wrong price',
      actor: purchaser(),
    });
    const undone = s.items.get('sku-extra');
    expect(undone?.status).toBe('pending');
    expect(undone?.plannedQty).toBe('3');
    expect(() => decideRun(s, { type: 'StartDelivery', actor: purchaser() }, clock)).toThrow(
      'run.errors.itemsPending',
    );
  });

  test('a pending item just grows, with no top-up', () => {
    let s = emptyRunState('run-p');
    s = step(s, planRun({ plannedItems: [{ skuId: 'sku-1', qty: '4' }] }));
    s = step(s, attach('5'));
    expect(s.items.get('sku-1')?.plannedQty).toBe('9');
    expect(s.items.get('sku-1')?.topUpQty ?? null).toBeNull();
  });
});
