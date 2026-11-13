import type { Clock } from '../shared/clock';
import { systemClock } from '../shared/clock';
import { decideAmending, type AmendingCommand } from './decide/amending';
import { decideClosing, type ClosingCommand } from './decide/closing';
import { decideDelivery, type DeliveryCommand } from './decide/delivery';
import { decidePlanning, type PlanningCommand } from './decide/planning';
import { decidePurchasing, type PurchasingCommand } from './decide/purchasing';
import type { RunEvent } from './events';
import type { RunState } from './state';

export type { ActorCtx } from './decide/guards';
export { computeRunTotals } from './decide/closing';

/** Every command a run takes: each is declared next to the decider of its phase. */
export type RunCommand =
  | PlanningCommand
  | PurchasingCommand
  | DeliveryCommand
  | ClosingCommand
  | AmendingCommand;

/**
 * The run's decider, its one entry point: the events `command` emits from
 * `state` at `clock`'s now, or the DomainError that refuses it. Each phase
 * decides its own commands in decide/ (review RUNAPI-13: planning,
 * purchasing, delivery, closing and amending), with the checks they share
 * in decide/guards.ts.
 */
export function decideRun(
  state: RunState,
  command: RunCommand,
  clock: Clock = systemClock,
): RunEvent[] {
  const now = clock.now();
  const baseFor = (offset: number) => ({
    streamId: state.streamId,
    seq: state.seq + offset,
    occurredAt: now,
    actorUserId: command.actor.userId,
    actorMemberId: command.actor.memberId,
  });

  switch (command.type) {
    case 'PlanRun':
    case 'AttachSessions':
    case 'EjectSession':
      return decidePlanning(state, command, baseFor);

    case 'StartPurchase':
    case 'PurchaseItem':
    case 'AddPurchaserItem':
    case 'AddRunExpense':
    case 'RemoveRunExpense':
    case 'MarkUnavailable':
    case 'RevisePurchase':
    case 'UndoPurchase':
    case 'DismissTopUp':
    case 'UnmarkUnavailable':
    case 'UndoStartPurchase':
    case 'ClaimRun':
    case 'ReleaseRunClaim':
      return decidePurchasing(state, command, baseFor);

    case 'StartDelivery':
    case 'DeliverToStore':
    case 'ConfirmStoreItem':
    case 'ConfirmStoreItemsOk':
    case 'ConfirmStore':
    case 'UndeliverStore':
    case 'UndoStartDelivery':
      return decideDelivery(state, command, baseFor);

    case 'FinishRun':
    case 'CancelRun':
      return decideClosing(state, command, baseFor);

    case 'ReopenRun':
    case 'ChangeRunDate':
    case 'RefinalizeRun':
      return decideAmending(state, command, baseFor);

    default: {
      const _x: never = command;
      void _x;
      return [];
    }
  }
}
