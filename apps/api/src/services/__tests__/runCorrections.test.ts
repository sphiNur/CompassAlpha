/**
 * D3 / D4 (2026-10-31): runCorrections — quantity a correction added beyond
 * what a store confirmed, and price changes after receipt. Pure.
 */
import { describe, expect, test } from 'bun:test';
import { emptyRunState, type RunCommand, type RunEvent } from '@compass/domain/run';
import {
  confirmStoreItem,
  planRun,
  purchaseItem,
  purchaser,
  revisePurchase,
  runStepper,
} from '@compass/domain/testing';
import { runCorrections } from '../runCorrections';

const actor = purchaser([
  'run.create',
  'run.purchase',
  'run.finish',
  'delivery.dispatch',
  'delivery.confirm',
  'run.amend',
]);

/** The events of run-1, planned for 2 kg of rice, then of `commands`. */
function stream(commands: RunCommand[]): RunEvent[] {
  return runStepper().steps(emptyRunState('run-1'), [
    planRun({ plannedItems: [{ skuId: 'rice', qty: '2' }], actor }),
    ...commands,
  ]).events;
}

const buy = (skuId: string, qty: string, price: string) =>
  purchaseItem({ skuId, unitPrice: price, actualQty: qty, actor });
const revise = (price: string) =>
  revisePurchase({ skuId: 'rice', unitPrice: price, actualQty: '2', reason: 'receipt', actor });

/** Rice bought (2 kg at 1000) and delivered to store A. */
const delivered: RunCommand[] = [
  { type: 'StartPurchase', actor },
  buy('rice', '2', '1000'),
  { type: 'StartDelivery', actor },
  { type: 'DeliverToStore', storeId: 'A', actor },
];

describe('runCorrections', () => {
  test('a price revised before receipt is not a correction', () => {
    const events = stream([
      { type: 'StartPurchase', actor },
      buy('rice', '2', '1000'),
      revise('1200'),
    ]);
    expect(runCorrections(events, null)).toEqual([]);
  });

  test('a price revised after the store confirmed is kept, for the visible store', () => {
    const events = stream([
      ...delivered,
      confirmStoreItem({ skuId: 'rice', actor }),
      { type: 'ConfirmStore', storeId: 'A', actor },
      revise('1500'),
    ]);
    expect(runCorrections(events, null)).toMatchObject([
      { kind: 'priceAfterReceipt', skuId: 'rice', storeId: null, from: '1000', to: '1500' },
    ]);
    expect(runCorrections(events, new Set(['A']))).toMatchObject([
      { kind: 'priceAfterReceipt', skuId: 'rice', storeId: 'A', from: '1000', to: '1500' },
    ]);
    expect(runCorrections(events, new Set(['B']))).toEqual([]);
  });

  /** Rice bought at 1000 with store A paying its own price, then delivered. */
  const deliveredOwn = (ownA: string): RunCommand[] => [
    { type: 'StartPurchase', actor },
    purchaseItem({
      skuId: 'rice',
      unitPrice: '1000',
      actualQty: '2',
      storeSplits: [{ storeId: 'A', qty: '2', unitPrice: ownA }],
      actor,
    }),
    { type: 'StartDelivery', actor },
    { type: 'DeliverToStore', storeId: 'A', actor },
    confirmStoreItem({ skuId: 'rice', actor }),
    { type: 'ConfirmStore', storeId: 'A', actor },
  ];
  const reviseOwn = (price: string, ownA: string) =>
    revisePurchase({
      skuId: 'rice',
      unitPrice: price,
      actualQty: '2',
      reason: 'receipt',
      storeSplits: [{ storeId: 'A', qty: '2', unitPrice: ownA }],
      actor,
    });

  test('RUNAPI-26: an item price no receiving store pays is no correction', () => {
    const events = stream([...deliveredOwn('1200'), reviseOwn('1500', '1200')]);
    expect(runCorrections(events, null)).toEqual([]);
    expect(runCorrections(events, new Set(['A']))).toEqual([]);
  });

  test("RUNAPI-26: a change to one store's own price is that store's line, with its prices", () => {
    const events = stream([...deliveredOwn('1200'), reviseOwn('1000', '1300')]);
    const line = {
      kind: 'priceAfterReceipt',
      skuId: 'rice',
      storeId: 'A',
      from: '1200',
      to: '1300',
    };
    expect(runCorrections(events, null)).toMatchObject([line]);
    expect(runCorrections(events, new Set(['A']))).toMatchObject([line]);
  });
});
