import { describe, expect, test } from 'bun:test';
import { applyRun, decideRun, emptyRunState } from './index';
import {
  RUN_CLOCK as clock,
  RUN_NOW as NOW,
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

const { step, steps } = runStepper(clock);

describe('run.decide', () => {
  test('PlanRun without run.create permission throws forbidden', () => {
    const state = emptyRunState('r1');
    const noPerm = runActor('x', []);
    expect(() =>
      decideRun(
        state,
        planRun({ orgId: 'org', plannedItems: [{ skuId: 'k', qty: '1' }], actor: noPerm }),
      ),
    ).toThrow('run.errors.cannotCreate');
  });

  test('PlanRun with empty sessions throws validation', () => {
    const state = emptyRunState('r1');
    expect(() =>
      decideRun(
        state,
        planRun({ orgId: 'org', sessionIds: [], plannedItems: [{ skuId: 'k', qty: '1' }] }),
      ),
    ).toThrow('run.errors.noSessions');
  });

  test('PurchaseItem auto-emits PurchaseStarted on first call from planned state', () => {
    let state = emptyRunState('r1');
    state = step(
      state,
      planRun({ orgId: 'o', sessionIds: ['s'], plannedItems: [{ skuId: 'k', qty: '1' }] }),
    );
    expect(state.status).toBe('planned');
    const evs = decideRun(
      state,
      purchaseItem({
        skuId: 'k',
        unitPrice: '100',
        actualQty: '1',
        storeSplits: [{ storeId: 's1', qty: '1' }],
      }),
      clock,
    );
    expect(evs.map((e) => e.type)).toEqual(['PurchaseStarted', 'ItemPurchased']);
  });

  test('a confirmed unusual price is on the record, and only then', () => {
    const state = planAndPurchase({
      purchasedQty: '10',
      storeSplits: [{ storeId: 'A', qty: '10' }],
    });
    const revise = (priceConfirmed?: boolean) =>
      decideRun(
        state,
        revisePurchase({
          skuId: 'sku-1',
          supplierId: 'sup-1',
          unitPrice: '1200000',
          actualQty: '10',
          reason: 'the price went up',
          ...(priceConfirmed === undefined ? {} : { priceConfirmed }),
        }),
        clock,
      )[0]!.payload;
    expect(revise(true)).toMatchObject({ priceConfirmed: true });
    // Not confirmed is not written at all: events keep their old shape.
    expect('priceConfirmed' in revise(false)).toBe(false);
    expect('priceConfirmed' in revise()).toBe(false);
  });

  test('PurchaseItem refuses an item that is already bought', () => {
    const state = planAndPurchase({
      purchasedQty: '10',
      storeSplits: [
        { storeId: 'A', qty: '5' },
        { storeId: 'B', qty: '5' },
      ],
    });
    expect(() =>
      decideRun(
        state,
        purchaseItem({ skuId: 'sku-1', supplierId: 'sup-1', unitPrice: '12000', actualQty: '10' }),
        clock,
      ),
    ).toThrow('run.errors.itemAlreadyPurchased');
  });

  test('PurchaseItem requires storeSplits to sum exactly to actualQty', () => {
    let s = emptyRunState('r1');
    s = step(
      s,
      planRun({ orgId: 'o', sessionIds: ['s'], plannedItems: [{ skuId: 'k', qty: '5' }] }),
    );
    s = step(s, { type: 'StartPurchase', actor: purchaser() });
    expect(() =>
      decideRun(
        s,
        purchaseItem({
          skuId: 'k',
          unitPrice: '10',
          actualQty: '5',
          storeSplits: [
            { storeId: 'A', qty: '2' },
            { storeId: 'B', qty: '2' },
          ], // sums to 4, not 5
        }),
        clock,
      ),
    ).toThrow('run.errors.splitSumMismatch');
  });

  test('R2-ENG-2: a line over 1e12 (qty × price) is refused', () => {
    let s = emptyRunState('r');
    s = step(s, planRun({ orgId: 'o', plannedItems: [{ skuId: 'k', qty: '5' }] }));
    s = step(s, { type: 'StartPurchase', actor: purchaser() });
    const buy = (unitPrice: string, actualQty: string, splitPrice?: string) =>
      decideRun(
        s,
        purchaseItem({
          skuId: 'k',
          unitPrice,
          actualQty,
          storeSplits: [{ storeId: 'A', qty: actualQty, unitPrice: splitPrice }],
        }),
        clock,
      );
    expect(() => buy('999999999999.99', '999999999')).toThrow('run.errors.lineTooLarge');
    expect(() => buy('10', '1000', '1000000000.01')).toThrow('run.errors.lineTooLarge');
    expect(buy('1000000000', '1000').length).toBeGreaterThan(0);
  });

  test('allows a second purchaser to record a buy while another purchaser has claimed the run', () => {
    let state = emptyRunState('r1');
    state = step(
      state,
      planRun({ orgId: 'o', sessionIds: ['s'], plannedItems: [{ skuId: 'k', qty: '1' }] }),
    );
    state = step(state, { type: 'StartPurchase', actor: purchaser() });
    state = step(state, { type: 'ClaimRun', actor: purchaser() });

    const secondPurchaser = runActor('m2', ['run.purchase'], 'u2');
    const events = decideRun(
      state,
      purchaseItem({
        skuId: 'k',
        unitPrice: '100',
        actualQty: '1',
        storeSplits: [{ storeId: 's1', qty: '1' }],
        actor: secondPurchaser,
      }),
      clock,
    );

    expect(events.map((event) => event.type)).toEqual(['ItemPurchased']);
    expect(events[0]!.actorMemberId).toBe('m2');
  });

  test('MarkUnavailable requires non-empty note', () => {
    let s = emptyRunState('r1');
    s = step(
      s,
      planRun({ orgId: 'o', sessionIds: ['s'], plannedItems: [{ skuId: 'k', qty: '1' }] }),
    );
    s = step(s, { type: 'StartPurchase', actor: purchaser() });
    expect(() =>
      decideRun(s, { type: 'MarkUnavailable', skuId: 'k', note: '   ', actor: purchaser() }, clock),
    ).toThrow('run.errors.unavailableNoteRequired');
  });

  test('MarkUnavailable is limited to live purchase phases and freezes terminal runs', () => {
    let planned = emptyRunState('mark-unavailable-phase');
    planned = step(
      planned,
      planRun({ orgId: 'o', sessionIds: ['s'], plannedItems: [{ skuId: 'k', qty: '1' }] }),
    );

    // Preserve the existing first-action behaviour: marking unavailable is
    // legal while planned as well as after StartPurchase.
    expect(
      decideRun(
        planned,
        { type: 'MarkUnavailable', skuId: 'k', note: 'sold out', actor: purchaser() },
        clock,
      ).map((event) => event.type),
    ).toEqual(['ItemUnavailable']);

    for (const status of ['delivering', 'finished', 'cancelled'] as const) {
      expect(() =>
        decideRun(
          { ...planned, status },
          { type: 'MarkUnavailable', skuId: 'k', note: 'sold out', actor: purchaser() },
          clock,
        ),
      ).toThrow('run.errors.runFrozen');
    }
  });

  test('MarkUnavailable requires a pending item', () => {
    const purchased = planAndPurchase();
    expect(() =>
      decideRun(
        purchased,
        {
          type: 'MarkUnavailable',
          skuId: 'sku-1',
          note: 'incorrect second decision',
          actor: purchaser(),
        },
        clock,
      ),
    ).toThrow('run.errors.itemNotPending');

    let unavailable = emptyRunState('mark-unavailable-repeat');
    unavailable = step(
      unavailable,
      planRun({ orgId: 'o', sessionIds: ['s'], plannedItems: [{ skuId: 'k', qty: '1' }] }),
    );
    unavailable = step(unavailable, {
      type: 'MarkUnavailable',
      skuId: 'k',
      note: 'sold out',
      actor: purchaser(),
    });
    expect(() =>
      decideRun(
        unavailable,
        { type: 'MarkUnavailable', skuId: 'k', note: 'again', actor: purchaser() },
        clock,
      ),
    ).toThrow('run.errors.itemNotPending');
  });

  test('MarkUnavailable explicitly permits only run.amend holders while amending', () => {
    let planned = emptyRunState('mark-unavailable-amending');
    planned = step(
      planned,
      planRun({ orgId: 'o', sessionIds: ['s'], plannedItems: [{ skuId: 'k', qty: '1' }] }),
    );
    const amending = { ...planned, status: 'amending' as const };

    expect(() =>
      decideRun(
        amending,
        { type: 'MarkUnavailable', skuId: 'k', note: 'correction', actor: purchaser() },
        clock,
      ),
    ).toThrow('run.errors.cannotAmend');

    const amendActor = purchaser(['run.purchase', 'run.amend']);
    expect(
      decideRun(
        amending,
        { type: 'MarkUnavailable', skuId: 'k', note: 'correction', actor: amendActor },
        clock,
      ).map((event) => event.type),
    ).toEqual(['ItemUnavailable']);
  });

  // 2026-07-26: StartDelivery had no permission check whatsoever. The
  // tRPC layer only asserts store VISIBILITY, so any member with a store
  // in the run — including shop staff, whose whole permission set is
  // order.draft / order.submit / delivery.confirm / sales.record — could
  // end the purchasing phase while the purchaser was still in the
  // market, after which PurchaseItem rejects everything.
  test('StartDelivery is forbidden without run.purchase', () => {
    const s = planAndPurchase();
    const shopStaff = runActor('staff', [
      'order.draft',
      'order.submit',
      'delivery.confirm',
      'sales.record',
    ]);
    expect(() => decideRun(s, { type: 'StartDelivery', actor: shopStaff }, clock)).toThrow(
      'run.errors.cannotPurchase',
    );
  });

  test('StartDelivery is forbidden for a confirmer (delivery.confirm alone)', () => {
    const s = planAndPurchase();
    expect(() => decideRun(s, { type: 'StartDelivery', actor: confirmer() }, clock)).toThrow(
      'run.errors.cannotPurchase',
    );
  });

  test('StartDelivery still works for a purchaser', () => {
    const s = planAndPurchase();
    const evs = decideRun(s, { type: 'StartDelivery', actor: purchaser() }, clock);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.type).toBe('DeliveryStarted');
  });

  test('StartDelivery requires all items handled', () => {
    let s = emptyRunState('r1');
    s = step(
      s,
      planRun({
        orgId: 'o',
        sessionIds: ['s'],
        plannedItems: [
          { skuId: 'a', qty: '1' },
          { skuId: 'b', qty: '1' },
        ],
      }),
    );
    s = step(s, { type: 'StartPurchase', actor: purchaser() });
    s = step(
      s,
      purchaseItem({
        skuId: 'a',
        unitPrice: '1',
        actualQty: '1',
        storeSplits: [{ storeId: 's1', qty: '1' }],
      }),
    );
    // sku b still pending → StartDelivery should fail.
    expect(() => decideRun(s, { type: 'StartDelivery', actor: purchaser() }, clock)).toThrow(
      'run.errors.itemsPending',
    );
  });

  test('ConfirmStoreItem with non-ok status requires note', () => {
    let s = planAndPurchase();
    s = deliver(s);
    expect(() =>
      decideRun(s, confirmStoreItem({ skuId: 'sku-1', status: 'short', note: '' }), clock),
    ).toThrow('run.errors.confirmNoteRequiredOnIssue');
  });

  test('FinishRun requires all stores confirmed', () => {
    let s = planAndPurchase({
      storeSplits: [
        { storeId: 'A', qty: '2' },
        { storeId: 'B', qty: '2' },
      ],
    });
    s = deliver(s, ['A', 'B']);
    s = step(s, confirmStoreItem({ skuId: 'sku-1' }));
    s = confirmStoreAllOk(s, 'A');
    // store B not yet confirmed
    expect(() => decideRun(s, { type: 'FinishRun', actor: purchaser() }, clock)).toThrow(
      'run.errors.storeNotConfirmed',
    );
  });

  test('full happy path lands in finished status', () => {
    let s = planAndPurchase({ storeSplits: [{ storeId: 'A', qty: '4' }] });
    s = deliver(s);
    s = step(s, confirmStoreItem({ skuId: 'sku-1' }));
    s = confirmStoreAllOk(s, 'A');
    s = step(s, { type: 'FinishRun', actor: purchaser() });
    expect(s.status).toBe('finished');
    expect(s.finishedAt).toEqual(NOW);
  });

  test('super-admin amends a finished run: reopen → revise price → refinalize keeps cash+transfer=total', () => {
    const superAdmin = () => runActor('sa', ['run.purchase', 'run.amend']);
    // Drive sku-1 (qty 4 @ 12,000 cash) all the way to finished → total 48,000.
    let s = planAndPurchase({ storeSplits: [{ storeId: 'A', qty: '4' }] });
    s = deliver(s);
    s = step(s, confirmStoreItem({ skuId: 'sku-1' }));
    s = confirmStoreAllOk(s, 'A');
    const finishEvs = decideRun(s, { type: 'FinishRun', actor: purchaser() }, clock);
    s = finishEvs.reduce(applyRun, s);
    expect(s.status).toBe('finished');
    const finished = finishEvs[0];
    if (finished?.type !== 'RunFinished') throw new Error('expected RunFinished');
    expect(finished.payload.totalActual).toBe('48000.00');

    // A normal purchaser (no run.amend) can neither reopen nor edit it.
    expect(() =>
      decideRun(s, { type: 'ReopenRun', reason: 'fix', actor: purchaser() }, clock),
    ).toThrow('run.errors.cannotAmend');
    expect(() =>
      decideRun(
        s,
        revisePurchase({ skuId: 'sku-1', supplierId: 'sup-1', unitPrice: '15000', actualQty: '4' }),
        clock,
      ),
    ).toThrow('run.errors.runFrozen');

    // Super-admin reopens the finished run.
    s = step(s, { type: 'ReopenRun', reason: 'wrong unit price typed', actor: superAdmin() });
    expect(s.status).toBe('amending');

    // Correct the price 12,000 → 15,000 — allowed even though store A was
    // already delivered + confirmed (the amending delivered-guard skip).
    s = step(
      s,
      revisePurchase({
        skuId: 'sku-1',
        supplierId: 'sup-1',
        unitPrice: '15000',
        actualQty: '4',
        reason: 'corrected unit price',
        actor: superAdmin(),
      }),
    );
    expect(s.items.get('sku-1')?.unitPrice).toBe('15000');

    // DLV-3: a purchase undone during the correction leaves the item
    // pending, and the run cannot close until it is handled.
    const undone = step(s, {
      type: 'UndoPurchase',
      skuId: 'sku-1',
      reason: 'check',
      actor: superAdmin(),
    });
    expect(() => decideRun(undone, { type: 'RefinalizeRun', actor: superAdmin() }, clock)).toThrow(
      'run.errors.itemsPending',
    );

    // Refinalize: totals recomputed from the amended state.
    const refinEvs = decideRun(s, { type: 'RefinalizeRun', actor: superAdmin() }, clock);
    s = refinEvs.reduce(applyRun, s);
    expect(s.status).toBe('finished');
    const refin = refinEvs[0];
    if (refin?.type !== 'RunRefinalized') throw new Error('expected RunRefinalized');
    expect(refin.payload.totalActual).toBe('60000.00'); // 4 × 15,000
    expect(refin.payload.totalCash).toBe('60000.00');
    expect(refin.payload.totalTransfer).toBe('0.00');
    // Money integrity invariant.
    expect((Number(refin.payload.totalCash) + Number(refin.payload.totalTransfer)).toFixed(2)).toBe(
      refin.payload.totalActual,
    );
  });

  test('PurchaseItem is allowed while amending for run.amend holders (2026-07-30)', () => {
    // The gap this closes: an item that is IN the run but was never
    // bought — e.g. one marked unavailable — can only be recorded via
    // PurchaseItem, which used to hard-require planned/purchasing. A
    // super-admin who reopened a finished run to add a buy they had
    // missed hit `runFrozen`, and the workaround was blocked too
    // (AddPurchaserItem refuses an SKU already in the run).
    const sa = runActor('sa', ['run.amend', 'run.purchase']);
    // Two planned items; only sku-1 gets bought, sku-2 is marked
    // unavailable — the exact shape that used to dead-end.
    let s = steps(emptyRunState('run-amend-purchase'), [
      planRun({
        plannedItems: [
          { skuId: 'sku-1', qty: '4' },
          { skuId: 'sku-2', qty: '1' },
        ],
      }),
      { type: 'StartPurchase', actor: purchaser() },
      purchaseItem({ skuId: 'sku-1', supplierId: 'sup-1', unitPrice: '12000', actualQty: '4' }),
      { type: 'MarkUnavailable', skuId: 'sku-2', note: 'out of stock', actor: purchaser() },
      { type: 'StartDelivery', actor: purchaser() },
      { type: 'DeliverToStore', storeId: 'A', actor: purchaser() },
      confirmStoreItem({ skuId: 'sku-1' }),
      { type: 'ConfirmStore', storeId: 'A', actor: confirmer() },
      { type: 'FinishRun', actor: purchaser() },
    ]).state;
    expect(s.status).toBe('finished');

    // Frozen while finished, for everyone.
    expect(() =>
      decideRun(
        s,
        purchaseItem({ skuId: 'sku-2', unitPrice: '900', actualQty: '1', actor: sa }),
        clock,
      ),
    ).toThrow('run.errors.runFrozen');

    s = step(s, { type: 'ReopenRun', reason: 'missed a buy', actor: sa });
    expect(s.status).toBe('amending');

    // Now it goes through — this is the line that used to throw.
    s = step(s, purchaseItem({ skuId: 'sku-2', unitPrice: '900', actualQty: '1', actor: sa }));
    expect(s.items.get('sku-2')?.unitPrice).toBe('900');

    // Still closed to an actor without run.amend, even while amending.
    expect(() =>
      decideRun(s, purchaseItem({ skuId: 'sku-1', unitPrice: '1', actualQty: '1' }), clock),
    ).toThrow('run.errors.runFrozen');
  });

  test('ChangeRunDate moves the booking date without touching money', () => {
    const sa = runActor('sa', ['run.amend']);
    let s = planAndPurchase();
    const before = s.runDate;
    const totalsBefore = [...s.items.values()].map((i) => i.unitPrice);

    // Permission gate.
    expect(() =>
      decideRun(s, { type: 'ChangeRunDate', runDate: '2026-07-23', actor: purchaser() }, clock),
    ).toThrow('run.errors.cannotAmend');

    // Garbage and impossible dates are rejected (2026-02-31 would roll
    // over to March 3 and silently book the spend in the wrong month).
    for (const bad of ['not-a-date', '2026-13-01', '2026-02-31', '26-01-01']) {
      expect(() => decideRun(s, { type: 'ChangeRunDate', runDate: bad, actor: sa }, clock)).toThrow(
        'run.errors.invalidRunDate',
      );
    }

    const evs = decideRun(s, { type: 'ChangeRunDate', runDate: '2026-07-23', actor: sa }, clock);
    const ev = evs[0];
    if (ev?.type !== 'RunDateChanged') throw new Error('expected RunDateChanged');
    expect(ev.payload.previousRunDate).toBe(before);
    expect(ev.payload.runDate).toBe('2026-07-23');
    s = evs.reduce(applyRun, s);
    expect(s.runDate).toBe('2026-07-23');
    // Money is untouched — this reschedules, it does not re-price.
    expect([...s.items.values()].map((i) => i.unitPrice)).toEqual(totalsBefore);

    // Re-applying the same date is a no-op that must not forge an audit entry.
    expect(() =>
      decideRun(s, { type: 'ChangeRunDate', runDate: '2026-07-23', actor: sa }, clock),
    ).toThrow('run.errors.runDateUnchanged');
  });

  test('ChangeRunDate carries the run number on the new day (2026-10-23)', () => {
    const sa = runActor('sa', ['run.amend']);
    let s = planAndPurchase();
    expect(s.runIndex).toBe(0);
    const evs = decideRun(
      s,
      { type: 'ChangeRunDate', runDate: '2026-07-22', runIndex: 1, actor: sa },
      clock,
    );
    const ev = evs[0];
    if (ev?.type !== 'RunDateChanged') throw new Error('expected RunDateChanged');
    expect(ev.payload.runIndex).toBe(1);
    s = evs.reduce(applyRun, s);
    expect(s.runIndex).toBe(1);

    // Older events carry no runIndex: the number is kept.
    const legacy = decideRun(s, { type: 'ChangeRunDate', runDate: '2026-07-25', actor: sa }, clock);
    expect('runIndex' in legacy[0]!.payload).toBe(false);
    expect(legacy.reduce(applyRun, s).runIndex).toBe(1);
  });

  test('RefinalizeRun rejected unless status is amending', () => {
    const s = planAndPurchase();
    const superAdmin = runActor('sa', ['run.amend']);
    expect(() => decideRun(s, { type: 'RefinalizeRun', actor: superAdmin }, clock)).toThrow(
      'run.errors.notRefinalizable',
    );
    // Cancelled runs are permanently un-reopenable.
    void s;
  });

  // The reason being OPTIONAL is a deliberate product decision (M1.7:
  // most cancels are misclicks, and hard-requiring a reason just breeds
  // "asdf"). Pinned here because the tRPC edge schema disagreed with
  // this for months — `RunReasonOnlyInputSchema.min(1)` bounced every
  // no-reason cancel as BAD_REQUEST, so the behaviour below was
  // unreachable in production. See RunCancelInputSchema in contracts.
  test('CancelRun accepts an empty reason and stores it as null', () => {
    const s = planAndPurchase();
    const evs = decideRun(s, { type: 'CancelRun', reason: '', actor: purchaser() }, clock);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.type).toBe('RunCancelled');
    expect((evs[0]! as { payload: { reason: string | null } }).payload.reason).toBeNull();
  });

  test('CancelRun normalizes a whitespace-only reason to null', () => {
    const s = planAndPurchase();
    const evs = decideRun(s, { type: 'CancelRun', reason: '   ', actor: purchaser() }, clock);
    expect((evs[0]! as { payload: { reason: string | null } }).payload.reason).toBeNull();
  });

  test('CancelRun keeps a real reason verbatim after trimming', () => {
    const s = planAndPurchase();
    const evs = decideRun(
      s,
      { type: 'CancelRun', reason: '  市场关门了  ', actor: purchaser() },
      clock,
    );
    expect((evs[0]! as { payload: { reason: string | null } }).payload.reason).toBe('市场关门了');
  });

  test('DeliverToStore is a no-op for a store that is already delivered', () => {
    let s = planAndPurchase();
    s = step(s, { type: 'StartDelivery', actor: purchaser() });
    const deliver = { type: 'DeliverToStore', storeId: 'A', actor: purchaser() } as const;
    const first = decideRun(s, deliver, clock);
    expect(first.map((e) => e.type)).toEqual(['StoreDelivered']);
    s = first.reduce(applyRun, s);
    expect(decideRun(s, deliver, clock)).toEqual([]);
  });

  test('CancelRun is refused once a store has confirmed its delivery', () => {
    let s = planAndPurchase({
      storeSplits: [
        { storeId: 'A', qty: '2' },
        { storeId: 'B', qty: '2' },
      ],
    });
    s = deliver(s);
    // DLV-6 (2026-10-30): delivered but not yet confirmed is refused too —
    // recall the delivery first.
    expect(() =>
      decideRun(s, { type: 'CancelRun', reason: '', actor: purchaser() }, clock),
    ).toThrow('run.errors.cannotCancelAfterDelivery');
    s = confirmStoreAllOk(s, 'A');
    expect(() =>
      decideRun(s, { type: 'CancelRun', reason: '', actor: purchaser() }, clock),
    ).toThrow('run.errors.cannotCancelAfterConfirm');
  });

  test('CancelRun is refused on a run that is already cancelled', () => {
    let s = planAndPurchase();
    s = step(s, { type: 'CancelRun', reason: '', actor: purchaser() });
    expect(() =>
      decideRun(s, { type: 'CancelRun', reason: '', actor: purchaser() }, clock),
    ).toThrow('run.errors.runFrozen');
  });

  test('CancelRun blocked after finished', () => {
    let s = planAndPurchase();
    s = deliver(s);
    s = step(s, confirmStoreItem({ skuId: 'sku-1' }));
    s = confirmStoreAllOk(s, 'A');
    s = step(s, { type: 'FinishRun', actor: purchaser() });
    expect(() =>
      decideRun(s, { type: 'CancelRun', reason: 'oops', actor: purchaser() }, clock),
    ).toThrow('run.errors.alreadyFinished');
  });
});
