/**
 * A stream can hold an event type this release does not know: a newer
 * release wrote it and was then rolled back (scripts/deploy.ts puts the
 * previous release back on its own when the new api does not start), or
 * the Fine app wrote it. The reducers must count its seq; they used to
 * return the state unchanged, so the next event threw "seq gap" and, with
 * the unknown event last, every command decided a seq that already
 * existed and was refused as staleSeq for good.
 */
import { describe, expect, test } from 'bun:test';
import { fixedClock } from './shared/clock';
import { decide, emptyState, replay, type OrderEvent } from './order/index';
import { decideRun, emptyRunState, replayRun, type RunEvent } from './run/index';
import {
  RUN_CLOCK,
  orderStepper,
  planRun,
  purchaseItem,
  purchaser,
  runStepper,
  sku,
  staff,
} from './testing';

const NOW = new Date('2026-05-02T10:00:00Z');
const clock = fixedClock(NOW);

function forged(streamId: string, seq: number): unknown {
  return {
    streamId,
    seq,
    occurredAt: NOW,
    actorUserId: null,
    actorMemberId: null,
    type: 'SomethingFromANewerRelease',
    payload: { anything: true },
  };
}

describe('an event type this release does not know', () => {
  test('order: its seq counts, and the stream stays writable', () => {
    const { events } = orderStepper(clock).steps(emptyState('sess-1'), [
      {
        type: 'StartDraft',
        orgId: 'org-1',
        storeId: 'store-1',
        orderDate: '2026-05-02',
        actor: staff(),
      },
      { type: 'AdjustItem', skuId: 'sku-1', qty: '1', sku: sku('sku-1'), actor: staff() },
    ]);
    const stream = [...events, forged('sess-1', events.length + 1) as OrderEvent];

    const state = replay('sess-1', stream);
    expect(state.seq).toBe(stream.length);
    expect(state.status).toBe('draft');

    // The next command appends after it, and replaying past it works.
    const next = decide(
      state,
      { type: 'AdjustItem', skuId: 'sku-1', qty: '2', sku: sku('sku-1'), actor: staff() },
      { clock },
    );
    expect(next.length).toBeGreaterThan(0);
    expect(next[0]!.seq).toBe(stream.length + 1);
    expect(replay('sess-1', [...stream, ...next]).seq).toBe(stream.length + next.length);
  });

  test('run: its seq counts, and the stream stays writable', () => {
    const { state: before, events } = runStepper().steps(emptyRunState('run-1'), [
      planRun({ plannedItems: [{ skuId: 'sku-1', qty: '4' }] }),
      { type: 'StartPurchase', actor: purchaser() },
    ]);
    const stream = [...events, forged('run-1', before.seq + 1) as RunEvent];

    const state = replayRun('run-1', stream);
    expect(state.seq).toBe(before.seq + 1);
    expect(state.status).toBe('purchasing');

    const next = decideRun(
      state,
      purchaseItem({
        skuId: 'sku-1',
        supplierId: 'sup-1',
        unitPrice: '12000',
        actualQty: '4',
        storeSplits: [{ storeId: 'A', qty: '4' }],
      }),
      RUN_CLOCK,
    );
    expect(next.length).toBeGreaterThan(0);
    expect(next[0]!.seq).toBe(state.seq + 1);
    expect(replayRun('run-1', [...stream, ...next]).seq).toBe(state.seq + next.length);
  });
});
