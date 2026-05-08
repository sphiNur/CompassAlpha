import { describe, expect, test } from 'bun:test';
import { applyRun, decideRun, emptyRunState } from './index';
import type { ActorCtx, RunCommand } from './commands';
import { fixedClock } from '../shared/clock';

const NOW = new Date('2026-05-01T08:00:00Z');
const clock = fixedClock(NOW);

const purchaser = (perms: string[] = ['run.create', 'run.purchase', 'delivery.dispatch', 'run.finish']): ActorCtx => ({
  userId: 'u1',
  memberId: 'm1',
  permissions: new Set(perms),
});

const confirmer = (): ActorCtx => ({
  userId: 'u2',
  memberId: 'm2',
  permissions: new Set(['delivery.confirm']),
});

function planAndPurchase(opts?: { plannedQty?: string; purchasedQty?: string; storeSplits?: Array<{ storeId: string; qty: string }> }) {
  const plannedQty = opts?.plannedQty ?? '4';
  const purchasedQty = opts?.purchasedQty ?? '4';
  const splits = opts?.storeSplits ?? [{ storeId: 'A', qty: purchasedQty }];

  let state = emptyRunState('run-1');
  const cmds: RunCommand[] = [
    {
      type: 'PlanRun',
      orgId: 'org-1',
      runDate: '2026-05-01',
      runIndex: 0,
      sessionIds: ['s1'],
      plannedItems: [{ skuId: 'sku-1', qty: plannedQty }],
      actor: purchaser(),
    },
    { type: 'StartPurchase', actor: purchaser() },
    {
      type: 'PurchaseItem',
      skuId: 'sku-1',
      supplierId: 'sup-1',
      unitPrice: '12000',
      actualQty: purchasedQty,
      receiptPhotoUrl: null,
      storeSplits: splits,
      paymentMethod: 'cash',
      actor: purchaser(),
    },
  ];
  for (const cmd of cmds) {
    const evs = decideRun(state, cmd, clock);
    for (const e of evs) state = applyRun(state, e);
  }
  return state;
}

describe('run.decide', () => {
  test('PlanRun without run.create permission throws forbidden', () => {
    const state = emptyRunState('r1');
    const noPerm: ActorCtx = { userId: 'x', memberId: 'x', permissions: new Set() };
    expect(() =>
      decideRun(state, {
        type: 'PlanRun',
        orgId: 'org',
        runDate: '2026-05-01',
        runIndex: 0,
        sessionIds: ['s1'],
        plannedItems: [{ skuId: 'k', qty: '1' }],
        actor: noPerm,
      }),
    ).toThrow('run.errors.cannotCreate');
  });

  test('PlanRun with empty sessions throws validation', () => {
    const state = emptyRunState('r1');
    expect(() =>
      decideRun(state, {
        type: 'PlanRun',
        orgId: 'org',
        runDate: '2026-05-01',
        runIndex: 0,
        sessionIds: [],
        plannedItems: [{ skuId: 'k', qty: '1' }],
        actor: purchaser(),
      }),
    ).toThrow('run.errors.noSessions');
  });

  test('PurchaseItem auto-emits PurchaseStarted on first call from planned state', () => {
    let state = emptyRunState('r1');
    state = decideRun(
      state,
      {
        type: 'PlanRun',
        orgId: 'o',
        runDate: '2026-05-01',
        runIndex: 0,
        sessionIds: ['s'],
        plannedItems: [{ skuId: 'k', qty: '1' }],
        actor: purchaser(),
      },
      clock,
    ).reduce(applyRun, state);
    expect(state.status).toBe('planned');
    const evs = decideRun(
      state,
      {
        type: 'PurchaseItem',
        skuId: 'k',
        supplierId: null,
        unitPrice: '100',
        actualQty: '1',
        receiptPhotoUrl: null,
        storeSplits: [{ storeId: 's1', qty: '1' }],
        paymentMethod: 'cash',
        actor: purchaser(),
      },
      clock,
    );
    expect(evs.map((e) => e.type)).toEqual(['PurchaseStarted', 'ItemPurchased']);
  });

  test('PurchaseItem requires storeSplits to sum exactly to actualQty', () => {
    let s = emptyRunState('r1');
    s = decideRun(
      s,
      {
        type: 'PlanRun',
        orgId: 'o',
        runDate: '2026-05-01',
        runIndex: 0,
        sessionIds: ['s'],
        plannedItems: [{ skuId: 'k', qty: '5' }],
        actor: purchaser(),
      },
      clock,
    ).reduce(applyRun, s);
    s = decideRun(s, { type: 'StartPurchase', actor: purchaser() }, clock).reduce(applyRun, s);
    expect(() =>
      decideRun(
        s,
        {
          type: 'PurchaseItem',
          skuId: 'k',
          supplierId: null,
          unitPrice: '10',
          actualQty: '5',
          receiptPhotoUrl: null,
          storeSplits: [
            { storeId: 'A', qty: '2' },
            { storeId: 'B', qty: '2' },
          ], // sums to 4, not 5
          paymentMethod: 'cash',
          actor: purchaser(),
        },
        clock,
      ),
    ).toThrow('run.errors.splitSumMismatch');
  });

  test('MarkUnavailable requires non-empty note', () => {
    let s = emptyRunState('r1');
    s = decideRun(
      s,
      {
        type: 'PlanRun',
        orgId: 'o',
        runDate: '2026-05-01',
        runIndex: 0,
        sessionIds: ['s'],
        plannedItems: [{ skuId: 'k', qty: '1' }],
        actor: purchaser(),
      },
      clock,
    ).reduce(applyRun, s);
    s = decideRun(s, { type: 'StartPurchase', actor: purchaser() }, clock).reduce(applyRun, s);
    expect(() =>
      decideRun(s, { type: 'MarkUnavailable', skuId: 'k', note: '   ', actor: purchaser() }, clock),
    ).toThrow('run.errors.unavailableNoteRequired');
  });

  test('StartDelivery requires all items handled', () => {
    let s = emptyRunState('r1');
    s = decideRun(
      s,
      {
        type: 'PlanRun',
        orgId: 'o',
        runDate: '2026-05-01',
        runIndex: 0,
        sessionIds: ['s'],
        plannedItems: [
          { skuId: 'a', qty: '1' },
          { skuId: 'b', qty: '1' },
        ],
        actor: purchaser(),
      },
      clock,
    ).reduce(applyRun, s);
    s = decideRun(s, { type: 'StartPurchase', actor: purchaser() }, clock).reduce(applyRun, s);
    s = decideRun(
      s,
      {
        type: 'PurchaseItem',
        skuId: 'a',
        supplierId: null,
        unitPrice: '1',
        actualQty: '1',
        receiptPhotoUrl: null,
        storeSplits: [{ storeId: 's1', qty: '1' }],
        paymentMethod: 'cash',
        actor: purchaser(),
      },
      clock,
    ).reduce(applyRun, s);
    // sku b still pending → StartDelivery should fail.
    expect(() => decideRun(s, { type: 'StartDelivery', actor: purchaser() }, clock)).toThrow(
      'run.errors.itemsPending',
    );
  });

  test('ConfirmStoreItem with non-ok status requires note', () => {
    let s = planAndPurchase();
    s = decideRun(s, { type: 'StartDelivery', actor: purchaser() }, clock).reduce(applyRun, s);
    s = decideRun(
      s,
      { type: 'DeliverToStore', storeId: 'A', actor: purchaser() },
      clock,
    ).reduce(applyRun, s);
    expect(() =>
      decideRun(
        s,
        {
          type: 'ConfirmStoreItem',
          storeId: 'A',
          skuId: 'sku-1',
          status: 'short',
          note: '',
          photoUrl: null,
          actor: confirmer(),
        },
        clock,
      ),
    ).toThrow('run.errors.confirmNoteRequiredOnIssue');
  });

  test('FinishRun requires all stores confirmed', () => {
    let s = planAndPurchase({
      storeSplits: [
        { storeId: 'A', qty: '2' },
        { storeId: 'B', qty: '2' },
      ],
    });
    s = decideRun(s, { type: 'StartDelivery', actor: purchaser() }, clock).reduce(applyRun, s);
    s = decideRun(s, { type: 'DeliverToStore', storeId: 'A', actor: purchaser() }, clock).reduce(applyRun, s);
    s = decideRun(s, { type: 'DeliverToStore', storeId: 'B', actor: purchaser() }, clock).reduce(applyRun, s);
    s = decideRun(
      s,
      {
        type: 'ConfirmStoreItem',
        storeId: 'A',
        skuId: 'sku-1',
        status: 'ok',
        note: null,
        photoUrl: null,
        actor: confirmer(),
      },
      clock,
    ).reduce(applyRun, s);
    s = decideRun(s, { type: 'ConfirmStore', storeId: 'A', actor: confirmer() }, clock).reduce(applyRun, s);
    // store B not yet confirmed
    expect(() => decideRun(s, { type: 'FinishRun', actor: purchaser() }, clock)).toThrow(
      'run.errors.storeNotConfirmed',
    );
  });

  test('full happy path lands in finished status', () => {
    let s = planAndPurchase({ storeSplits: [{ storeId: 'A', qty: '4' }] });
    s = decideRun(s, { type: 'StartDelivery', actor: purchaser() }, clock).reduce(applyRun, s);
    s = decideRun(s, { type: 'DeliverToStore', storeId: 'A', actor: purchaser() }, clock).reduce(applyRun, s);
    s = decideRun(
      s,
      {
        type: 'ConfirmStoreItem',
        storeId: 'A',
        skuId: 'sku-1',
        status: 'ok',
        note: null,
        photoUrl: null,
        actor: confirmer(),
      },
      clock,
    ).reduce(applyRun, s);
    s = decideRun(s, { type: 'ConfirmStore', storeId: 'A', actor: confirmer() }, clock).reduce(applyRun, s);
    s = decideRun(s, { type: 'FinishRun', actor: purchaser() }, clock).reduce(applyRun, s);
    expect(s.status).toBe('finished');
    expect(s.finishedAt).toEqual(NOW);
  });

  test('CancelRun blocked after finished', () => {
    let s = planAndPurchase();
    s = decideRun(s, { type: 'StartDelivery', actor: purchaser() }, clock).reduce(applyRun, s);
    s = decideRun(s, { type: 'DeliverToStore', storeId: 'A', actor: purchaser() }, clock).reduce(applyRun, s);
    s = decideRun(
      s,
      {
        type: 'ConfirmStoreItem',
        storeId: 'A',
        skuId: 'sku-1',
        status: 'ok',
        note: null,
        photoUrl: null,
        actor: confirmer(),
      },
      clock,
    ).reduce(applyRun, s);
    s = decideRun(s, { type: 'ConfirmStore', storeId: 'A', actor: confirmer() }, clock).reduce(applyRun, s);
    s = decideRun(s, { type: 'FinishRun', actor: purchaser() }, clock).reduce(applyRun, s);
    expect(() =>
      decideRun(s, { type: 'CancelRun', reason: 'oops', actor: purchaser() }, clock),
    ).toThrow('run.errors.alreadyFinished');
  });
});

// ----------------------------------------------------------------------
// Reversal commands — every step must be undoable until the world makes
// the action permanent (delivery accepted, run finished). These tests
// pin both the happy path AND the precondition gates that prevent
// nonsensical undos (e.g. unmarking a still-pending item).
// ----------------------------------------------------------------------
describe('run.reversals', () => {
  test('RevisePurchase updates qty/price/splits while purchasing', () => {
    let s = planAndPurchase({ purchasedQty: '4' });
    s = decideRun(
      s,
      {
        type: 'RevisePurchase',
        skuId: 'sku-1',
        supplierId: 'sup-1',
        unitPrice: '15000',
        actualQty: '5',
        receiptPhotoUrl: 'https://x/y',
        storeSplits: [{ storeId: 'A', qty: '5' }],
        reason: 'price misread on receipt',
        paymentMethod: 'cash',
        actor: purchaser(),
      },
      clock,
    ).reduce(applyRun, s);
    const item = s.items.get('sku-1')!;
    expect(item.unitPrice).toBe('15000');
    expect(item.purchasedQty).toBe('5');
    expect(item.receiptPhotoUrl).toBe('https://x/y');
    expect(item.status).toBe('purchased'); // status unchanged
  });

  test('RevisePurchase rejected on a still-pending item', () => {
    let s = emptyRunState('run-1');
    s = decideRun(
      s,
      {
        type: 'PlanRun',
        orgId: 'org-1',
        runDate: '2026-05-01',
        runIndex: 0,
        sessionIds: ['s1'],
        plannedItems: [{ skuId: 'sku-1', qty: '4' }],
        actor: purchaser(),
      },
      clock,
    ).reduce(applyRun, s);
    s = decideRun(s, { type: 'StartPurchase', actor: purchaser() }, clock).reduce(applyRun, s);
    expect(() =>
      decideRun(
        s,
        {
          type: 'RevisePurchase',
          skuId: 'sku-1',
          supplierId: null,
          unitPrice: '1',
          actualQty: '4',
          receiptPhotoUrl: null,
          storeSplits: [{ storeId: 'A', qty: '4' }],
          reason: 'x',
          paymentMethod: 'cash',
          actor: purchaser(),
        },
        clock,
      ),
    ).toThrow('run.errors.notRevisable');
  });

  test('RevisePurchase blocked once the destination store has accepted', () => {
    let s = planAndPurchase();
    s = decideRun(s, { type: 'StartDelivery', actor: purchaser() }, clock).reduce(applyRun, s);
    s = decideRun(s, { type: 'DeliverToStore', storeId: 'A', actor: purchaser() }, clock).reduce(
      applyRun,
      s,
    );
    expect(() =>
      decideRun(
        s,
        {
          type: 'RevisePurchase',
          skuId: 'sku-1',
          supplierId: null,
          unitPrice: '1',
          actualQty: '4',
          receiptPhotoUrl: null,
          storeSplits: [{ storeId: 'A', qty: '4' }],
          reason: 'x',
          paymentMethod: 'cash',
          actor: purchaser(),
        },
        clock,
      ),
    ).toThrow('run.errors.cannotReviseAfterDelivery');
  });

  test('UnmarkUnavailable flips unavailable → pending', () => {
    let s = emptyRunState('run-1');
    s = decideRun(
      s,
      {
        type: 'PlanRun',
        orgId: 'org-1',
        runDate: '2026-05-01',
        runIndex: 0,
        sessionIds: ['s1'],
        plannedItems: [{ skuId: 'sku-1', qty: '4' }],
        actor: purchaser(),
      },
      clock,
    ).reduce(applyRun, s);
    s = decideRun(s, { type: 'StartPurchase', actor: purchaser() }, clock).reduce(applyRun, s);
    s = decideRun(
      s,
      { type: 'MarkUnavailable', skuId: 'sku-1', note: 'sold out', actor: purchaser() },
      clock,
    ).reduce(applyRun, s);
    expect(s.items.get('sku-1')!.status).toBe('unavailable');
    s = decideRun(
      s,
      {
        type: 'UnmarkUnavailable',
        skuId: 'sku-1',
        reason: 'found another supplier',
        actor: purchaser(),
      },
      clock,
    ).reduce(applyRun, s);
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
    s = decideRun(s, { type: 'StartDelivery', actor: purchaser() }, clock).reduce(applyRun, s);
    s = decideRun(s, { type: 'DeliverToStore', storeId: 'A', actor: purchaser() }, clock).reduce(
      applyRun,
      s,
    );
    expect(s.stores.get('A')?.deliveredAt).not.toBeNull();
    s = decideRun(
      s,
      { type: 'UndeliverStore', storeId: 'A', reason: 'wrong store', actor: purchaser() },
      clock,
    ).reduce(applyRun, s);
    expect(s.stores.get('A')?.deliveredAt).toBeNull();
  });

  test('UndeliverStore rejected after store confirmed', () => {
    let s = planAndPurchase();
    s = decideRun(s, { type: 'StartDelivery', actor: purchaser() }, clock).reduce(applyRun, s);
    s = decideRun(s, { type: 'DeliverToStore', storeId: 'A', actor: purchaser() }, clock).reduce(
      applyRun,
      s,
    );
    s = decideRun(
      s,
      {
        type: 'ConfirmStoreItem',
        storeId: 'A',
        skuId: 'sku-1',
        status: 'ok',
        note: null,
        photoUrl: null,
        actor: confirmer(),
      },
      clock,
    ).reduce(applyRun, s);
    s = decideRun(s, { type: 'ConfirmStore', storeId: 'A', actor: confirmer() }, clock).reduce(
      applyRun,
      s,
    );
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
    s = decideRun(
      s,
      {
        type: 'PlanRun',
        orgId: 'org-1',
        runDate: '2026-05-01',
        runIndex: 0,
        sessionIds: ['s1'],
        plannedItems: [{ skuId: 'sku-1', qty: '4' }],
        actor: purchaser(),
      },
      clock,
    ).reduce(applyRun, s);
    s = decideRun(s, { type: 'StartPurchase', actor: purchaser() }, clock).reduce(applyRun, s);
    expect(s.status).toBe('purchasing');
    s = decideRun(
      s,
      { type: 'UndoStartPurchase', reason: 'tapped by mistake', actor: purchaser() },
      clock,
    ).reduce(applyRun, s);
    expect(s.status).toBe('planned');
  });

  test('UndoStartPurchase blocked once any item has been touched', () => {
    const s = planAndPurchase();
    expect(() =>
      decideRun(s, { type: 'UndoStartPurchase', reason: 'x', actor: purchaser() }, clock),
    ).toThrow('run.errors.purchaseAlreadyProgressed');
  });

  test('UndoStartDelivery reverts to purchasing when no store has been delivered to', () => {
    let s = planAndPurchase();
    s = decideRun(s, { type: 'StartDelivery', actor: purchaser() }, clock).reduce(applyRun, s);
    expect(s.status).toBe('delivering');
    s = decideRun(
      s,
      { type: 'UndoStartDelivery', reason: 'forgot to mark a SKU', actor: purchaser() },
      clock,
    ).reduce(applyRun, s);
    expect(s.status).toBe('purchasing');
  });

  test('UndoStartDelivery blocked after first store delivered', () => {
    let s = planAndPurchase();
    s = decideRun(s, { type: 'StartDelivery', actor: purchaser() }, clock).reduce(applyRun, s);
    s = decideRun(s, { type: 'DeliverToStore', storeId: 'A', actor: purchaser() }, clock).reduce(
      applyRun,
      s,
    );
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
    s = decideRun(s, { type: 'StartDelivery', actor: purchaser() }, clock).reduce(applyRun, s);
    s = decideRun(s, { type: 'DeliverToStore', storeId: 'A', actor: purchaser() }, clock).reduce(
      applyRun,
      s,
    );
    s = decideRun(
      s,
      {
        type: 'ConfirmStoreItem',
        storeId: 'A',
        skuId: 'sku-1',
        status: 'ok',
        note: null,
        photoUrl: null,
        actor: confirmer(),
      },
      clock,
    ).reduce(applyRun, s);
    const dup = decideRun(
      s,
      {
        type: 'ConfirmStoreItem',
        storeId: 'A',
        skuId: 'sku-1',
        status: 'ok',
        note: null,
        photoUrl: null,
        actor: confirmer(),
      },
      clock,
    );
    expect(dup).toEqual([]);
  });

  test('ConfirmStoreItem with different status emits a new event (issue overrides ok)', () => {
    // Going from "ok" to "short" is a real change and SHOULD append.
    let s = planAndPurchase();
    s = decideRun(s, { type: 'StartDelivery', actor: purchaser() }, clock).reduce(applyRun, s);
    s = decideRun(s, { type: 'DeliverToStore', storeId: 'A', actor: purchaser() }, clock).reduce(
      applyRun,
      s,
    );
    s = decideRun(
      s,
      {
        type: 'ConfirmStoreItem',
        storeId: 'A',
        skuId: 'sku-1',
        status: 'ok',
        note: null,
        photoUrl: null,
        actor: confirmer(),
      },
      clock,
    ).reduce(applyRun, s);
    const next = decideRun(
      s,
      {
        type: 'ConfirmStoreItem',
        storeId: 'A',
        skuId: 'sku-1',
        status: 'short',
        note: 'one bag missing',
        photoUrl: null,
        actor: confirmer(),
      },
      clock,
    );
    expect(next.length).toBe(1);
    expect(next[0]!.type).toBe('StoreItemConfirmed');
  });

  test('ConfirmStore second tap is a no-op (already confirmed)', () => {
    // The user reported tapping "Confirm store" 5 times — log showed
    // 5 StoreConfirmed events. Now the second decide returns [].
    let s = planAndPurchase();
    s = decideRun(s, { type: 'StartDelivery', actor: purchaser() }, clock).reduce(applyRun, s);
    s = decideRun(s, { type: 'DeliverToStore', storeId: 'A', actor: purchaser() }, clock).reduce(
      applyRun,
      s,
    );
    s = decideRun(
      s,
      {
        type: 'ConfirmStoreItem',
        storeId: 'A',
        skuId: 'sku-1',
        status: 'ok',
        note: null,
        photoUrl: null,
        actor: confirmer(),
      },
      clock,
    ).reduce(applyRun, s);
    s = decideRun(s, { type: 'ConfirmStore', storeId: 'A', actor: confirmer() }, clock).reduce(
      applyRun,
      s,
    );
    const dup = decideRun(s, { type: 'ConfirmStore', storeId: 'A', actor: confirmer() }, clock);
    expect(dup).toEqual([]);
  });

  test('UndoPurchase reverts a purchased item back to pending', () => {
    let s = planAndPurchase();
    expect(s.items.get('sku-1')!.status).toBe('purchased');
    s = decideRun(
      s,
      { type: 'UndoPurchase', skuId: 'sku-1', reason: 'mistapped wrong row', actor: purchaser() },
      clock,
    ).reduce(applyRun, s);
    const item = s.items.get('sku-1')!;
    expect(item.status).toBe('pending');
    expect(item.purchasedQty).toBeNull();
    expect(item.unitPrice).toBeNull();
    expect(item.storeSplits).toEqual([]);
  });

  test('UndoPurchase rejected on a still-pending item', () => {
    let s = emptyRunState('run-1');
    s = decideRun(
      s,
      {
        type: 'PlanRun',
        orgId: 'org-1',
        runDate: '2026-05-01',
        runIndex: 0,
        sessionIds: ['s1'],
        plannedItems: [{ skuId: 'sku-1', qty: '4' }],
        actor: purchaser(),
      },
      clock,
    ).reduce(applyRun, s);
    s = decideRun(s, { type: 'StartPurchase', actor: purchaser() }, clock).reduce(applyRun, s);
    expect(() =>
      decideRun(
        s,
        { type: 'UndoPurchase', skuId: 'sku-1', reason: 'x', actor: purchaser() },
        clock,
      ),
    ).toThrow('run.errors.notPurchased');
  });

  test('UndoPurchase blocked after store has accepted delivery', () => {
    let s = planAndPurchase();
    s = decideRun(s, { type: 'StartDelivery', actor: purchaser() }, clock).reduce(applyRun, s);
    s = decideRun(s, { type: 'DeliverToStore', storeId: 'A', actor: purchaser() }, clock).reduce(
      applyRun,
      s,
    );
    expect(() =>
      decideRun(
        s,
        { type: 'UndoPurchase', skuId: 'sku-1', reason: 'too late', actor: purchaser() },
        clock,
      ),
    ).toThrow('run.errors.cannotReviseAfterDelivery');
  });

  test('all reversal commands require a non-empty reason', () => {
    let s = planAndPurchase();
    expect(() =>
      decideRun(
        s,
        {
          type: 'RevisePurchase',
          skuId: 'sku-1',
          supplierId: null,
          unitPrice: '1',
          actualQty: '4',
          receiptPhotoUrl: null,
          storeSplits: [{ storeId: 'A', qty: '4' }],
          reason: '   ',
          paymentMethod: 'cash',
          actor: purchaser(),
        },
        clock,
      ),
    ).toThrow('run.errors.reviseReasonRequired');

    s = decideRun(s, { type: 'StartDelivery', actor: purchaser() }, clock).reduce(applyRun, s);
    s = decideRun(s, { type: 'DeliverToStore', storeId: 'A', actor: purchaser() }, clock).reduce(
      applyRun,
      s,
    );
    expect(() =>
      decideRun(
        s,
        { type: 'UndeliverStore', storeId: 'A', reason: '', actor: purchaser() },
        clock,
      ),
    ).toThrow('run.errors.recallReasonRequired');
  });
});

// ----------------------------------------------------------------------
// M1.14 (2026-05-08): payment-method mixing on a single run.
// Real-world driver: same market trip pays Apple in cash at the stall
// and wires Beef to the meat supplier. RunFinished must split the
// totals so the chain owner can reconcile petty cash vs bank wires.
// ----------------------------------------------------------------------
describe('run.paymentMethod', () => {
  function planTwoSkus(): import('./state').RunState {
    let s = emptyRunState('run-1');
    s = decideRun(
      s,
      {
        type: 'PlanRun',
        orgId: 'org-1',
        runDate: '2026-05-01',
        runIndex: 0,
        sessionIds: ['s1'],
        plannedItems: [
          { skuId: 'apple', qty: '3' },
          { skuId: 'beef', qty: '2' },
        ],
        actor: purchaser(),
      },
      clock,
    ).reduce(applyRun, s);
    s = decideRun(s, { type: 'StartPurchase', actor: purchaser() }, clock).reduce(applyRun, s);
    return s;
  }

  test('PurchaseItem records paymentMethod on the event payload', () => {
    let s = planTwoSkus();
    const evs = decideRun(
      s,
      {
        type: 'PurchaseItem',
        skuId: 'apple',
        supplierId: null,
        unitPrice: '1000',
        actualQty: '3',
        receiptPhotoUrl: null,
        storeSplits: [{ storeId: 'A', qty: '3' }],
        paymentMethod: 'cash',
        actor: purchaser(),
      },
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
    s = decideRun(
      s,
      {
        type: 'PurchaseItem',
        skuId: 'apple',
        supplierId: null,
        unitPrice: '1000',
        actualQty: '3',
        receiptPhotoUrl: null,
        storeSplits: [{ storeId: 'A', qty: '3' }],
        paymentMethod: 'cash',
        actor: purchaser(),
      },
      clock,
    ).reduce(applyRun, s);
    s = decideRun(
      s,
      {
        type: 'PurchaseItem',
        skuId: 'beef',
        supplierId: null,
        unitPrice: '50000',
        actualQty: '2',
        receiptPhotoUrl: null,
        storeSplits: [{ storeId: 'A', qty: '2' }],
        paymentMethod: 'transfer',
        actor: purchaser(),
      },
      clock,
    ).reduce(applyRun, s);
    s = decideRun(s, { type: 'StartDelivery', actor: purchaser() }, clock).reduce(applyRun, s);
    s = decideRun(s, { type: 'DeliverToStore', storeId: 'A', actor: purchaser() }, clock).reduce(
      applyRun,
      s,
    );
    s = decideRun(
      s,
      {
        type: 'ConfirmStoreItem',
        storeId: 'A',
        skuId: 'apple',
        status: 'ok',
        note: null,
        photoUrl: null,
        actor: confirmer(),
      },
      clock,
    ).reduce(applyRun, s);
    s = decideRun(
      s,
      {
        type: 'ConfirmStoreItem',
        storeId: 'A',
        skuId: 'beef',
        status: 'ok',
        note: null,
        photoUrl: null,
        actor: confirmer(),
      },
      clock,
    ).reduce(applyRun, s);
    s = decideRun(s, { type: 'ConfirmStore', storeId: 'A', actor: confirmer() }, clock).reduce(
      applyRun,
      s,
    );
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
    s = decideRun(
      s,
      {
        type: 'PurchaseItem',
        skuId: 'apple',
        supplierId: null,
        unitPrice: '1000',
        actualQty: '3',
        receiptPhotoUrl: null,
        storeSplits: [{ storeId: 'A', qty: '3' }],
        paymentMethod: 'cash',
        actor: purchaser(),
      },
      clock,
    ).reduce(applyRun, s);
    s = decideRun(
      s,
      {
        type: 'RevisePurchase',
        skuId: 'apple',
        supplierId: null,
        unitPrice: '1000',
        actualQty: '3',
        receiptPhotoUrl: null,
        storeSplits: [{ storeId: 'A', qty: '3' }],
        reason: 'paid by wire after all',
        paymentMethod: 'transfer',
        actor: purchaser(),
      },
      clock,
    ).reduce(applyRun, s);
    expect(s.items.get('apple')!.paymentMethod).toBe('transfer');
  });

  test('PurchaseUndone clears paymentMethod so re-purchase records a fresh choice', () => {
    let s = planTwoSkus();
    s = decideRun(
      s,
      {
        type: 'PurchaseItem',
        skuId: 'apple',
        supplierId: null,
        unitPrice: '1000',
        actualQty: '3',
        receiptPhotoUrl: null,
        storeSplits: [{ storeId: 'A', qty: '3' }],
        paymentMethod: 'transfer',
        actor: purchaser(),
      },
      clock,
    ).reduce(applyRun, s);
    s = decideRun(
      s,
      { type: 'UndoPurchase', skuId: 'apple', reason: 'mistapped row', actor: purchaser() },
      clock,
    ).reduce(applyRun, s);
    expect(s.items.get('apple')!.paymentMethod).toBeNull();
    expect(s.items.get('apple')!.status).toBe('pending');
  });
});
