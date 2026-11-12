/**
 * Commands the system gives on its own, with no person behind them (review
 * ORD-07): the worker used to write the timed-out release of a run claim
 * itself and project it with a copy of the projector. It is decided here
 * now, and its event carries no actor.
 */
import type { Clock } from '../shared/clock';
import { systemClock } from '../shared/clock';
import type { RunEvent } from './events';
import type { RunState } from './state';

/** A run claim the purchaser left idle past the timeout (C.2, M3.38). */
export type RunSystemCommand = { type: 'ReleaseIdleClaim' };

/** The events the system commands write. */
export type RunSystemEvent = Extract<RunEvent, { type: 'RunClaimReleased' }>;

/** The events a system command leads to; none when the run has moved on. */
export function decideRunSystem(
  state: RunState,
  command: RunSystemCommand,
  clock: Clock = systemClock,
): RunSystemEvent[] {
  switch (command.type) {
    case 'ReleaseIdleClaim': {
      // A run is claimed only from planned to delivering.
      const claimable =
        state.status === 'planned' ||
        state.status === 'purchasing' ||
        state.status === 'delivering';
      if (!claimable || !state.claimedByMemberId) return [];
      return [
        {
          streamId: state.streamId,
          seq: state.seq + 1,
          occurredAt: clock.now(),
          actorUserId: null,
          actorMemberId: null,
          type: 'RunClaimReleased',
          payload: { byMemberId: null, reason: 'timeout' },
        },
      ];
    }
    default: {
      const _exhaustive: never = command.type;
      void _exhaustive;
      return [];
    }
  }
}
