/**
 * Post-finish amendment (2026-07-06), super-admin only (run.amend; review
 * RUNAPI-13): reopening a finished run, booking its spend under another
 * day, and re-freezing its money. While a run is reopened (`amending`),
 * a super-admin corrects it with the purchasing commands (see
 * assertEditablePhase).
 */
import { forbidden, preconditionFailed, validation } from '../../shared/errors';
import type { RunEvent } from '../events';
import type { RunState } from '../state';
import { computeRunTotals } from './closing';
import { assertRunDate, type ActorCtx, type EventBase } from './guards';

export type AmendingCommand =
  // Post-finish amendment (2026-07-06), super-admin only (run.amend).
  | { type: 'ReopenRun'; reason: string; actor: ActorCtx }
  | { type: 'RefinalizeRun'; actor: ActorCtx }
  // Correct the calendar date a run's spend is booked under (2026-07-30),
  // super-admin only (run.amend). See the RunDateChanged event docblock.
  // `runIndex`: the run's number on the new day (see RunDateChanged).
  // `today`: the org's today, as for PlanRun.
  | { type: 'ChangeRunDate'; runDate: string; today: string; runIndex?: number; actor: ActorCtx };

export function decideAmending(
  state: RunState,
  command: AmendingCommand,
  baseFor: EventBase,
): RunEvent[] {
  switch (command.type) {
    case 'ReopenRun': {
      if (state.status === 'absent') throw preconditionFailed('run.errors.streamMissing');
      if (!command.actor.permissions.has('run.amend')) {
        throw forbidden('run.errors.cannotAmend');
      }
      // Only a FINISHED run can be reopened. Cancelled is permanently
      // frozen; in-flight runs are edited normally, no reopen needed.
      if (state.status !== 'finished') {
        throw preconditionFailed('run.errors.notReopenable', { status: state.status });
      }
      const reason = command.reason.trim();
      if (!reason) throw validation('run.errors.reopenReasonRequired');
      if (reason.length > 500) throw validation('run.errors.noteTooLong');
      return [
        {
          ...baseFor(1),
          type: 'RunReopened',
          payload: { reason, byMemberId: command.actor.memberId },
        },
      ];
    }

    case 'ChangeRunDate': {
      if (state.status === 'absent') throw preconditionFailed('run.errors.streamMissing');
      if (!command.actor.permissions.has('run.amend')) {
        throw forbidden('run.errors.cannotAmend');
      }
      // Cancelled runs stay frozen, exactly as they are for every other
      // edit. Every other phase is fair game — unlike the item-level
      // commands this does NOT require a reopen first, because the whole
      // point is correcting a finished run's date, and forcing
      // reopen → change → refinalize would rewrite the run's totals as a
      // side effect of a pure calendar fix.
      if (state.status === 'cancelled') {
        throw preconditionFailed('run.errors.runFrozen', { status: state.status });
      }
      const runDate = command.runDate.trim();
      assertRunDate(runDate, command.today);
      // No-op guard: emitting an event that changes nothing would add an
      // audit entry claiming a correction happened.
      if (state.runDate === runDate) {
        throw preconditionFailed('run.errors.runDateUnchanged');
      }
      return [
        {
          ...baseFor(1),
          type: 'RunDateChanged',
          payload: {
            runDate,
            previousRunDate: state.runDate,
            ...(command.runIndex !== undefined ? { runIndex: command.runIndex } : {}),
            byMemberId: command.actor.memberId,
          },
        },
      ];
    }

    case 'RefinalizeRun': {
      if (state.status === 'absent') throw preconditionFailed('run.errors.streamMissing');
      if (!command.actor.permissions.has('run.amend')) {
        throw forbidden('run.errors.cannotAmend');
      }
      if (state.status !== 'amending') {
        throw preconditionFailed('run.errors.notRefinalizable', { status: state.status });
      }
      // DLV-3 (2026-10-30): a correction may add an item; the run cannot
      // close again with it neither bought nor marked unavailable.
      const allHandled = Array.from(state.items.values()).every(
        (i) => i.status === 'purchased' || i.status === 'unavailable',
      );
      if (!allHandled) throw preconditionFailed('run.errors.itemsPending');
      // Recompute totals from the amended state (same math as FinishRun)
      // so the read model's frozen totals are correct again.
      const { total, totalCash, totalTransfer, expensesTotal } = computeRunTotals(state);
      return [
        {
          ...baseFor(1),
          type: 'RunRefinalized',
          payload: {
            totalActual: total,
            totalCash,
            totalTransfer,
            itemsTotal: total,
            expensesTotal,
            byMemberId: command.actor.memberId,
          },
        },
      ];
    }

    default: {
      const _x: never = command;
      void _x;
      return [];
    }
  }
}
