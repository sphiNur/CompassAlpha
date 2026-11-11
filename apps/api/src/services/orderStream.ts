/**
 * An order session's event stream, read and replayed (review RUNAPI-14;
 * ORD-06 asks the order router for the same).
 *
 * The run router read a session's stream and folded it by hand in five
 * places, each with its own `as unknown as OrderEvent[]`. The store keeps
 * payloads as JSON it does not type, so the cast lives here once.
 */
import type { DB } from '@compass/db';
import { replay, type OrderEvent, type OrderState } from '@compass/domain/order';
import { readStream } from './eventStore';

/** A session's events, in stream order. */
export async function readOrderEvents(db: DB, sessionId: string): Promise<OrderEvent[]> {
  return (await readStream(db, 'order', sessionId)) as unknown as OrderEvent[];
}

/** A session's state, replayed from its stream. */
export async function loadOrderState(db: DB, sessionId: string): Promise<OrderState> {
  return replay(sessionId, await readOrderEvents(db, sessionId));
}
