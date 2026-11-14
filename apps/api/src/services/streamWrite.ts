/**
 * Writing what a run command decided, in the caller's transaction (review
 * RUNAPI-14): append the events to the run's stream, then project them.
 *
 * The run and order routers wrote this out by hand at every append.
 * Notifications and realtime pushes stay with the caller, because which
 * of them a command sends differs: run.create and attachSessions notify
 * nobody. An order session's events are written with writeOrderEvents from
 * @compass/streams, which the worker shares (review ORD-07); the run
 * projector is still the API's own.
 */
import type { DB } from '@compass/db';
import { applyRun, type RunEvent, type RunState } from '@compass/domain/run';
import { appendEvents } from '@compass/streams';
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
