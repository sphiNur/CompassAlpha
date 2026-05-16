/**
 * Order aggregate state — the in-memory projection of an event stream
 * built by `apply()` for command-decision purposes. NOT the read model
 * (read_model.order_sessions_v); that one lives in the DB and is for
 * UI queries.
 *
 * Per-store collaborative model (2026-05-02):
 *   The session is owned by the store, NOT by an individual member.
 *   Multiple staff at the same store add/edit line items on a SHARED
 *   shopping list. Each line carries the member who created it
 *   (createdByMemberId) and the member who last touched it
 *   (updatedByMemberId), so the command layer can enforce
 *   "you can only edit lines you authored" by default, with a store-
 *   manager override.
 */
import type { OrderEvent, SessionExtraItem } from './events';

export type OrderStatus =
  | 'absent' // stream hasn't started yet
  | 'draft'
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'in_run'
  | 'archived';

/**
 * One row per (sku, contributor). Two people at the same store both
 * adding apples → two rows, summed at read time. Manager review can
 * mutate a specific row in place (see commands.ts).
 */
export interface OrderItemState {
  skuId: string;
  /** Whose contribution this row is. The PK in the read model. */
  contributorMemberId: string;
  qty: string;
  note: string | null;
  /** Last toucher — equal to contributor by default; manager during review. */
  updatedByMemberId: string;
  updatedAt: Date | null;
}

/** Composite key helper for the items map. */
export function itemKey(skuId: string, contributorMemberId: string): string {
  return `${skuId}:${contributorMemberId}`;
}

export interface OrderState {
  /** 'absent' if no DraftStarted yet. */
  status: OrderStatus;
  streamId: string;
  seq: number;
  orgId: string | null;
  storeId: string | null;
  /** First member to touch this session — convenience for "who started it". */
  initiatedByMemberId: string | null;
  /** Member who fired Submit. Null until status reaches submitted. */
  submittedByMemberId: string | null;
  orderDate: string | null;
  items: Map<string, OrderItemState>;
  claimedByMemberId: string | null;
  claimedAt: Date | null;
  submittedAt: Date | null;
  decidedAt: Date | null;
  decidedByMemberId: string | null;
  rejectReason: string | null;
  runId: string | null;
  /**
   * Session-level free-text "其他物品" note (M1.8, 2026-05-07).
   * SUPERSEDED M3.16-C by `extras` (structured list). Kept for
   * back-compat reads of pre-M3.16 sessions.
   */
  notes: string | null;
  /**
   * Structured "其他物品" line list (M3.16-C, 2026-05-16). Empty
   * array when nothing has been added. Last-write-wins on the
   * whole array — one SessionExtrasSet event replaces it atomically.
   */
  extras: SessionExtraItem[];
}

export function emptyState(streamId: string): OrderState {
  return {
    status: 'absent',
    streamId,
    seq: 0,
    orgId: null,
    storeId: null,
    initiatedByMemberId: null,
    submittedByMemberId: null,
    orderDate: null,
    items: new Map(),
    claimedByMemberId: null,
    claimedAt: null,
    submittedAt: null,
    decidedAt: null,
    decidedByMemberId: null,
    rejectReason: null,
    runId: null,
    notes: null,
    extras: [],
  };
}

/** Pure reducer: state + event → state'. */
export function apply(state: OrderState, event: OrderEvent): OrderState {
  // seq must advance by exactly 1; a gap means an event was lost or out-of-order.
  if (event.seq !== state.seq + 1) {
    throw new Error(
      `apply(): seq gap on stream ${state.streamId}: have ${state.seq}, got ${event.seq}`,
    );
  }
  switch (event.type) {
    case 'DraftStarted': {
      return {
        ...state,
        status: 'draft',
        seq: event.seq,
        orgId: event.payload.orgId,
        storeId: event.payload.storeId,
        initiatedByMemberId: event.payload.initiatedByMemberId,
        orderDate: event.payload.orderDate,
      };
    }
    case 'ItemAdjusted': {
      const items = new Map(state.items);
      // The row's contributor = forMemberId in the payload. byMemberId is
      // who triggered the command (a manager review may have byMemberId
      // != forMemberId).
      const contributor = event.payload.forMemberId;
      const byMember = event.payload.byMemberId;
      const key = itemKey(event.payload.skuId, contributor);
      const existing = items.get(key);
      const next: OrderItemState = existing
        ? {
            ...existing,
            qty: event.payload.qty,
            updatedByMemberId: byMember,
            updatedAt: event.occurredAt,
          }
        : {
            skuId: event.payload.skuId,
            contributorMemberId: contributor,
            qty: event.payload.qty,
            note: null,
            updatedByMemberId: byMember,
            updatedAt: event.occurredAt,
          };
      items.set(key, next);
      return { ...state, seq: event.seq, items };
    }
    case 'ItemNoteSet': {
      const items = new Map(state.items);
      const contributor = event.payload.forMemberId;
      const byMember = event.payload.byMemberId;
      const key = itemKey(event.payload.skuId, contributor);
      const existing = items.get(key);
      if (existing) {
        items.set(key, {
          ...existing,
          note: event.payload.note,
          updatedByMemberId: byMember,
          updatedAt: event.occurredAt,
        });
      } else {
        items.set(key, {
          skuId: event.payload.skuId,
          contributorMemberId: contributor,
          qty: '0',
          note: event.payload.note,
          updatedByMemberId: byMember,
          updatedAt: event.occurredAt,
        });
      }
      return { ...state, seq: event.seq, items };
    }
    case 'SessionNoteSet':
      // M1.8 (2026-05-07): session-level free-text note. Trim and
      // collapse whitespace to a clean single string; null if empty.
      // Last-write-wins; we don't track history of edits beyond the
      // event log itself.
      return {
        ...state,
        seq: event.seq,
        notes: event.payload.note && event.payload.note.trim()
          ? event.payload.note.trim()
          : null,
      };
    case 'SessionExtrasSet':
      // M3.16-C (2026-05-16): structured "其他物品" array. Atomic
      // replacement — the payload IS the new list, even if the
      // operator only added one row. The reducer trusts the command
      // layer to have validated each row's shape; we just shallow-
      // copy so downstream mutations don't accidentally alias the
      // payload reference.
      return {
        ...state,
        seq: event.seq,
        extras: event.payload.extras.map((e) => ({ ...e })),
      };
    case 'Submitted':
      return {
        ...state,
        seq: event.seq,
        status: 'submitted',
        submittedAt: event.occurredAt,
        submittedByMemberId: event.payload.byMemberId,
      };
    case 'Claimed':
      return {
        ...state,
        seq: event.seq,
        claimedByMemberId: event.payload.byMemberId,
        claimedAt: event.occurredAt,
      };
    case 'ClaimReleased':
      return { ...state, seq: event.seq, claimedByMemberId: null, claimedAt: null };
    case 'Approved':
      return {
        ...state,
        seq: event.seq,
        status: 'approved',
        decidedAt: event.occurredAt,
        decidedByMemberId: event.payload.byMemberId,
        claimedByMemberId: null,
        claimedAt: null,
        rejectReason: null,
      };
    case 'Rejected':
      return {
        ...state,
        seq: event.seq,
        status: 'rejected',
        decidedAt: event.occurredAt,
        decidedByMemberId: event.payload.byMemberId,
        rejectReason: event.payload.reason,
        claimedByMemberId: null,
        claimedAt: null,
      };
    case 'Withdrawn':
      return {
        ...state,
        seq: event.seq,
        status: 'draft',
        submittedAt: null,
        submittedByMemberId: null,
        decidedAt: null,
        decidedByMemberId: null,
        rejectReason: null,
      };
    case 'Unapproved':
      // M1.7-fix (2026-05-07, audit HIGH #4): clear the claim instead
      // of transferring it to the unapprover. Earlier rev assigned
      // the claim to the unapprover so they could "fix" it — but in
      // practice the unapprover is often a chain owner who undoes a
      // store-manager's mistaken approval and immediately walks away.
      // The order then sat un-actionable in the queue: only the
      // chain-owner could re-approve, and lower-tier managers saw a
      // "claimed by reviewer" banner with no Release button. Now the
      // session goes back to its pre-claim state — any approver can
      // claim it from the queue.
      return {
        ...state,
        seq: event.seq,
        status: 'submitted',
        decidedAt: null,
        decidedByMemberId: null,
        claimedByMemberId: null,
        claimedAt: null,
      };
    case 'AttachedToRun':
      return { ...state, seq: event.seq, status: 'in_run', runId: event.payload.runId };
    case 'EjectedFromRun':
      return { ...state, seq: event.seq, status: 'approved', runId: null };
    case 'Archived':
      return { ...state, seq: event.seq, status: 'archived' };
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return state;
    }
  }
}

/** Replay a sequence of events into the final state. */
export function replay(streamId: string, events: OrderEvent[]): OrderState {
  return events.reduce(apply, emptyState(streamId));
}
