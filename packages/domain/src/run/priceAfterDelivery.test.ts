import { describe, expect, test } from 'bun:test';
import { decideRun, emptyRunState } from './index';
import type { RunCommand } from './commands';
import { RUN_CLOCK as clock, deliver, planAndPurchase, planRun, purchaseItem, purchaser, revisePurchase, runStepper } from '../testing';

const { step } = runStepper(clock);

describe('run.priceAfterDelivery (2026-10-30)', () => {
  const deliveredRun = () => {
    let s = planAndPurchase();
    return deliver(s);
  };
  const revise = (unitPrice: string, actualQty: string): RunCommand =>
    revisePurchase({
      skuId: 'sku-1',
      supplierId: 'sup-1',
      unitPrice,
      actualQty,
      reason: 'real price',
      paymentMethod: 'transfer',
    });

  test('price and payment method may change after the goods went out', () => {
    const s = deliveredRun();
    const out = step(s, revise('15000', '4'));
    expect(out.items.get('sku-1')?.unitPrice).toBe('15000');
  });

  test('quantities may not', () => {
    expect(() => decideRun(deliveredRun(), revise('15000', '5'), clock)).toThrow(
      'run.errors.cannotReviseAfterDelivery',
    );
  });

  // Review RUNAPI-01 (2026-11-09): a line bound only for store B may not
  // be moved onto store A once A has its goods.
  test('a line may not be moved onto a store that already has its goods', () => {
    let s = emptyRunState('run-2');
    const buy = (skuId: string, storeId: string, qty: string): RunCommand =>
      purchaseItem({ skuId, unitPrice: '10', actualQty: qty, storeSplits: [{ storeId, qty }] });
    const cmds: RunCommand[] = [
      planRun({
        sessionIds: ['s1', 's2'],
        plannedItems: [
          { skuId: 'x', qty: '2' },
          { skuId: 'y', qty: '1' },
        ],
      }),
      { type: 'StartPurchase', actor: purchaser() },
      buy('x', 'A', '2'),
      buy('y', 'B', '1'),
      { type: 'StartDelivery', actor: purchaser() },
      { type: 'DeliverToStore', storeId: 'A', actor: purchaser() },
    ];
    for (const cmd of cmds) s = step(s, cmd);
    const moveOntoA: RunCommand = revisePurchase({
      skuId: 'y',
      unitPrice: '10',
      actualQty: '2',
      storeSplits: [
        { storeId: 'B', qty: '1' },
        { storeId: 'A', qty: '1' },
      ],
      reason: 'A wants one',
    });
    expect(() => decideRun(s, moveOntoA, clock)).toThrow('run.errors.cannotReviseAfterDelivery');
    // The line's own store, not yet delivered, may still change.
    const growB: RunCommand = { ...moveOntoA, storeSplits: [{ storeId: 'B', qty: '2' }] };
    expect(decideRun(s, growB, clock)).toHaveLength(1);
  });
});
