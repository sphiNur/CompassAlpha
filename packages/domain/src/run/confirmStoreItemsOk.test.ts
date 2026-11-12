/**
 * The receiver's "all arrived" at one store (run.markStoreItemsOk). The
 * router looped over ConfirmStoreItem itself until review RUNAPI-13; the
 * domain decides it now, with the same events.
 */
import { describe, expect, test } from 'bun:test';
import { decideRun, emptyRunState, type RunCommand, type RunState } from './index';
import {
  RUN_CLOCK as clock,
  confirmStoreAllOk,
  confirmStoreItem,
  confirmer,
  deliver,
  planRun,
  purchaseItem,
  purchaser,
  runActor,
  runStepper,
} from '../testing';

const { step, steps } = runStepper(clock);

/** sku-1 bought for store A, sku-2 for A and B, sku-3 for B. */
function bought(): RunState {
  return steps(emptyRunState('run-ok'), [
    planRun({
      plannedItems: [
        { skuId: 'sku-1', qty: '2' },
        { skuId: 'sku-2', qty: '2' },
        { skuId: 'sku-3', qty: '1' },
      ],
    }),
    { type: 'StartPurchase', actor: purchaser() },
    purchaseItem({ skuId: 'sku-1', unitPrice: '10', actualQty: '2' }),
    purchaseItem({
      skuId: 'sku-2',
      unitPrice: '10',
      actualQty: '2',
      storeSplits: [
        { storeId: 'A', qty: '1' },
        { storeId: 'B', qty: '1' },
      ],
    }),
    purchaseItem({
      skuId: 'sku-3',
      unitPrice: '10',
      actualQty: '1',
      storeSplits: [{ storeId: 'B', qty: '1' }],
    }),
  ]).state;
}

/** Out for delivery; only store A has its goods. */
const deliveredToA = () => deliver(bought(), ['A']);

const allOk = (skuIds: string[], storeId = 'A', actor = confirmer()): RunCommand => ({
  type: 'ConfirmStoreItemsOk',
  storeId,
  skuIds,
  actor,
});

/** The payload of a product confirmed OK at store A. */
const ok = (skuId: string) => ({
  storeId: 'A',
  skuId,
  status: 'ok' as const,
  note: null,
  photoUrl: null,
});

describe('ConfirmStoreItemsOk', () => {
  test('confirms each listed product the store has not checked, one event each', () => {
    const s = deliveredToA();
    const events = decideRun(s, allOk(['sku-1', 'sku-2', 'sku-1']), clock);
    expect(events.map((e) => [e.type, e.seq, e.payload])).toEqual([
      ['StoreItemConfirmed', s.seq + 1, ok('sku-1')],
      ['StoreItemConfirmed', s.seq + 2, ok('sku-2')],
    ]);
    // The event ConfirmStoreItem 'ok' writes for the product on its own.
    expect(events[0]).toEqual(decideRun(s, confirmStoreItem({ skuId: 'sku-1' }), clock)[0]!);
  });

  test('leaves a product the store has checked already as it is', () => {
    const s = step(
      deliveredToA(),
      confirmStoreItem({ skuId: 'sku-1', status: 'short', note: 'a bag torn', receivedQty: '1' }),
    );
    const after = steps(s, [allOk(['sku-1', 'sku-2'])]);
    expect(after.events.map((e) => e.payload)).toEqual([ok('sku-2')]);
    expect(after.state.stores.get('A')?.itemConfirms.get('sku-1')?.status).toBe('short');
  });

  test('with nothing left to check it writes nothing, and still checks the actor', () => {
    const s = steps(deliveredToA(), [allOk(['sku-1', 'sku-2'])]).state;
    expect(decideRun(s, allOk(['sku-1', 'sku-2']), clock)).toEqual([]);
    // The router's loop answered success here without asking.
    expect(() => decideRun(s, allOk(['sku-1'], 'A', runActor('x', [])), clock)).toThrow(
      'run.errors.cannotConfirm',
    );
  });

  test('a product not bought for the store refuses the whole request', () => {
    const s = deliveredToA();
    for (const other of ['sku-3', 'sku-unknown']) {
      expect(() => decideRun(s, allOk(['sku-1', other]), clock)).toThrow('run.errors.itemNotInRun');
    }
  });

  test('only while the store holds its goods and has not signed for them', () => {
    expect(() => decideRun(bought(), allOk(['sku-1']), clock)).toThrow('run.errors.notDelivering');
    expect(() => decideRun(deliveredToA(), allOk(['sku-3'], 'B'), clock)).toThrow(
      'run.errors.storeNotDelivered',
    );
    expect(() =>
      decideRun(confirmStoreAllOk(deliveredToA(), 'A'), allOk(['sku-1']), clock),
    ).toThrow('run.errors.storeAlreadyConfirmed');
  });
});
