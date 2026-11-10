/**
 * Builders for tests of the order and run aggregates: the domain's own
 * and the API's pure ones (review TEST4-02, TEST4-03, 2026-11). For tests
 * only: nothing here checks what a router checks before it decides.
 *
 * A stepper decides each command at its clock and applies the events it
 * emits, as a router does before it appends them. The actors and command
 * builders fill in what a test does not care about with the values most
 * tests used, so a test names only the fields it is about.
 */
import { fixedClock, type Clock } from './shared/clock';
import {
  apply,
  decide,
  type ActorCtx as OrderActor,
  type OrderCommand,
  type OrderEvent,
  type OrderState,
  type SkuCtx,
} from './order/index';
import {
  applyRun,
  decideRun,
  emptyRunState,
  type ActorCtx as RunActor,
  type RunCommand,
  type RunEvent,
  type RunState,
} from './run/index';

export interface Stepper<State, Command, Event> {
  /** `state` after `command`: decided, then each event it emits applied. */
  step(state: State, command: Command): State;
  /** `commands` in turn from `state`: the state they end in and the events they emitted. */
  steps(state: State, commands: Iterable<Command>): { state: State; events: Event[] };
}

function stepper<State, Command, Event>(
  decideOne: (state: State, command: Command) => Event[],
  applyOne: (state: State, event: Event) => State,
): Stepper<State, Command, Event> {
  return {
    step: (state, command) => decideOne(state, command).reduce(applyOne, state),
    steps(state, commands) {
      const events: Event[] = [];
      for (const command of commands) {
        for (const event of decideOne(state, command)) {
          state = applyOne(state, event);
          events.push(event);
        }
      }
      return { state, events };
    },
  };
}

// ---------- orders

/** Order commands decided at `clock`. */
export function orderStepper(clock: Clock): Stepper<OrderState, OrderCommand, OrderEvent> {
  return stepper((state, command) => decide(state, command, { clock }), apply);
}

/** Member `memberId` (user `user-<memberId>`) acting on an order it has not claimed. */
export function orderActor(memberId: string, permissions: Iterable<string>): OrderActor {
  return {
    userId: `user-${memberId}`,
    memberId,
    permissions: new Set(permissions),
    isClaimer: false,
  };
}

/** Store staff: drafts and submits unless told otherwise. */
export function staff(
  permissions: Iterable<string> = ['order.draft', 'order.submit'],
  memberId = 'mem-staff-a',
): OrderActor {
  return orderActor(memberId, permissions);
}

/** A reviewer: claims and approves unless told otherwise. */
export function manager(
  permissions: Iterable<string> = ['order.claim', 'order.approve'],
  memberId = 'mem-mgr',
): OrderActor {
  return orderActor(memberId, permissions);
}

/** A product sold by the kg in steps of `step`, not archived. */
export function sku(id: string, step = '0.5'): SkuCtx {
  return { id, step, unit: 'kg', isArchived: false };
}

// ---------- runs

/** When the run tests decide: 08:00 UTC on the day `planRun` plans for. */
export const RUN_NOW = new Date('2026-05-01T08:00:00Z');

/** Run commands decided at `clock` (default `RUN_NOW`). */
export function runStepper(
  clock: Clock = fixedClock(RUN_NOW),
): Stepper<RunState, RunCommand, RunEvent> {
  return stepper((state, command) => decideRun(state, command, clock), applyRun);
}

/** Member `memberId` acting on a run; the user id is the member id unless given. */
export function runActor(
  memberId: string,
  permissions: Iterable<string>,
  userId = memberId,
): RunActor {
  return { userId, memberId, permissions: new Set(permissions) };
}

/** The purchaser m1 (user u1): plans, buys, dispatches and finishes unless told otherwise. */
export function purchaser(
  permissions: Iterable<string> = ['run.create', 'run.purchase', 'delivery.dispatch', 'run.finish'],
): RunActor {
  return runActor('m1', permissions, 'u1');
}

/** The receiver m2 (user u2), who confirms what reaches a store. */
export function confirmer(): RunActor {
  return runActor('m2', ['delivery.confirm'], 'u2');
}

type RunCommandOf<T extends RunCommand['type']> = Extract<RunCommand, { type: T }>;
/** The fields of command `T`: `Named` must be given, the rest may be. */
type FieldsOf<T extends RunCommand['type'], Named extends keyof RunCommandOf<T>> = Pick<
  RunCommandOf<T>,
  Named
> &
  Partial<Omit<RunCommandOf<T>, 'type' | Named>>;

/** PlanRun for 2026-05-01, index 0, from session s1 of org-1, by the purchaser. */
export function planRun(fields: FieldsOf<'PlanRun', 'plannedItems'>): RunCommandOf<'PlanRun'> {
  return {
    type: 'PlanRun',
    orgId: 'org-1',
    runDate: '2026-05-01',
    runIndex: 0,
    sessionIds: ['s1'],
    actor: purchaser(),
    ...fields,
  };
}

/** PurchaseItem paid in cash, with no supplier or receipt, all for store A, by the purchaser. */
export function purchaseItem(
  fields: FieldsOf<'PurchaseItem', 'skuId' | 'unitPrice' | 'actualQty'>,
): RunCommandOf<'PurchaseItem'> {
  return {
    type: 'PurchaseItem',
    supplierId: null,
    receiptPhotoUrl: null,
    storeSplits: [{ storeId: 'A', qty: fields.actualQty }],
    paymentMethod: 'cash',
    actor: purchaser(),
    ...fields,
  };
}

/** RevisePurchase on the same terms as `purchaseItem`, for the reason "x". */
export function revisePurchase(
  fields: FieldsOf<'RevisePurchase', 'skuId' | 'unitPrice' | 'actualQty'>,
): RunCommandOf<'RevisePurchase'> {
  return {
    type: 'RevisePurchase',
    supplierId: null,
    receiptPhotoUrl: null,
    storeSplits: [{ storeId: 'A', qty: fields.actualQty }],
    reason: 'x',
    paymentMethod: 'cash',
    actor: purchaser(),
    ...fields,
  };
}

/** ConfirmStoreItem: the line reached store A in full, as the confirmer says. */
export function confirmStoreItem(
  fields: FieldsOf<'ConfirmStoreItem', 'skuId'>,
): RunCommandOf<'ConfirmStoreItem'> {
  return {
    type: 'ConfirmStoreItem',
    storeId: 'A',
    status: 'ok',
    note: null,
    photoUrl: null,
    actor: confirmer(),
    ...fields,
  };
}

/**
 * Run run-1, planned with `plannedQty` (default 4) of sku-1 and bought:
 * `purchasedQty` (default 4) at 12000 in cash from sup-1, all for store A
 * unless `storeSplits` says otherwise.
 */
export function planAndPurchase(opts?: {
  plannedQty?: string;
  purchasedQty?: string;
  storeSplits?: Array<{
    storeId: string;
    qty: string;
    unitPrice?: string;
    paymentMethod?: 'cash' | 'transfer';
  }>;
}): RunState {
  const purchasedQty = opts?.purchasedQty ?? '4';
  return runStepper().steps(emptyRunState('run-1'), [
    planRun({ plannedItems: [{ skuId: 'sku-1', qty: opts?.plannedQty ?? '4' }] }),
    { type: 'StartPurchase', actor: purchaser() },
    purchaseItem({
      skuId: 'sku-1',
      supplierId: 'sup-1',
      unitPrice: '12000',
      actualQty: purchasedQty,
      storeSplits: opts?.storeSplits ?? [{ storeId: 'A', qty: purchasedQty }],
    }),
  ]).state;
}

/** StartDelivery, then DeliverToStore to each of `storeIds` (default A), by the purchaser. */
export function deliver(state: RunState, storeIds: readonly string[] = ['A']): RunState {
  return runStepper().steps(state, [
    { type: 'StartDelivery', actor: purchaser() },
    ...storeIds.map((storeId) => ({
      type: 'DeliverToStore' as const,
      storeId,
      actor: purchaser(),
    })),
  ]).state;
}

/**
 * Marks every line still unchecked at `storeId` OK, then confirms the
 * store. ConfirmStore does not write those OKs itself (DLV-19, 2026-10-30).
 */
export function confirmStoreAllOk(state: RunState, storeId: string): RunState {
  const { step } = runStepper();
  let s = state;
  const store = s.stores.get(storeId);
  for (const item of s.items.values()) {
    if (item.status !== 'purchased') continue;
    if (!item.storeSplits.some((sp) => sp.storeId === storeId)) continue;
    if (store?.itemConfirms.has(item.skuId)) continue;
    s = step(s, confirmStoreItem({ storeId, skuId: item.skuId }));
  }
  return step(s, { type: 'ConfirmStore', storeId, actor: confirmer() });
}
