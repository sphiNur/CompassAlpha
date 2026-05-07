/**
 * Event store helpers — read events for a stream and append new ones with
 * optimistic concurrency. Keeps DB access in one place so the order/run
 * routers stay focused on decision flow.
 */
import { and, asc, eq, gt } from 'drizzle-orm';
import type { DB } from '@compass/db';
import { schema as s } from '@compass/db';
import { randomUUID } from 'node:crypto';

export interface PersistedEvent {
  id: string;
  streamId: string;
  seq: number;
  type: string;
  payload: unknown;
  occurredAt: Date;
  actorUserId: string | null;
  actorMemberId: string | null;
}

export async function readStream(
  db: DB,
  streamType: string,
  streamId: string,
  fromSeq = 0,
): Promise<PersistedEvent[]> {
  const rows = await db
    .select()
    .from(s.events)
    .where(
      and(
        eq(s.events.streamType, streamType),
        eq(s.events.streamId, streamId),
        gt(s.events.seq, fromSeq),
      ),
    )
    .orderBy(asc(s.events.seq));
  return rows.map((r) => ({
    id: r.id,
    streamId: r.streamId,
    seq: r.seq,
    type: r.type,
    payload: r.payload,
    occurredAt: r.occurredAt,
    actorUserId: r.actorId ?? null,
    actorMemberId: null, // (we record memberId inside payload for now)
  }));
}

export interface AppendInput {
  streamType: string;
  streamId: string;
  orgId: string;
  events: Array<{
    type: string;
    seq: number;
    payload: unknown;
    actorUserId: string | null;
    actorMemberId: string | null;
    occurredAt: Date;
    correlationId?: string | undefined;
    causationId?: string | undefined;
  }>;
  idempotencyKey?: string | undefined;
}

export async function appendEvents(db: DB, input: AppendInput): Promise<void> {
  if (input.events.length === 0) return;
  // INSERT will throw P0001/23505 on (stream_id, seq) collision — caller catches.
  await db.insert(s.events).values(
    input.events.map((e) => ({
      id: randomUUID(),
      orgId: input.orgId,
      streamType: input.streamType,
      streamId: input.streamId,
      seq: e.seq,
      type: e.type,
      payload: e.payload as Record<string, unknown>,
      actorId: e.actorUserId ?? null,
      occurredAt: e.occurredAt,
      correlationId: e.correlationId ?? null,
      causationId: e.causationId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
    })),
  );
}
