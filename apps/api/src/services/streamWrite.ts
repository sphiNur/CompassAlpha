/**
 * Writing what a command decided, in the caller's transaction (review
 * RUNAPI-14): append the events to their stream, then project them.
 *
 * The run router wrote this out by hand at every append. Notifications
 * and realtime pushes stay with the caller, because which of them a
 * command sends differs: run.create and attachSessions notify nobody.
 */
import type { DB } from '@compass/db';
import type { OrderEvent } from '@compass/domain/order';
import { applyRun, type RunEvent, type RunState } from '@compass/domain/run';
import { appendEvents } from './eventStore';
import { projectOrder } from './orderProjection';
import { projectRun } from './runProjection';

/** Append and project a run's new events; returns the state after them. */
export async function writeRunEvents(
  db: DB,
  orgId: string,
  state: RunState,
  events: RunEvent[],
): Promise<RunState> {
  if (events.length === 0) return state;
  await appendEvents(db, { streamType: 'run', streamId: state.streamId, orgId, events });
  await projectRun(db, orgId, events);
  return events.reduce(applyRun, state);
}

/** Append and project a session's new order events. */
export async function writeOrderEvents(
  db: DB,
  orgId: string,
  sessionId: string,
  events: OrderEvent[],
): Promise<void> {
  if (events.length === 0) return;
  await appendEvents(db, { streamType: 'order', streamId: sessionId, orgId, events });
  await projectOrder(db, orgId, events);
}
