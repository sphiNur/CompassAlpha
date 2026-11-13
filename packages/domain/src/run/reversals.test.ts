import { describe, expect, test } from 'bun:test';
import { applyRun, decideRun, emptyRunState } from './index';
import type { RunCommand } from './commands';
import {
  RUN_CLOCK as clock,
  confirmStoreAllOk,
  confirmStoreItem,
  confirmer,
  deliver,
  planAndPurchase,
  planRun,
  purchaseItem,
  purchaser,
  revisePurchase,
  runActor,
  runStepper,
} from '../testing';

const { step } = runStepper(clock);

// ----------------------------------------------------------------------
// Reversal commands — every step must be undoable until the world makes
// the action permanent (goods delivered, run finished). These tests
// pin both the happy path AND the precondition gates that prevent
// nonsensical undos (e.g. unmarking a still-pending item).
// ----------------------------------------------------------------------
describe('run.reversals', () => {
  test('RevisePurchase updates qty/price/splits while purchasing', () => {
    let s = planAndPurchase({ purchasedQty: '4' });
    s = step(
      s,
      revisePurchase({
        skuId: 'sku-1',
        supplierId: 'sup-1',
        unitPrice: '15000',
        actualQty: '5',
        receiptPhotoUrl: 'https://x/y',
        reason: 'price misread on receipt',
        storeSplits: [
          { storeId: 'A', qty: '3' },
          { storeId: 'B', qty: '2' },
        ],
        paymentMethod: 'transfer',
      }),
    );
    const item = s.items.get('sku-1')!;
    expect(item.unitPrice).toBe('15000');
    expect(item.purchasedQty).toBe('5');
    expect(item.receiptPhotoUrl).toBe('https://x/y');
    expect(item.storeSplits).toEqual([
      { storeId: 'A', qty: '3' },
      { storeId: 'B', qty: '2' },
    ]);
    expect(item.paymentMethod).toBe('transfer'); // was cash
    expect(item.status).toBe('purchased'); // status unchanged
  });

  test('RevisePurchase rejected on a still-pending item', () => {
    let s = emptyRunState('run-1');
    s = step(s, planRun({ plannedItems: [{ skuId: 'sku-1', qty: '4' }] }));
    s = step(s, { type: 'StartPurchase', actor: purchaser() });
    expect(() =>
      decideRun(s, revisePurchase({ skuId: 'sku-1', unitPrice: '1', actualQty: '4' }), clock),
    ).toThrow('run.errors.notRevisable');
  });

  test('RevisePurchase of quantities blocked once the goods reached the store', () => {
    let s = planAndPurchase();
    s = deliver(s);
    expect(() =>
      decideRun(s, revisePurchase({ skuId: 'sku-1', unitPrice: '1', actualQty: '3' }), clock),
    ).toThrow('run.errors.cannotReviseAfterDelivery');
  });

  test('UnmarkUnavailable flips unavailable → pending', () => {
    let s = emptyRunState('run-1');
    s = step(s, planRun({ plannedItems: [{ skuId: 'sku-1', qty: '4' }] }));
    s = step(s, { type: 'StartPurchase', actor: purchaser() });
    s = step(s, { type: 'MarkUnavailable', skuId: 'sku-1', note: 'sold out', actor: purchaser() });
    expect(s.items.get('sku-1')!.status).toBe('unavailable');
    s = step(s, {
      type: 'UnmarkUnavailable',
      skuId: 'sku-1',
      reason: 'found another supplier',
      actor: purchaser(),
    });
    expect(s.items.get('sku-1')!.status).toBe('pending');
    expect(s.items.get('sku-1')!.unavailableNote).toBeNull();
  });

  test('UnmarkUnavailable rejected when item is not in unavailable state', () => {
    const s = planAndPurchase();
    expect(() =>
      decideRun(
        s,
        { type: 'UnmarkUnavailable', skuId: 'sku-1', reason: 'x', actor: purchaser() },
        clock,
      ),
    ).toThrow('run.errors.notUnavailable');
  });

  test('UndeliverStore rolls back StoreDelivered before confirm', () => {
    let s = planAndPurchase();
    s = deliver(s);
    expect(s.stores.get('A')?.deliveredAt).not.toBeNull();
    s = step(s, {
      type: 'UndeliverStore',
      storeId: 'A',
      reason: 'wrong store',
      actor: purchaser(),
    });
    expect(s.stores.get('A')?.deliveredAt).toBeNull();
  });

  test('UndeliverStore rejected after store confirmed', () => {
    let s = planAndPurchase();
    s = deliver(s);
    s = confirmStoreAllOk(s, 'A');
    expect(() =>
      decideRun(
        s,
        { type: 'UndeliverStore', storeId: 'A', reason: 'too late', actor: purchaser() },
        clock,
      ),
    ).toThrow('run.errors.alreadyConfirmed');
  });

  test('UndoStartPurchase reverts to planned when nothing has been bought', () => {
    let s = emptyRunState('run-1');
    s = step(s, planRun({ plannedItems: [{ skuId: 'sku-1', qty: '4' }] }));
    s = step(s, { type: 'StartPurchase', actor: purchaser() });
    expect(s.status).toBe('purchasing');
    s = step(s, { type: 'UndoStartPurchase', reason: 'tapped by mistake', actor: purchaser() });
    expect(s.status).toBe('planned');
  });

  test('StartPurchase without run.purchase permission throws (M3.33 #11)', () => {
    let s = emptyRunState('r1');
    s = step(
      s,
      planRun({ orgId: 'o', sessionIds: ['s'], plannedItems: [{ skuId: 'k', qty: '1' }] }),
    );
    const noPurchasePerm = runActor('m-x', ['run.create'], 'u-x');
    expect(() => decideRun(s, { type: 'StartPurchase', actor: noPurchasePerm }, clock)).toThrow(
      'run.errors.cannotPurchase',
    );
  });

  test('PurchaseItem blocked when run.status === delivering (M3.33 #12)', () => {
    let s = planAndPurchase();
    s = step(s, { type: 'StartDelivery', actor: purchaser() });
    expect(s.status).toBe('delivering');
    expect(() =>
      decideRun(
        s,
        purchaseItem({ skuId: 'sku-1', supplierId: 'sup-1', unitPrice: '5000', actualQty: '2' }),
        clock,
      ),
    ).toThrow('run.errors.runFrozen');
  });

  test('AttachSessions adds new SKUs and accumulates existing plannedQty (M3.31)', () => {
    // Existing run with sku-1 planned 4kg; attach a session whose
    // demand is sku-1 +2 and sku-2 +3. Expect plannedQty(sku-1)=6,
    // pending row created for sku-2, sessionIds extended.
    let state = emptyRunState('run-1');
    state = step(
      state,
      planRun({ sessionIds: ['sess-A'], plannedItems: [{ skuId: 'sku-1', qty: '4' }] }),
    );
    expect(state.sessionIds).toEqual(['sess-A']);
    expect(state.items.get('sku-1')?.plannedQty).toBe('4');

    state = step(state, {
      type: 'AttachSessions',
      sessionIds: ['sess-B'],
      addedPlannedItems: [
        { skuId: 'sku-1', qty: '2' },
        { skuId: 'sku-2', qty: '3' },
      ],
      actor: purchaser(),
    });

    expect(state.sessionIds).toEqual(['sess-A', 'sess-B']);
    expect(state.items.get('sku-1')?.plannedQty).toBe('6');
    expect(state.items.get('sku-2')?.plannedQty).toBe('3');
    expect(state.items.get('sku-2')?.status).toBe('pending');
  });

  test('AttachSessions during purchasing keeps purchased items intact', () => {
    // Plan + start + purchase sku-1 (4kg) → status=purchasing, sku-1=purchased.
    // Attach session adding sku-1 +2 and sku-2 +5. sku-1 plannedQty
    // grows to 6 but status stays 'purchased' and purchasedQty=4 is
    // unchanged. sku-2 enters as pending.
    let state = planAndPurchase();
    expect(state.status).toBe('purchasing');
    expect(state.items.get('sku-1')?.status).toBe('purchased');

    state = step(state, {
      type: 'AttachSessions',
      sessionIds: ['sess-late'],
      addedPlannedItems: [
        { skuId: 'sku-1', qty: '2' },
        { skuId: 'sku-2', qty: '5' },
      ],
      actor: purchaser(),
    });

    const sku1 = state.items.get('sku-1')!;
    expect(sku1.plannedQty).toBe('6');
    expect(sku1.purchasedQty).toBe('4');
    expect(sku1.status).toBe('purchased');
    expect(state.items.get('sku-2')?.status).toBe('pending');
  });

  test('AttachSessions rejects duplicate session ids', () => {
    let state = emptyRunState('run-1');
    state = step(
      state,
      planRun({ sessionIds: ['sess-A'], plannedItems: [{ skuId: 'sku-1', qty: '4' }] }),
    );
    expect(() =>
      decideRun(
        state,
        {
          type: 'AttachSessions',
          sessionIds: ['sess-A'],
          addedPlannedItems: [{ skuId: 'sku-1', qty: '2' }],
          actor: purchaser(),
        },
        clock,
      ),
    ).toThrow('run.errors.sessionAlreadyInRun');
  });

  test('AttachSessions blocked once delivering', () => {
    let state = planAndPurchase();
    state = step(state, { type: 'StartDelivery', actor: purchaser() });
    expect(state.status).toBe('delivering');
    expect(() =>
      decideRun(
        state,
        {
          type: 'AttachSessions',
          sessionIds: ['sess-late'],
          addedPlannedItems: [{ skuId: 'sku-2', qty: '1' }],
          actor: purchaser(),
        },
        clock,
      ),
    ).toThrow('run.errors.cannotAttachInStatus');
  });

  test('EjectSession removes one session demand from a mutable run', () => {
    let state = emptyRunState('run-1');
    state = step(
      state,
      planRun({
        sessionIds: ['sess-A', 'sess-B'],
        plannedItems: [
          { skuId: 'sku-1', qty: '7' },
          { skuId: 'sku-2', qty: '3' },
        ],
      }),
    );

    state = step(state, {
      type: 'EjectSession',
      sessionId: 'sess-B',
      removedPlannedItems: [
        { skuId: 'sku-1', qty: '2' },
        { skuId: 'sku-2', qty: '3' },
      ],
      reason: 'approved by mistake',
      actor: purchaser(['run.eject_session']),
    });

    expect(state.sessionIds).toEqual(['sess-A']);
    expect(state.items.get('sku-1')?.plannedQty).toBe('5');
    expect(state.items.has('sku-2')).toBe(false);
  });

  test('quantities add and subtract in whole thousandths (RUNAPI-05)', () => {
    const empty = emptyRunState('run-1');
    const plan = decideRun(
      empty,
      planRun({ sessionIds: ['sess-A', 'sess-B'], plannedItems: [{ skuId: 'sku-1', qty: '0.1' }] }),
      clock,
    );
    let state = plan.reduce(applyRun, empty);
    state = step(state, {
      type: 'AttachSessions',
      sessionIds: ['sess-C'],
      addedPlannedItems: [{ skuId: 'sku-1', qty: '0.2' }],
      actor: purchaser(),
    });
    // As floats: "0.30000000000000004".
    expect(state.items.get('sku-1')?.plannedQty).toBe('0.3');

    state = step(state, {
      type: 'EjectSession',
      sessionId: 'sess-C',
      removedPlannedItems: [{ skuId: 'sku-1', qty: '0.2' }],
      reason: 'approved by mistake',
      actor: purchaser(['run.eject_session']),
    });
    // As floats: "0.10000000000000003".
    expect(state.items.get('sku-1')?.plannedQty).toBe('0.1');

    // A payload written before the fix replays to the clean value.
    const noisy = plan.map((e) =>
      e.type === 'RunPlanned'
        ? {
            ...e,
            payload: {
              ...e.payload,
              plannedItems: [{ skuId: 'sku-1', qty: '0.30000000000000004' }],
            },
          }
        : e,
    );
    expect(noisy.reduce(applyRun, empty).items.get('sku-1')?.plannedQty).toBe('0.3');
  });

  test('EjectSession rejects touched SKUs', () => {
    let state = emptyRunState('run-1');
    state = step(
      state,
      planRun({ sessionIds: ['sess-A', 'sess-B'], plannedItems: [{ skuId: 'sku-1', qty: '7' }] }),
    );
    state = step(state, { type: 'StartPurchase', actor: purchaser() });
    state = step(state, purchaseItem({ skuId: 'sku-1', unitPrice: '1000', actualQty: '7' }));

    expect(() =>
      decideRun(
        state,
        {
          type: 'EjectSession',
          sessionId: 'sess-B',
          removedPlannedItems: [{ skuId: 'sku-1', qty: '2' }],
          actor: purchaser(['run.eject_session']),
        },
        clock,
      ),
    ).toThrow('order.errors.cannotEject');
  });

  test('EjectSession can remove a submission with only extra items', () => {
    let state = emptyRunState('run-1');
    state = step(
      state,
      planRun({ sessionIds: ['sess-A', 'sess-B'], plannedItems: [{ skuId: 'sku-1', qty: '4' }] }),
    );

    state = step(state, {
      type: 'EjectSession',
      sessionId: 'sess-B',
      removedPlannedItems: [],
      actor: purchaser(['run.eject_session']),
    });

    expect(state.sessionIds).toEqual(['sess-A']);
    expect(state.items.get('sku-1')?.plannedQty).toBe('4');
  });

  test('UndoStartPurchase preserves item-level purchase state when reverting (M3.29)', () => {
    // After M3.29 the "all items pending" gate was lifted — the user
    // can step back to planning to modify the run without losing what
    // they've already bought. The reducer only flips run.status; item
    // rows (purchasedQty, unitPrice, supplierId, status) stay put,
    // so re-StartPurchase shows them as already ✓.
    let s = planAndPurchase();
    expect(s.status).toBe('purchasing');
    const purchasedBefore = s.items.get('sku-1')!;
    expect(purchasedBefore.status).toBe('purchased');
    expect(purchasedBefore.purchasedQty).toBe('4');

    s = step(s, {
      type: 'UndoStartPurchase',
      reason: 'need to add another session',
      actor: purchaser(),
    });

    expect(s.status).toBe('planned');
    const after = s.items.get('sku-1')!;
    expect(after.status).toBe('purchased');
    expect(after.purchasedQty).toBe('4');
    expect(after.unitPrice).toBe('12000');
    expect(after.supplierId).toBe('sup-1');

    // Restarting purchase should be a no-op for the already-purchased
    // item: it stays ✓, and the purchaser only sees pending rows left
    // to handle.
    s = step(s, { type: 'StartPurchase', actor: purchaser() });
    expect(s.status).toBe('purchasing');
    expect(s.items.get('sku-1')!.status).toBe('purchased');
  });

  test('UndoStartDelivery reverts to purchasing when no store has been delivered to', () => {
    let s = planAndPurchase();
    s = step(s, { type: 'StartDelivery', actor: purchaser() });
    expect(s.status).toBe('delivering');
    s = step(s, { type: 'UndoStartDelivery', reason: 'forgot to mark a SKU', actor: purchaser() });
    expect(s.status).toBe('purchasing');
  });

  test('UndoStartDelivery blocked after first store delivered', () => {
    let s = planAndPurchase();
    s = deliver(s);
    expect(() =>
      decideRun(s, { type: 'UndoStartDelivery', reason: 'x', actor: purchaser() }, clock),
    ).toThrow('run.errors.deliveryAlreadyProgressed');
  });

  test('ConfirmStoreItem second tap with identical args is a no-op', () => {
    // Reproduces the audit-log bloat the user hit: tap "ok" → no
    // visible change (slow ws) → tap again → previously generated
    // a duplicate StoreItemConfirmed event. Now the second decide
    // returns [] so nothing extra is appended.
    let s = planAndPurchase();
    s = deliver(s);
    s = step(s, confirmStoreItem({ skuId: 'sku-1' }));
    const dup = decideRun(s, confirmStoreItem({ skuId: 'sku-1' }), clock);
    expect(dup).toEqual([]);
  });

  test('ConfirmStoreItem with different status emits a new event (issue overrides ok)', () => {
    // Going from "ok" to "short" is a real change and SHOULD append.
    let s = planAndPurchase();
    s = deliver(s);
    s = step(s, confirmStoreItem({ skuId: 'sku-1' }));
    const next = decideRun(
      s,
      confirmStoreItem({
        skuId: 'sku-1',
        status: 'short',
        note: 'one bag missing',
        receivedQty: '3',
      }),
      clock,
    );
    expect(next.length).toBe(1);
    expect(next[0]!.type).toBe('StoreItemConfirmed');
  });

  test('ConfirmStore second tap is a no-op (already confirmed)', () => {
    // The user reported tapping "Confirm store" 5 times — log showed
    // 5 StoreConfirmed events. Now the second decide returns [].
    let s = planAndPurchase();
    s = deliver(s);
    s = confirmStoreAllOk(s, 'A');
    const dup = decideRun(s, { type: 'ConfirmStore', storeId: 'A', actor: confirmer() }, clock);
    expect(dup).toEqual([]);
  });

  test('ConfirmStore is refused while a line is unchecked (DLV-19)', () => {
    let s = planAndPurchase();
    s = deliver(s);
    // It used to write an "ok" for the line nobody had checked.
    expect(() =>
      decideRun(s, { type: 'ConfirmStore', storeId: 'A', actor: confirmer() }, clock),
    ).toThrow('run.errors.storeItemsUnchecked');
    s = confirmStoreAllOk(s, 'A');
    expect(s.stores.get('A')?.confirmedAt).toBeTruthy();
    expect(s.stores.get('A')?.itemConfirms.get('sku-1')?.status).toBe('ok');
  });

  test('ConfirmStore is blocked after a run is cancelled or finished', () => {
    let delivering = planAndPurchase();
    delivering = step(delivering, { type: 'StartDelivery', actor: purchaser() });
    delivering = step(delivering, { type: 'DeliverToStore', storeId: 'A', actor: purchaser() });

    // DLV-6 (2026-10-30): CancelRun now refuses a delivered run, but
    // streams written before that may hold one; the guard must hold there.
    const cancelled = applyRun(delivering, {
      streamId: delivering.streamId,
      seq: delivering.seq + 1,
      occurredAt: clock.now(),
      actorUserId: null,
      actorMemberId: null,
      type: 'RunCancelled',
      payload: { reason: 'delivery cancelled' },
    });
    expect(() =>
      decideRun(cancelled, { type: 'ConfirmStore', storeId: 'A', actor: confirmer() }, clock),
    ).toThrow('run.errors.notDelivering');

    let finished = confirmStoreAllOk(delivering, 'A');
    finished = step(finished, { type: 'FinishRun', actor: purchaser() });
    expect(() =>
      decideRun(finished, { type: 'ConfirmStore', storeId: 'A', actor: confirmer() }, clock),
    ).toThrow('run.errors.notDelivering');
  });

  test('UndoPurchase reverts a purchased item back to pending', () => {
    let s = planAndPurchase();
    expect(s.items.get('sku-1')!.status).toBe('purchased');
    s = step(s, {
      type: 'UndoPurchase',
      skuId: 'sku-1',
      reason: 'mistapped wrong row',
      actor: purchaser(),
    });
    const item = s.items.get('sku-1')!;
    expect(item.status).toBe('pending');
    expect(item.purchasedQty).toBeNull();
    expect(item.unitPrice).toBeNull();
    expect(item.storeSplits).toEqual([]);
  });

  test('UndoPurchase rejected on a still-pending item', () => {
    let s = emptyRunState('run-1');
    s = step(s, planRun({ plannedItems: [{ skuId: 'sku-1', qty: '4' }] }));
    s = step(s, { type: 'StartPurchase', actor: purchaser() });
    expect(() =>
      decideRun(
        s,
        { type: 'UndoPurchase', skuId: 'sku-1', reason: 'x', actor: purchaser() },
        clock,
      ),
    ).toThrow('run.errors.notPurchased');
  });

  // Review RUNAPI-02 (2026-11-09): a line put back during delivery had
  // no way forward (buy and mark are frozen then) and the run finished
  // with it still pending.
  test('nothing goes back to "to buy" once delivery has started', () => {
    let s = planAndPurchase();
    s = step(s, {
      type: 'AttachSessions',
      sessionIds: ['s2'],
      addedPlannedItems: [{ skuId: 'sku-2', qty: '1' }],
      actor: purchaser(),
    } as RunCommand);
    s = step(s, {
      type: 'MarkUnavailable',
      skuId: 'sku-2',
      note: 'none today',
      actor: purchaser(),
    });
    s = step(s, { type: 'StartDelivery', actor: purchaser() });
    expect(() =>
      decideRun(
        s,
        { type: 'UnmarkUnavailable', skuId: 'sku-2', reason: 'found it', actor: purchaser() },
        clock,
      ),
    ).toThrow('run.errors.listFrozenWhileDelivering');
    expect(() =>
      decideRun(
        s,
        { type: 'UndoPurchase', skuId: 'sku-1', reason: 'wrong row', actor: purchaser() },
        clock,
      ),
    ).toThrow('run.errors.listFrozenWhileDelivering');
    // Back to purchase first, and both work again.
    s = step(s, {
      type: 'UndoStartDelivery',
      reason: 'one more',
      actor: purchaser(),
    } as RunCommand);
    expect(
      decideRun(
        s,
        { type: 'UnmarkUnavailable', skuId: 'sku-2', reason: 'found it', actor: purchaser() },
        clock,
      ),
    ).toHaveLength(1);
  });

  test('UndoPurchase blocked once the goods reached the store', () => {
    let s = planAndPurchase();
    s = deliver(s);
    expect(() =>
      decideRun(
        s,
        { type: 'UndoPurchase', skuId: 'sku-1', reason: 'too late', actor: purchaser() },
        clock,
      ),
    ).toThrow('run.errors.cannotReviseAfterDelivery');
  });

  test('a revision still needs a reason', () => {
    const s = planAndPurchase();
    expect(() =>
      decideRun(
        s,
        revisePurchase({ skuId: 'sku-1', unitPrice: '1', actualQty: '4', reason: '   ' }),
        clock,
      ),
    ).toThrow('run.errors.reviseReasonRequired');
  });

  // Simplification (2026-11-13): back to plan, back to purchase, recall
  // and "available again" take no reason; one sent is still kept.
  test('the step-back reversals take an empty or absent reason', () => {
    let s = emptyRunState('run-1');
    s = step(s, planRun({ plannedItems: [{ skuId: 'sku-1', qty: '4' }] }));
    s = step(s, { type: 'StartPurchase', actor: purchaser() });
    s = step(s, { type: 'MarkUnavailable', skuId: 'sku-1', note: 'sold out', actor: purchaser() });
    const unmark = decideRun(
      s,
      { type: 'UnmarkUnavailable', skuId: 'sku-1', actor: purchaser() },
      clock,
    );
    expect(unmark[0]).toMatchObject({ type: 'UnavailableUndone', payload: { reason: '' } });
    const back = decideRun(
      s,
      { type: 'UndoStartPurchase', reason: '  ', actor: purchaser() },
      clock,
    );
    expect(back[0]).toMatchObject({ type: 'PurchaseStartUndone', payload: { reason: '' } });

    let d = planAndPurchase();
    d = step(d, { type: 'StartDelivery', actor: purchaser() });
    const undo = decideRun(d, { type: 'UndoStartDelivery', actor: purchaser() }, clock);
    expect(undo[0]).toMatchObject({ type: 'DeliveryStartUndone', payload: { reason: '' } });

    d = deliver(planAndPurchase());
    const recall = decideRun(
      d,
      { type: 'UndeliverStore', storeId: 'A', reason: '', actor: purchaser() },
      clock,
    );
    expect(recall[0]).toMatchObject({ type: 'StoreDeliveryUndone', payload: { reason: '' } });
    const kept = decideRun(
      d,
      { type: 'UndeliverStore', storeId: 'A', reason: ' wrong store ', actor: purchaser() },
      clock,
    );
    expect(kept[0]).toMatchObject({ payload: { reason: 'wrong store' } });
  });
});
