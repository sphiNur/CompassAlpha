/**
 * D3 / D4 (2026-10-31): runCorrections — quantity a correction added beyond
 * what a store confirmed, and price changes after receipt. Pure.
 */
import { describe, expect, test } from 'bun:test';
import { applyRun, decideRun, emptyRunState, type RunCommand, type RunEvent } from '@compass/domain/run';
import { runCorrections } from '../runCorrections';

const PERMS = new Set(['run.purchase', 'run.finish', 'delivery.dispatch', 'delivery.confirm', 'run.amend']);
const actor = { userId: 'u1', memberId: 'm1', permissions: PERMS };

function stream(build: (run: (cmd: RunCommand) => void) => void): RunEvent[] {
  const events: RunEvent[] = [
    {
      streamId: 'run-1',
      seq: 1,
      occurredAt: new Date('2026-10-31T06:00:00Z'),
      actorUserId: 'u1',
      actorMemberId: 'm1',
      type: 'RunPlanned',
      payload: {
        orgId: 'org',
        runDate: '2026-10-31',
        runIndex: 0,
        sessionIds: [],
        plannedItems: [{ skuId: 'rice', qty: '2' }],
        purchaserMemberId: 'm1',
      },
    } as RunEvent,
  ];
  let state = applyRun(emptyRunState('run-1'), events[0]!);
  build((cmd) => {
    for (const e of decideRun(state, cmd)) {
      state = applyRun(state, e);
      events.push(e);
    }
  });
  return events;
}

const buy = (skuId: string, qty: string, price: string): RunCommand => ({
  type: 'PurchaseItem',
  skuId,
  supplierId: null,
  unitPrice: price,
  actualQty: qty,
  receiptPhotoUrl: null,
  storeSplits: [{ storeId: 'A', qty }],
  paymentMethod: 'cash',
  actor,
});
const revise = (price: string): RunCommand => ({
  type: 'RevisePurchase',
  skuId: 'rice',
  supplierId: null,
  unitPrice: price,
  actualQty: '2',
  receiptPhotoUrl: null,
  storeSplits: [{ storeId: 'A', qty: '2' }],
  paymentMethod: 'cash',
  reason: 'receipt',
  actor,
});

function delivered(run: (cmd: RunCommand) => void) {
  run({ type: 'StartPurchase', actor });
  run(buy('rice', '2', '1000'));
  run({ type: 'StartDelivery', actor });
  run({ type: 'DeliverToStore', storeId: 'A', actor });
}

describe('runCorrections', () => {
  test('a price revised before receipt is not a correction', () => {
    const events = stream((run) => {
      run({ type: 'StartPurchase', actor });
      run(buy('rice', '2', '1000'));
      run(revise('1200'));
    });
    expect(runCorrections(events, null)).toEqual([]);
  });

  test('a price revised after the store confirmed is kept, for the visible store', () => {
    const events = stream((run) => {
      delivered(run);
      run({
        type: 'ConfirmStoreItem',
        storeId: 'A',
        skuId: 'rice',
        status: 'ok',
        note: null,
        photoUrl: null,
        actor,
      } as RunCommand);
      run({ type: 'ConfirmStore', storeId: 'A', actor } as RunCommand);
      run(revise('1500'));
    });
    expect(runCorrections(events, null)).toMatchObject([
      { kind: 'priceAfterReceipt', skuId: 'rice', storeId: null, from: '1000', to: '1500' },
    ]);
    expect(runCorrections(events, new Set(['A']))).toMatchObject([
      { kind: 'priceAfterReceipt', skuId: 'rice', storeId: 'A', from: '1000', to: '1500' },
    ]);
    expect(runCorrections(events, new Set(['B']))).toEqual([]);
  });
});
