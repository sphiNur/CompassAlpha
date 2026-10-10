import { describe, expect, test } from 'bun:test';
import type { RunEvent } from '@compass/domain/run';
import { analyseRun, hasDamage } from '../maintenance/duplicatePurchases';

const RUN = 'run-1';
const SKU = 'sku-apple';

/** Build a run history from a list of (type, payload), numbering seq. */
function history(...steps: Array<[RunEvent['type'], unknown]>): RunEvent[] {
  return steps.map(
    ([type, payload], i) =>
      ({
        streamId: RUN,
        seq: i + 1,
        occurredAt: new Date(Date.UTC(2026, 6, 1, 6, i)),
        actorUserId: 'u1',
        actorMemberId: 'm1',
        type,
        payload,
      }) as unknown as RunEvent,
  );
}

const planned: [RunEvent['type'], unknown] = [
  'RunPlanned',
  {
    orgId: 'org',
    runDate: '2026-07-01',
    runIndex: 0,
    sessionIds: ['s1'],
    plannedItems: [{ skuId: SKU, qty: '10' }],
    purchaserMemberId: 'm1',
  },
];
const started: [RunEvent['type'], unknown] = ['PurchaseStarted', {}];
const bought = (splits: Array<{ storeId: string; qty: string }>): [RunEvent['type'], unknown] => [
  'ItemPurchased',
  {
    skuId: SKU,
    supplierId: null,
    unitPrice: '12000',
    actualQty: String(splits.reduce((n, s) => n + Number(s.qty), 0)),
    receiptPhotoUrl: null,
    storeSplits: splits,
    paymentMethod: 'cash',
  },
];

describe('analyseRun', () => {
  test('a buy re-recorded for fewer stores leaves a stale split and a phantom receipt', () => {
    const events = history(
      planned,
      started,
      bought([
        { storeId: 'A', qty: '5' },
        { storeId: 'B', qty: '5' },
      ]),
      bought([{ storeId: 'A', qty: '10' }]),
    );
    const found = analyseRun(
      RUN,
      events,
      // What the old projection left: A updated in place, B never removed.
      [
        { skuId: SKU, storeId: 'A', qty: '10.000' },
        { skuId: SKU, storeId: 'B', qty: '5.000' },
      ],
      [
        { id: 'mov-a', skuId: SKU, storeId: 'A', delta: '10.000' },
        { id: 'mov-b', skuId: SKU, storeId: 'B', delta: '5.000' },
      ],
    );
    expect(found.rerecorded).toHaveLength(1);
    expect(found.rerecorded[0]).toMatchObject({ skuId: SKU, seq: 4, droppedStoreIds: ['B'] });
    expect(found.staleSplits).toEqual([{ skuId: SKU, storeId: 'B', qty: '5.000' }]);
    expect(found.phantomMovements.map((m) => m.id)).toEqual(['mov-b']);
    expect(found.wrongQtySplits).toEqual([]);
    expect(hasDamage(found)).toBe(true);
  });

  test('a re-record that names the same stores left nothing behind', () => {
    const events = history(
      planned,
      started,
      bought([{ storeId: 'A', qty: '10' }]),
      bought([{ storeId: 'A', qty: '8' }]),
    );
    const found = analyseRun(RUN, events, [{ skuId: SKU, storeId: 'A', qty: '8.000' }], []);
    expect(found.rerecorded).toHaveLength(1);
    expect(found.rerecorded[0]!.droppedStoreIds).toEqual([]);
    expect(hasDamage(found)).toBe(false);
  });

  test('buy, undo, buy again is not a re-record', () => {
    const events = history(
      planned,
      started,
      bought([
        { storeId: 'A', qty: '5' },
        { storeId: 'B', qty: '5' },
      ]),
      ['PurchaseUndone', { skuId: SKU, reason: 'wrong stall' }],
      bought([{ storeId: 'A', qty: '10' }]),
    );
    const found = analyseRun(RUN, events, [{ skuId: SKU, storeId: 'A', qty: '10.000' }], []);
    expect(found.rerecorded).toEqual([]);
    expect(hasDamage(found)).toBe(false);
  });

  test('reports a split the read model is missing or holds at the wrong quantity', () => {
    const events = history(
      planned,
      started,
      bought([
        { storeId: 'A', qty: '4' },
        { storeId: 'B', qty: '6' },
      ]),
    );
    const found = analyseRun(RUN, events, [{ skuId: SKU, storeId: 'A', qty: '5.000' }], []);
    expect(found.wrongQtySplits).toEqual([
      { skuId: SKU, storeId: 'A', qty: '5.000', expectedQty: '4' },
    ]);
    expect(found.missingSplits).toEqual([{ skuId: SKU, storeId: 'B', qty: '6' }]);
  });
});
