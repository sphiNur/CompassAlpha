/**
 * Planning (review RUNAPI-13): PlanRun, and the order sessions a planned
 * or purchasing run takes on (AttachSessions) or lets go (EjectSession).
 */
import { milliQty, qtyMilliOrZero } from '@compass/contracts/quantity';
import { conflict, forbidden, preconditionFailed, validation } from '../../shared/errors';
import type { RunEvent } from '../events';
import type { RunState } from '../state';
import { assertActive, assertRunDate, num, type ActorCtx, type EventBase } from './guards';

export type PlanningCommand =
  | {
      type: 'PlanRun';
      orgId: string;
      runDate: string;
      /** The org's today, YYYY-MM-DD: see assertRunDate. */
      today: string;
      runIndex: number;
      sessionIds: string[];
      /** The sessions' order lines, summed with `sumDemand`. */
      plannedItems: Array<{ skuId: string; qty: string }>;
      actor: ActorCtx;
    }
  | {
      // M3.31 A.2 (2026-05-18): attach approved sessions to a live run.
      // `addedPlannedItems` is what the new sessions' order lines add,
      // summed with `sumDemand` as for RunPlanned.
      type: 'AttachSessions';
      sessionIds: string[];
      addedPlannedItems: Array<{ skuId: string; qty: string }>;
      actor: ActorCtx;
    }
  | {
      // Remove one still-pending order session from a planned/purchasing
      // run and reduce the aggregated planned quantities accordingly.
      type: 'EjectSession';
      sessionId: string;
      /** The session's order lines, summed with `sumDemand`. */
      removedPlannedItems: Array<{ skuId: string; qty: string }>;
      reason?: string;
      actor: ActorCtx;
    };

export function decidePlanning(
  state: RunState,
  command: PlanningCommand,
  baseFor: EventBase,
): RunEvent[] {
  switch (command.type) {
    case 'PlanRun': {
      // Per-STREAM guard only, and deliberately so: a decider sees one
      // aggregate, and "does this org already have another run open" is
      // not a fact about this stream. Note the consequence — for a fresh
      // run id `state.status` is always 'absent', so this check never
      // fires on a first PlanRun and provides no cross-run protection
      // whatsoever.
      //
      // That rule lives where it can be enforced atomically: the partial
      // unique index mrv_one_active_per_org_unique (migration 0035), with
      // run.create short-circuiting to the live run before it gets here.
      // If you come looking for a missing guard, it is not missing.
      // 2026-10-21 CA-04: migration 0047 narrows that index to
      // planned/purchasing, so one run may be buying while any number of
      // earlier runs are still out for delivery / awaiting confirmation.
      if (state.status !== 'absent') {
        throw conflict('run.errors.alreadyPlanned', { status: state.status });
      }
      if (!command.actor.permissions.has('run.create')) {
        throw forbidden('run.errors.cannotCreate');
      }
      assertRunDate(command.runDate, command.today);
      if (command.sessionIds.length === 0) {
        throw validation('run.errors.noSessions');
      }
      if (command.plannedItems.length === 0) {
        throw validation('run.errors.noItems');
      }
      return [
        {
          ...baseFor(1),
          type: 'RunPlanned',
          payload: {
            orgId: command.orgId,
            runDate: command.runDate,
            runIndex: command.runIndex,
            sessionIds: command.sessionIds,
            plannedItems: command.plannedItems,
            purchaserMemberId: command.actor.memberId,
          },
        },
      ];
    }

    case 'AttachSessions': {
      assertActive(state);
      if (
        !command.actor.permissions.has('run.create') &&
        !command.actor.permissions.has('run.create.org')
      ) {
        throw forbidden('run.errors.cannotPlan');
      }
      if (state.status !== 'planned' && state.status !== 'purchasing') {
        throw preconditionFailed('run.errors.cannotAttachInStatus', {
          status: state.status,
        });
      }
      if (command.sessionIds.length === 0) {
        throw validation('run.errors.noSessionsToAttach');
      }
      // Reject sessions already in this run — duplicate attach would
      // double-count their demand. The API layer already filters,
      // but this is the defense-in-depth.
      const existing = new Set(state.sessionIds);
      for (const sid of command.sessionIds) {
        if (existing.has(sid)) {
          throw preconditionFailed('run.errors.sessionAlreadyInRun', {
            sessionId: sid,
          });
        }
      }
      return [
        {
          ...baseFor(1),
          type: 'SessionsAttachedToRun',
          payload: {
            sessionIds: command.sessionIds,
            addedPlannedItems: command.addedPlannedItems,
          },
        },
      ];
    }

    case 'EjectSession': {
      assertActive(state);
      if (!command.actor.permissions.has('run.eject_session')) {
        throw forbidden('run.errors.cannotEjectSession');
      }
      if (state.status !== 'planned' && state.status !== 'purchasing') {
        throw preconditionFailed('run.errors.cannotEjectInStatus', {
          status: state.status,
        });
      }
      if (!state.sessionIds.includes(command.sessionId)) {
        throw preconditionFailed('run.errors.sessionNotInRun', {
          sessionId: command.sessionId,
        });
      }
      if (state.sessionIds.length <= 1) {
        throw preconditionFailed('run.errors.cannotEjectLastSession');
      }
      const items = new Map(state.items);
      for (const removed of command.removedPlannedItems) {
        const qty = num(removed.qty, 'run.errors.invalidQty');
        if (qty <= 0) throw validation('run.errors.qtyMustBePositive');
        const existing = items.get(removed.skuId);
        if (!existing) continue;
        // A session cannot leave once anything it asked for has been
        // bought or given up. Only what it asks a quantity of counts: the
        // router used to check this too, also counting lines of none
        // (review RUNAPI-13).
        if (existing.status !== 'pending') {
          throw preconditionFailed('order.errors.cannotEject', {
            skuId: removed.skuId,
            status: existing.status,
          });
        }
        const planned = num(existing.plannedQty, 'run.errors.invalidQty');
        // RUNAPI-05: in whole thousandths, not floats.
        const remaining = qtyMilliOrZero(existing.plannedQty) - qtyMilliOrZero(removed.qty);
        if (remaining < 0n) {
          throw preconditionFailed('run.errors.ejectQtyExceedsPlan', {
            skuId: removed.skuId,
            planned,
            qty,
          });
        }
        if (remaining === 0n) {
          items.delete(removed.skuId);
        } else {
          items.set(removed.skuId, { ...existing, plannedQty: milliQty(remaining) });
        }
      }
      if (items.size === 0) {
        throw preconditionFailed('run.errors.cannotEjectLastSession');
      }

      const reason = (command.reason ?? '').trim();
      if (reason.length > 500) throw validation('run.errors.noteTooLong');
      return [
        {
          ...baseFor(1),
          type: 'SessionEjectedFromRun',
          payload: {
            sessionId: command.sessionId,
            removedPlannedItems: command.removedPlannedItems,
            reason: reason || null,
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
