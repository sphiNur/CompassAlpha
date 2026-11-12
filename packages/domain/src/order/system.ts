/**
 * Commands the system gives on its own, with no person behind them (review
 * ORD-07). The worker used to write these events itself, skipping decide()
 * because it has no permission set, and projected them with a copy of the
 * projector. They are decided here now, and their events carry no actor.
 */
import type { Clock } from '../shared/clock';
import { systemClock } from '../shared/clock';
import type { OrderEvent } from './events';
import type { OrderState } from './state';

export type OrderSystemCommand =
  /** A claim the reviewer left idle past the timeout (M3.20). */
  | { type: 'ReleaseIdleClaim' }
  /**
   * A session still in a run that has ended (audit CA-45): a finished run's
   * sessions are archived and keep the run, as run.finish does; a cancelled
   * run's go back to approved, as run.cancel does.
   */
  | { type: 'RepairOrphan'; runId: string; runStatus: 'finished' | 'cancelled' };

/**
 * The events a system command leads to; none when the session has moved on
 * since the worker looked at it.
 */
export function decideSystem(
  state: OrderState,
  command: OrderSystemCommand,
  clock: Clock = systemClock,
): OrderEvent[] {
  const base = {
    streamId: state.streamId,
    seq: state.seq + 1,
    occurredAt: clock.now(),
    actorUserId: null,
    actorMemberId: null,
  };
  switch (command.type) {
    case 'ReleaseIdleClaim':
      // Only a submitted order is under review.
      if (state.status !== 'submitted' || !state.claimedByMemberId) return [];
      return [{ ...base, type: 'ClaimReleased', payload: { byMemberId: null, reason: 'timeout' } }];
    case 'RepairOrphan':
      if (state.status !== 'in_run' || state.runId !== command.runId) return [];
      return command.runStatus === 'finished'
        ? [{ ...base, type: 'Archived', payload: { reason: 'repair' } }]
        : [
            {
              ...base,
              type: 'EjectedFromRun',
              payload: { runId: command.runId, byMemberId: null, reason: 'repair' },
            },
          ];
    default: {
      const _exhaustive: never = command;
      void _exhaustive;
      return [];
    }
  }
}
