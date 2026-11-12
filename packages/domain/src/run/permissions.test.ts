/**
 * Review TEST4-22 (2026-11): every permission gate of the run decider, one
 * row each. An actor holding every permission the decider reads except the
 * one a command needs is refused with FORBIDDEN and that command's key; the
 * same command, in the same state, goes through for an actor holding only
 * that permission. Deleting or mistyping a `permissions.has(...)` fails here.
 *
 * The table is keyed by command type, so a new command does not compile
 * until it has a row.
 */
import { describe, expect, test } from 'bun:test';
import { fixedClock } from '../shared/clock';
import { DomainError } from '../shared/errors';
import { applyRun, decideRun, emptyRunState } from './index';
import type { ActorCtx, RunCommand, RunEvent, RunState } from './index';

const clock = fixedClock(new Date('2026-05-01T08:00:00Z'));

/** Every permission the run decider reads. */
const ALL = [
  'run.create',
  'run.create.org',
  'run.purchase',
  'delivery.dispatch',
  'delivery.confirm',
  'run.finish',
  'run.amend',
  'run.eject_session',
] as const;

function actor(permissions: Iterable<string>, memberId = 'm-actor'): ActorCtx {
  return { userId: `u-${memberId}`, memberId, permissions: new Set(permissions) };
}

type Type = RunCommand['type'];
type Command<T extends Type> = Extract<RunCommand, { type: T }>;
type Step = (by: ActorCtx) => RunCommand;

/** The state after an actor who may do everything takes these steps. */
function after(state: RunState, ...steps: Step[]): RunState {
  const boss = actor(ALL, 'm-boss');
  return steps.reduce((s, step) => decideRun(s, step(boss), clock).reduce(applyRun, s), state);
}

/** The DomainError a call throws, as code and key; null when it goes through. */
function refusalOf(call: () => unknown): { code: string; key: string } | null {
  try {
    call();
    return null;
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return { code: error.code, key: error.i18nKey };
  }
}

// ---- Commands ---------------------------------------------------------

const plan = (by: ActorCtx): Command<'PlanRun'> => ({
  type: 'PlanRun',
  orgId: 'org-1',
  runDate: '2026-05-01',
  today: '2026-05-01',
  runIndex: 0,
  sessionIds: ['s1', 's2'],
  plannedItems: [
    { skuId: 'a', qty: '2' },
    { skuId: 'b', qty: '1' },
  ],
  actor: by,
});

const buy =
  (skuId: string, qty: string) =>
  (by: ActorCtx): Command<'PurchaseItem'> => ({
    type: 'PurchaseItem',
    skuId,
    supplierId: 'sup-1',
    unitPrice: '12000',
    actualQty: qty,
    receiptPhotoUrl: null,
    storeSplits: [{ storeId: 'A', qty }],
    paymentMethod: 'cash',
    actor: by,
  });

const addItem =
  (skuId: string) =>
  (by: ActorCtx): Command<'AddPurchaserItem'> => ({
    type: 'AddPurchaserItem',
    skuId,
    supplierId: null,
    unitPrice: '3000',
    actualQty: '1',
    receiptPhotoUrl: null,
    storeSplits: [{ storeId: 'A', qty: '1' }],
    paymentMethod: 'cash',
    reason: 'bags for the meat',
    actor: by,
  });

const markUnavailable =
  (skuId: string) =>
  (by: ActorCtx): Command<'MarkUnavailable'> => ({
    type: 'MarkUnavailable',
    skuId,
    note: 'sold out',
    actor: by,
  });

const unmark =
  (skuId: string) =>
  (by: ActorCtx): Command<'UnmarkUnavailable'> => ({
    type: 'UnmarkUnavailable',
    skuId,
    reason: 'back in stock',
    actor: by,
  });

const addExpense =
  (expenseId: string) =>
  (by: ActorCtx): Command<'AddRunExpense'> => ({
    type: 'AddRunExpense',
    expenseId,
    label: 'Porter',
    qty: '1',
    unitPrice: '5000',
    storeSplits: [{ storeId: 'A', qty: '1' }],
    paymentMethod: 'cash',
    receiptPhotoUrl: null,
    reason: 'carried the boxes',
    actor: by,
  });

const removeExpense =
  (expenseId: string) =>
  (by: ActorCtx): Command<'RemoveRunExpense'> => ({
    type: 'RemoveRunExpense',
    expenseId,
    reason: 'counted twice',
    actor: by,
  });

const attach =
  (sessionId: string, skuId: string) =>
  (by: ActorCtx): Command<'AttachSessions'> => ({
    type: 'AttachSessions',
    sessionIds: [sessionId],
    addedPlannedItems: [{ skuId, qty: '1' }],
    actor: by,
  });

const reviseA = (by: ActorCtx): Command<'RevisePurchase'> => ({
  type: 'RevisePurchase',
  skuId: 'a',
  supplierId: 'sup-1',
  unitPrice: '12500',
  actualQty: '2',
  receiptPhotoUrl: null,
  storeSplits: [{ storeId: 'A', qty: '2' }],
  reason: 'typed the wrong price',
  paymentMethod: 'cash',
  actor: by,
});

const undoA = (by: ActorCtx): Command<'UndoPurchase'> => ({
  type: 'UndoPurchase',
  skuId: 'a',
  actor: by,
});

const dismissA = (by: ActorCtx): Command<'DismissTopUp'> => ({
  type: 'DismissTopUp',
  skuId: 'a',
  actor: by,
});

const deliverA = (by: ActorCtx): Command<'DeliverToStore'> => ({
  type: 'DeliverToStore',
  storeId: 'A',
  actor: by,
});

const checkA = (by: ActorCtx): Command<'ConfirmStoreItem'> => ({
  type: 'ConfirmStoreItem',
  storeId: 'A',
  skuId: 'a',
  status: 'ok',
  note: null,
  photoUrl: null,
  actor: by,
});

// ---- One run through its life -------------------------------------------
// Sessions s1 and s2 ask for a (2) and b (1). An expense e1 is recorded,
// a is bought for store A, b is marked unavailable.

const absent = emptyRunState('run-permissions');
const planned = after(absent, plan);
const purchasing = after(planned, (by) => ({ type: 'StartPurchase', actor: by }));
const withExpense = after(purchasing, addExpense('e1'));
const bought = after(withExpense, buy('a', '2'), markUnavailable('b'));
/** Session s3 asks for one more a after it was bought. */
const toppedUp = after(bought, attach('s3', 'a'));
const delivering = after(bought, (by) => ({ type: 'StartDelivery', actor: by }));
const delivered = after(delivering, deliverA);
const checked = after(delivered, checkA);
const confirmed = after(checked, (by) => ({ type: 'ConfirmStore', storeId: 'A', actor: by }));
const finished = after(confirmed, (by) => ({ type: 'FinishRun', actor: by }));
const amending = after(finished, (by) => ({ type: 'ReopenRun', reason: 'wrong price', actor: by }));
const amendingWithPending = after(amending, unmark('b'));
const claimedByOther = after(planned, () => ({
  type: 'ClaimRun',
  actor: actor(['run.purchase'], 'm-other'),
}));

// ---- The gates ------------------------------------------------------------

interface Gate<T extends Type> {
  /** Told apart from the command's other gates in the test name. */
  when?: string;
  /** A state in which the command goes through for a holder. */
  state: RunState;
  /** Any one of these lets the actor through. */
  needs: readonly string[];
  /** Also needed on this path; held by both actors of the row. */
  alsoNeeds?: readonly string[];
  /** What an actor holding none of `needs` is told. */
  refusal: string;
  command: (by: ActorCtx) => Command<T>;
  /** The events a holder's command produces. */
  gives: readonly RunEvent['type'][];
}

const PURCHASE = { needs: ['run.purchase'], refusal: 'run.errors.cannotPurchase' } as const;
const DISPATCH = { needs: ['delivery.dispatch'], refusal: 'run.errors.cannotDispatch' } as const;
const CONFIRM = { needs: ['delivery.confirm'], refusal: 'run.errors.cannotConfirm' } as const;
const AMEND = { needs: ['run.amend'], refusal: 'run.errors.cannotAmend' } as const;
/** A finished run reopened for correction: the edits also need run.amend. */
const AMENDING = {
  ...AMEND,
  when: 'amending a finished run',
  alsoNeeds: ['run.purchase'],
} as const;

const GATES: { [T in Type]: Gate<T>[] } = {
  PlanRun: [
    {
      state: absent,
      needs: ['run.create'],
      refusal: 'run.errors.cannotCreate',
      command: plan,
      gives: ['RunPlanned'],
    },
  ],
  StartPurchase: [
    {
      ...PURCHASE,
      state: planned,
      command: (by) => ({ type: 'StartPurchase', actor: by }),
      gives: ['PurchaseStarted'],
    },
  ],
  PurchaseItem: [
    { ...PURCHASE, state: purchasing, command: buy('a', '2'), gives: ['ItemPurchased'] },
  ],
  AddPurchaserItem: [
    { ...PURCHASE, state: purchasing, command: addItem('c'), gives: ['PurchaserItemAdded'] },
  ],
  AddRunExpense: [
    { ...PURCHASE, state: purchasing, command: addExpense('e2'), gives: ['RunExpenseAdded'] },
    { ...AMENDING, state: amending, command: addExpense('e2'), gives: ['RunExpenseAdded'] },
  ],
  RemoveRunExpense: [
    { ...PURCHASE, state: withExpense, command: removeExpense('e1'), gives: ['RunExpenseRemoved'] },
    { ...AMENDING, state: amending, command: removeExpense('e1'), gives: ['RunExpenseRemoved'] },
  ],
  MarkUnavailable: [
    { ...PURCHASE, state: purchasing, command: markUnavailable('a'), gives: ['ItemUnavailable'] },
    {
      ...AMENDING,
      state: amendingWithPending,
      command: markUnavailable('b'),
      gives: ['ItemUnavailable'],
    },
  ],
  UnmarkUnavailable: [
    { ...PURCHASE, state: bought, command: unmark('b'), gives: ['UnavailableUndone'] },
    { ...AMENDING, state: amending, command: unmark('b'), gives: ['UnavailableUndone'] },
  ],
  RevisePurchase: [
    { ...PURCHASE, state: bought, command: reviseA, gives: ['PurchaseRevised'] },
    { ...AMENDING, state: amending, command: reviseA, gives: ['PurchaseRevised'] },
  ],
  UndoPurchase: [
    { ...PURCHASE, state: bought, command: undoA, gives: ['PurchaseUndone'] },
    { ...AMENDING, state: amending, command: undoA, gives: ['PurchaseUndone'] },
  ],
  DismissTopUp: [
    { ...PURCHASE, state: toppedUp, command: dismissA, gives: ['TopUpDismissed'] },
    // A finished run has no top-up left (StartDelivery refuses one), so a
    // holder has nothing to dismiss; the gate still comes first.
    { ...AMENDING, state: amending, command: dismissA, gives: [] },
  ],
  StartDelivery: [
    {
      ...PURCHASE,
      state: bought,
      command: (by) => ({ type: 'StartDelivery', actor: by }),
      gives: ['DeliveryStarted'],
    },
  ],
  UndoStartPurchase: [
    {
      ...PURCHASE,
      state: purchasing,
      command: (by) => ({ type: 'UndoStartPurchase', reason: 'plan again', actor: by }),
      gives: ['PurchaseStartUndone'],
    },
  ],
  ClaimRun: [
    {
      ...PURCHASE,
      state: planned,
      command: (by) => ({ type: 'ClaimRun', actor: by }),
      gives: ['RunClaimed'],
    },
  ],
  ReleaseRunClaim: [
    {
      ...PURCHASE,
      when: "someone else's claim",
      state: claimedByOther,
      command: (by) => ({ type: 'ReleaseRunClaim', reason: 'manual', actor: by }),
      gives: ['RunClaimReleased'],
    },
  ],
  DeliverToStore: [
    { ...DISPATCH, state: delivering, command: deliverA, gives: ['StoreDelivered'] },
  ],
  UndeliverStore: [
    {
      ...DISPATCH,
      state: delivered,
      command: (by) => ({ type: 'UndeliverStore', storeId: 'A', reason: 'wrong van', actor: by }),
      gives: ['StoreDeliveryUndone'],
    },
  ],
  UndoStartDelivery: [
    {
      ...DISPATCH,
      state: delivering,
      command: (by) => ({ type: 'UndoStartDelivery', reason: 'not loaded yet', actor: by }),
      gives: ['DeliveryStartUndone'],
    },
  ],
  ConfirmStoreItem: [
    { ...CONFIRM, state: delivered, command: checkA, gives: ['StoreItemConfirmed'] },
  ],
  ConfirmStoreItemsOk: [
    {
      ...CONFIRM,
      state: delivered,
      command: (by) => ({ type: 'ConfirmStoreItemsOk', storeId: 'A', skuIds: ['a'], actor: by }),
      gives: ['StoreItemConfirmed'],
    },
  ],
  ConfirmStore: [
    {
      ...CONFIRM,
      state: checked,
      command: (by) => ({ type: 'ConfirmStore', storeId: 'A', actor: by }),
      gives: ['StoreConfirmed'],
    },
  ],
  FinishRun: [
    {
      state: confirmed,
      needs: ['run.finish'],
      refusal: 'run.errors.cannotFinish',
      command: (by) => ({ type: 'FinishRun', actor: by }),
      gives: ['RunFinished'],
    },
  ],
  CancelRun: [
    {
      state: purchasing,
      needs: ['run.create'],
      refusal: 'run.errors.cannotCancel',
      command: (by) => ({ type: 'CancelRun', reason: '', actor: by }),
      gives: ['RunCancelled'],
    },
  ],
  ReopenRun: [
    {
      ...AMEND,
      state: finished,
      command: (by) => ({ type: 'ReopenRun', reason: 'wrong price', actor: by }),
      gives: ['RunReopened'],
    },
  ],
  ChangeRunDate: [
    {
      ...AMEND,
      state: finished,
      command: (by) => ({
        type: 'ChangeRunDate',
        runDate: '2026-05-02',
        today: '2026-05-02',
        actor: by,
      }),
      gives: ['RunDateChanged'],
    },
  ],
  RefinalizeRun: [
    {
      ...AMEND,
      state: amending,
      command: (by) => ({ type: 'RefinalizeRun', actor: by }),
      gives: ['RunRefinalized'],
    },
  ],
  AttachSessions: [
    {
      state: purchasing,
      needs: ['run.create', 'run.create.org'],
      refusal: 'run.errors.cannotPlan',
      command: attach('s3', 'c'),
      gives: ['SessionsAttachedToRun'],
    },
  ],
  EjectSession: [
    {
      state: planned,
      needs: ['run.eject_session'],
      refusal: 'run.errors.cannotEjectSession',
      command: (by) => ({
        type: 'EjectSession',
        sessionId: 's2',
        removedPlannedItems: [{ skuId: 'b', qty: '1' }],
        actor: by,
      }),
      gives: ['SessionEjectedFromRun'],
    },
  ],
};

const gatesOf = <T extends Type>(type: T): readonly Gate<T>[] => GATES[type];

describe('run permission gates', () => {
  for (const type of Object.keys(GATES) as Type[]) {
    for (const gate of gatesOf(type)) {
      const also = gate.alsoNeeds ?? [];
      describe(gate.when ? `${type}, ${gate.when}` : type, () => {
        test(`everything but ${gate.needs.join(' / ')} → ${gate.refusal}`, () => {
          const by = actor(ALL.filter((p) => !gate.needs.includes(p)));
          expect(refusalOf(() => decideRun(gate.state, gate.command(by), clock))).toEqual({
            code: 'FORBIDDEN',
            key: gate.refusal,
          });
        });

        for (const needed of gate.needs) {
          test(`${[needed, ...also].join(' + ')} alone → ${gate.gives.join(', ') || 'no event'}`, () => {
            const by = actor([needed, ...also]);
            const events = decideRun(gate.state, gate.command(by), clock);
            expect(events.map((e) => e.type)).toEqual([...gate.gives]);
          });
        }
      });
    }
  }
});

describe('gates that are more than one permission check', () => {
  test('ReleaseRunClaim: letting go of your own claim needs no permission', () => {
    const mine = after(planned, () => ({ type: 'ClaimRun', actor: actor(['run.purchase']) }));
    const events = decideRun(
      mine,
      { type: 'ReleaseRunClaim', reason: 'pagehide', actor: actor([]) },
      clock,
    );
    expect(events.map((e) => [e.type, e.payload])).toEqual([
      ['RunClaimReleased', { byMemberId: 'm-actor', reason: 'pagehide' }],
    ]);
  });

  // PurchaseItem and AddPurchaserItem fold run.amend into their phase
  // gate, so a purchaser without it is told the run is frozen, where the
  // other edit commands answer cannotAmend (see the table).
  test('buying into an amending run also needs run.amend (answered as runFrozen)', () => {
    const purchaserOnly = actor(ALL.filter((p) => p !== 'run.amend'));
    const amender = actor(['run.purchase', 'run.amend']);
    for (const command of [buy('b', '1'), addItem('c')]) {
      expect(
        refusalOf(() => decideRun(amendingWithPending, command(purchaserOnly), clock)),
      ).toEqual({
        code: 'PRECONDITION_FAILED',
        key: 'run.errors.runFrozen',
      });
    }
    expect(
      decideRun(amendingWithPending, buy('b', '1')(amender), clock).map((e) => e.type),
    ).toEqual(['ItemPurchased']);
    expect(decideRun(amendingWithPending, addItem('c')(amender), clock).map((e) => e.type)).toEqual(
      ['PurchaserItemAdded'],
    );
  });
});
