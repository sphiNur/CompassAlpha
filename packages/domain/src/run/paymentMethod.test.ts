import { describe, expect, test } from 'bun:test';
import { applyRun, decideRun, emptyRunState } from './index';
import {
  RUN_CLOCK as clock,
  RUN_NOW as NOW,
  confirmStoreAllOk,
  confirmStoreItem,
  deliver,
  planAndPurchase,
  planRun,
  purchaseItem,
  purchaser,
  revisePurchase,
  runStepper,
} from '../testing';

const { step } = runStepper(clock);

// ----------------------------------------------------------------------
// M1.14 (2026-05-08): payment-method mixing on a single run.
// Real-world driver: same market trip pays Apple in cash at the stall
// and wires Beef to the meat supplier. RunFinished must split the
// totals so the chain owner can reconcile petty cash vs bank wires.
// ----------------------------------------------------------------------
describe('run.paymentMethod', () => {
  function planTwoSkus(): import('./state').RunState {
    let s = emptyRunState('run-1');
    s = step(
      s,
      planRun({
        plannedItems: [
          { skuId: 'apple', qty: '3' },
          { skuId: 'beef', qty: '2' },
        ],
      }),
    );
    s = step(s, { type: 'StartPurchase', actor: purchaser() });
    return s;
  }

  test('PurchaseItem records paymentMethod on the event payload', () => {
    let s = planTwoSkus();
    const evs = decideRun(
      s,
      purchaseItem({ skuId: 'apple', unitPrice: '1000', actualQty: '3' }),
      clock,
    );
    const purchased = evs.find((e) => e.type === 'ItemPurchased');
    expect(
      purchased && 'payload' in purchased
        ? (purchased.payload as { paymentMethod: string }).paymentMethod
        : null,
    ).toBe('cash');
    s = evs.reduce(applyRun, s);
    expect(s.items.get('apple')!.paymentMethod).toBe('cash');
  });

  test('FinishRun aggregates cash + transfer totals separately', () => {
    let s = planTwoSkus();
    s = step(s, purchaseItem({ skuId: 'apple', unitPrice: '1000', actualQty: '3' }));
    s = step(
      s,
      purchaseItem({
        skuId: 'beef',
        unitPrice: '50000',
        actualQty: '2',
        paymentMethod: 'transfer',
      }),
    );
    s = deliver(s);
    s = step(s, confirmStoreItem({ skuId: 'apple' }));
    s = step(s, confirmStoreItem({ skuId: 'beef' }));
    s = confirmStoreAllOk(s, 'A');
    const finishEvs = decideRun(s, { type: 'FinishRun', actor: purchaser() }, clock);
    expect(finishEvs).toHaveLength(1);
    const ev = finishEvs[0]!;
    expect(ev.type).toBe('RunFinished');
    if (ev.type !== 'RunFinished') throw new Error('unreachable');
    // 3 × 1000 cash + 2 × 50000 transfer = 3000 + 100000 = 103000
    expect(ev.payload.totalActual).toBe('103000.00');
    expect(ev.payload.totalCash).toBe('3000.00');
    expect(ev.payload.totalTransfer).toBe('100000.00');
  });

  test('FinishRun aggregates per-store price and payment overrides', () => {
    let s = planAndPurchase({
      plannedQty: '3',
      purchasedQty: '3',
      storeSplits: [
        { storeId: 'A', qty: '1', unitPrice: '1000', paymentMethod: 'cash' },
        { storeId: 'B', qty: '2', unitPrice: '1200', paymentMethod: 'transfer' },
      ],
    });
    s = deliver(s, ['A', 'B']);
    s = confirmStoreAllOk(s, 'A');
    s = confirmStoreAllOk(s, 'B');
    const finishEvs = decideRun(s, { type: 'FinishRun', actor: purchaser() }, clock);
    const ev = finishEvs[0]!;
    expect(ev.type).toBe('RunFinished');
    if (ev.type !== 'RunFinished') throw new Error('unreachable');
    expect(ev.payload.totalActual).toBe('3400.00');
    expect(ev.payload.totalCash).toBe('1000.00');
    expect(ev.payload.totalTransfer).toBe('2400.00');
  });

  test('legacy ItemPurchased event without paymentMethod applies as cash', () => {
    // Simulates an event written before M1.14 — the field is just absent.
    let s = emptyRunState('run-1');
    s = applyRun(s, {
      streamId: 'run-1',
      seq: 1,
      occurredAt: NOW,
      actorUserId: 'u',
      actorMemberId: 'm',
      type: 'RunPlanned',
      payload: {
        orgId: 'o',
        runDate: '2026-05-01',
        runIndex: 0,
        sessionIds: ['s'],
        plannedItems: [{ skuId: 'apple', qty: '3' }],
        purchaserMemberId: 'm',
      },
    });
    s = applyRun(s, {
      streamId: 'run-1',
      seq: 2,
      occurredAt: NOW,
      actorUserId: 'u',
      actorMemberId: 'm',
      type: 'PurchaseStarted',
      payload: {},
    });
    s = applyRun(s, {
      streamId: 'run-1',
      seq: 3,
      occurredAt: NOW,
      actorUserId: 'u',
      actorMemberId: 'm',
      type: 'ItemPurchased',
      payload: {
        skuId: 'apple',
        supplierId: null,
        unitPrice: '1000',
        actualQty: '3',
        receiptPhotoUrl: null,
        storeSplits: [{ storeId: 'A', qty: '3' }],
        // paymentMethod intentionally omitted (legacy event)
      },
    });
    expect(s.items.get('apple')!.paymentMethod).toBe('cash');
  });

  test('RevisePurchase can flip cash → transfer (and vice versa)', () => {
    let s = planTwoSkus();
    s = step(s, purchaseItem({ skuId: 'apple', unitPrice: '1000', actualQty: '3' }));
    s = step(
      s,
      revisePurchase({
        skuId: 'apple',
        unitPrice: '1000',
        actualQty: '3',
        reason: 'paid by wire after all',
        paymentMethod: 'transfer',
      }),
    );
    expect(s.items.get('apple')!.paymentMethod).toBe('transfer');
  });

  test('PurchaseUndone clears paymentMethod so re-purchase records a fresh choice', () => {
    let s = planTwoSkus();
    s = step(
      s,
      purchaseItem({
        skuId: 'apple',
        unitPrice: '1000',
        actualQty: '3',
        paymentMethod: 'transfer',
      }),
    );
    s = step(s, {
      type: 'UndoPurchase',
      skuId: 'apple',
      reason: 'mistapped row',
      actor: purchaser(),
    });
    expect(s.items.get('apple')!.paymentMethod).toBeNull();
    expect(s.items.get('apple')!.status).toBe('pending');
  });
});
