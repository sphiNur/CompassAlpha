/**
 * An order session's event stream: read, replayed, and written (review
 * RUNAPI-14; ORD-06 asks the order router for the same).
 *
 * The run router read a session's stream and folded it by hand in five
 * places, each with its own `as unknown as OrderEvent[]`. The store keeps
 * payloads as JSON it does not type, so the cast lives here once.
 */
import type { DB } from '@compass/db';
import { replay, type OrderEvent, type OrderState } from '@compass/domain/order';
import { appendEvents, readStream } from './eventStore';
import { projectOrder } from './orderProjection';

/** A session's events, in stream order. */
export async function readOrderEvents(db: DB, sessionId: string): Promise<OrderEvent[]> {
  return (await readStream(db, 'order', sessionId)) as unknown as OrderEvent[];
}

/** A session's state, replayed from its stream. */
export async function loadOrderState(db: DB, sessionId: string): Promise<OrderState> {
  return replay(sessionId, await readOrderEvents(db, sessionId));
}

/**
 * Append and project a session's new order events, in the caller's
 * transaction. `idempotencyKey` is stored on each of them (order.adjustItem
 * keeps the key it was sent).
 */
export async function writeOrderEvents(
  db: DB,
  orgId: string,
  sessionId: string,
  events: OrderEvent[],
  idempotencyKey?: string,
): Promise<void> {
  if (events.length === 0) return;
  await appendEvents(db, {
    streamType: 'order',
    streamId: sessionId,
    orgId,
    events,
    idempotencyKey,
  });
  await projectOrder(db, orgId, events);
}
