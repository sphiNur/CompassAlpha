/**
 * Inline projector for order events. Runs in the same tx that appends events,
 * so the read model is always at lockstep with the event log.
 *
 * For background streams (notifications, daily metrics, audit) we use the
 * outbox pattern so a separate worker delivers them. Order's read_model is
 * application-critical (UI reads from it within the same request) — keeping
 * it inline avoids the "I just submitted but the list is stale" UX bug.
 */
import { and, eq } from 'drizzle-orm';
import type { DB } from '@compass/db';
import { schema as s } from '@compass/db';
import type { OrderEvent } from '@compass/domain/order';

export async function projectOrder(db: DB, orgId: string, events: OrderEvent[]): Promise<void> {
  for (const e of events) {
    switch (e.type) {
      case 'DraftStarted':
        await db
          .insert(s.orderSessionsV)
          .values({
            id: e.streamId,
            orgId,
            storeId: e.payload.storeId,
            initiatedByMemberId: e.payload.initiatedByMemberId,
            orderDate: e.payload.orderDate,
            status: 'draft',
            lastSeq: e.seq,
          })
          .onConflictDoNothing();
        break;
      case 'ItemAdjusted': {
        // Per (session, sku, contributor) row. The forMemberId in the
        // payload is the contributor (= byMemberId for self-edit, =
        // some staff for manager review override).
        await db
          .insert(s.orderItemsV)
          .values({
            sessionId: e.streamId,
            skuId: e.payload.skuId,
            contributorMemberId: e.payload.forMemberId,
            qty: e.payload.qty,
            note: null,
            updatedByMemberId: e.payload.byMemberId,
            createdAt: e.occurredAt,
            updatedAt: e.occurredAt,
          })
          .onConflictDoUpdate({
            target: [
              s.orderItemsV.sessionId,
              s.orderItemsV.skuId,
              s.orderItemsV.contributorMemberId,
            ],
            set: {
              qty: e.payload.qty,
              updatedByMemberId: e.payload.byMemberId,
              updatedAt: e.occurredAt,
            },
          });
        await bumpSeq(db, e.streamId, e.seq);
        break;
      }
      case 'ItemNoteSet':
        await db
          .insert(s.orderItemsV)
          .values({
            sessionId: e.streamId,
            skuId: e.payload.skuId,
            contributorMemberId: e.payload.forMemberId,
            qty: '0',
            note: e.payload.note,
            updatedByMemberId: e.payload.byMemberId,
            createdAt: e.occurredAt,
            updatedAt: e.occurredAt,
          })
          .onConflictDoUpdate({
            target: [
              s.orderItemsV.sessionId,
              s.orderItemsV.skuId,
              s.orderItemsV.contributorMemberId,
            ],
            set: {
              note: e.payload.note,
              updatedByMemberId: e.payload.byMemberId,
              updatedAt: e.occurredAt,
            },
          });
        await bumpSeq(db, e.streamId, e.seq);
        break;
      case 'SessionNoteSet':
        // M1.8 (2026-05-07): session-level "其他物品" note. Trim and
        // collapse empty → null so the read-model column matches the
        // domain state (apply() does the same trimming).
        await db
          .update(s.orderSessionsV)
          .set({
            notes: e.payload.note && e.payload.note.trim() ? e.payload.note.trim() : null,
            lastSeq: e.seq,
            updatedAt: new Date(),
          })
          .where(eq(s.orderSessionsV.id, e.streamId));
        break;
      case 'SessionExtrasSet':
        // M3.16-C (2026-05-16): structured "其他物品" array. The
        // command layer has already validated each row; we just
        // serialize the payload into the jsonb column. JSON.stringify
        // works because the array is plain { name, qty, unit, note? }
        // objects — no Date / Map / Set values.
        await db
          .update(s.orderSessionsV)
          .set({
            extrasJson: e.payload.extras,
            lastSeq: e.seq,
            updatedAt: new Date(),
          })
          .where(eq(s.orderSessionsV.id, e.streamId));
        break;
      case 'Submitted':
        await db
          .update(s.orderSessionsV)
          .set({
            status: 'submitted',
            submittedAt: e.occurredAt,
            submittedByMemberId: e.payload.byMemberId,
            lastSeq: e.seq,
            updatedAt: new Date(),
          })
          .where(eq(s.orderSessionsV.id, e.streamId));
        break;
      case 'Claimed':
        await db
          .update(s.orderSessionsV)
          .set({
            claimedByMemberId: e.payload.byMemberId,
            claimedAt: e.occurredAt,
            lastSeq: e.seq,
            updatedAt: new Date(),
          })
          .where(eq(s.orderSessionsV.id, e.streamId));
        break;
      case 'ClaimReleased':
        await db
          .update(s.orderSessionsV)
          .set({ claimedByMemberId: null, claimedAt: null, lastSeq: e.seq, updatedAt: new Date() })
          .where(eq(s.orderSessionsV.id, e.streamId));
        break;
      case 'Approved':
        await db
          .update(s.orderSessionsV)
          .set({
            status: 'approved',
            decidedAt: e.occurredAt,
            decidedByMemberId: e.payload.byMemberId,
            claimedByMemberId: null,
            claimedAt: null,
            rejectReason: null,
            lastSeq: e.seq,
            updatedAt: new Date(),
          })
          .where(eq(s.orderSessionsV.id, e.streamId));
        break;
      case 'Rejected':
        await db
          .update(s.orderSessionsV)
          .set({
            status: 'rejected',
            decidedAt: e.occurredAt,
            decidedByMemberId: e.payload.byMemberId,
            rejectReason: e.payload.reason,
            claimedByMemberId: null,
            claimedAt: null,
            lastSeq: e.seq,
            updatedAt: new Date(),
          })
          .where(eq(s.orderSessionsV.id, e.streamId));
        break;
      case 'Withdrawn':
        await db
          .update(s.orderSessionsV)
          .set({
            status: 'draft',
            submittedAt: null,
            submittedByMemberId: null,
            decidedAt: null,
            decidedByMemberId: null,
            rejectReason: null,
            lastSeq: e.seq,
            updatedAt: new Date(),
          })
          .where(eq(s.orderSessionsV.id, e.streamId));
        break;
      case 'Unapproved':
        // M1.7-fix follow-up (2026-05-07): clear the claim instead of
        // transferring it to the unapprover, matching apply() in
        // state.ts. Earlier rev assigned the claim to the unapprover,
        // which left the order stuck on chain-owners who walked away
        // after undoing a mistaken approval.
        await db
          .update(s.orderSessionsV)
          .set({
            status: 'submitted',
            decidedAt: null,
            decidedByMemberId: null,
            claimedByMemberId: null,
            claimedAt: null,
            lastSeq: e.seq,
            updatedAt: new Date(),
          })
          .where(eq(s.orderSessionsV.id, e.streamId));
        break;
      case 'AttachedToRun':
        await db
          .update(s.orderSessionsV)
          .set({ status: 'in_run', runId: e.payload.runId, lastSeq: e.seq, updatedAt: new Date() })
          .where(eq(s.orderSessionsV.id, e.streamId));
        break;
      case 'EjectedFromRun':
        await db
          .update(s.orderSessionsV)
          .set({ status: 'approved', runId: null, lastSeq: e.seq, updatedAt: new Date() })
          .where(eq(s.orderSessionsV.id, e.streamId));
        break;
      case 'Archived':
        await db
          .update(s.orderSessionsV)
          .set({ status: 'archived', lastSeq: e.seq, updatedAt: new Date() })
          .where(eq(s.orderSessionsV.id, e.streamId));
        break;
    }
  }
}

async function bumpSeq(db: DB, streamId: string, seq: number): Promise<void> {
  await db
    .update(s.orderSessionsV)
    .set({ lastSeq: seq, updatedAt: new Date() })
    .where(and(eq(s.orderSessionsV.id, streamId)));
}
