/**
 * A run's event stream, read and replayed (review RUNAPI-14).
 *
 * The run router read the stream and folded it with the run reducer in
 * seven places, each with its own `as unknown as RunEvent[]`. The store
 * keeps payloads as JSON it does not type, so the cast lives here once.
 */
import type { DB } from '@compass/db';
import { replayRun, type RunEvent, type RunState } from '@compass/domain/run';
import { readStream } from './eventStore';

/** A run's events, in stream order. */
export async function readRunEvents(db: DB, runId: string): Promise<RunEvent[]> {
  return (await readStream(db, 'run', runId)) as unknown as RunEvent[];
}

/** A run's state, replayed from its stream. */
export async function loadRunState(db: DB, runId: string): Promise<RunState> {
  return replayRun(runId, await readRunEvents(db, runId));
}
