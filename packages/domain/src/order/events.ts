/**
 * Order event catalog — every state change to a `(store, date)` order
 * session goes through one of these. Append-only.
 *
 * Per-store collaborative model (2026-05-02): the session belongs to
 * the store; multiple staff add line items. Events that mutate items
 * (`ItemAdjusted`, `ItemNoteSet`) carry `byMemberId` so the projector
 * can attribute authorship and the command layer can enforce
 * "edit only what you authored" by default.
 *
 * Event payload shape is part of the public contract; bumping it requires a
 * new event TYPE (e.g. `ItemAdjusted` → `ItemAdjustedV2`) with a parallel
 * projector branch. Never mutate an existing event's payload schema.
 */

export type OrderEventType =
  | 'DraftStarted'
  | 'ItemAdjusted'
  | 'ItemNoteSet'
  | 'SessionNoteSet'
  | 'SessionExtrasSet'
  | 'Submitted'
  | 'Claimed'
  | 'ClaimReleased'
  | 'Approved'
  | 'Rejected'
  | 'Withdrawn'
  | 'Unapproved'
  | 'AttachedToRun'
  | 'EjectedFromRun'
  | 'Archived';

/**
 * Structured "其他物品" line (M3.16-C, 2026-05-16). Replaces the
 * free-text `notes` blob. Each row is one off-catalog item the
 * store needs the runner to source.
 *
 * Wire format: JSON-safe. `qty` is decimal-as-string to match how
 * SKU qty is serialised everywhere else in the system.
 */
export interface SessionExtraItem {
  /** Free-text product name in any language (e.g. "辣椒粉"). 1..200 chars. */
  name: string;
  /** Decimal qty as string (e.g. "0.5", "10"). Must parse to > 0. */
  qty: string;
  /** Unit (e.g. "kg", "包", "瓶"). 1..16 chars. */
  unit: string;
  /** Optional per-row note (e.g. "大包装优先"). ≤200 chars. */
  note?: string;
}

interface BaseEvent {
  /** Stream id — also the session id. */
  streamId: string;
  /** Sequence inside the stream. (streamId, seq) is unique. */
  seq: number;
  occurredAt: Date;
  /** User id of whoever caused this event. Null for system. */
  actorUserId: string | null;
  /** Member id (org-scoped) of the actor. Null for system. */
  actorMemberId: string | null;
  /** Group of related events — the same client command often produces 1+ events. */
  correlationId?: string | undefined;
  causationId?: string | undefined;
}

export type DraftStartedEvent = BaseEvent & {
  type: 'DraftStarted';
  payload: {
    orgId: string;
    storeId: string;
    /** Member who triggered the very first AdjustItem, recorded once. */
    initiatedByMemberId: string;
    orderDate: string; // YYYY-MM-DD
  };
};

export type ItemAdjustedEvent = BaseEvent & {
  type: 'ItemAdjusted';
  payload: {
    skuId: string;
    qty: string; // decimal as string for precision
    /** previous qty (or '0' if first time). Lets the projector skip no-op writes. */
    prevQty: string;
    /** Who triggered the command (the actor). */
    byMemberId: string;
    /** Whose row is being mutated. Equals byMemberId by default; differs
     *  when a manager edits another contributor's line during review. */
    forMemberId: string;
  };
};

export type ItemNoteSetEvent = BaseEvent & {
  type: 'ItemNoteSet';
  payload: { skuId: string; note: string | null; byMemberId: string; forMemberId: string };
};

/**
 * Session-level free-text note (M1.8, 2026-05-07). Sibling of
 * ItemNoteSet but unscoped to any SKU — the staff member writes a
 * "其他物品" line for things not in the catalog. Manager sees it
 * during approval; purchaser sees it in the run preview.
 *
 * Empty/null note clears it. Re-issuing with new text overwrites
 * (last-write-wins; we don't append history). Locked once the
 * session leaves draft status — same rule as item edits.
 */
export type SessionNoteSetEvent = BaseEvent & {
  type: 'SessionNoteSet';
  payload: { note: string | null; byMemberId: string };
};

/**
 * Session-level structured extras list (M3.16-C, 2026-05-16).
 * Successor to SessionNoteSet — the staff member maintains a list of
 * { name, qty, unit, note? } rows for items not in the SKU catalog.
 *
 * Atomic replacement: payload contains the FULL list. Adding,
 * removing, and editing a row all produce a single SessionExtrasSet
 * event with the new full list. Same edit gate as SessionNoteSet
 * (owner during draft/rejected, claimer during submitted review;
 * locked once approved/in_run/archived).
 */
export type SessionExtrasSetEvent = BaseEvent & {
  type: 'SessionExtrasSet';
  payload: { extras: SessionExtraItem[]; byMemberId: string };
};

export type SubmittedEvent = BaseEvent & {
  type: 'Submitted';
  payload: { itemCount: number; byMemberId: string };
};

export type ClaimedEvent = BaseEvent & {
  type: 'Claimed';
  payload: { byMemberId: string };
};

export type ClaimReleasedEvent = BaseEvent & {
  type: 'ClaimReleased';
  /** `override` is emitted when an actor other than the current claimer
   *  releases the claim — requires `order.approve` and is the escape
   *  valve for a stale claim that's blocking the queue. The audit log
   *  records `byMemberId` (the overrider) for traceability. */
  payload: {
    byMemberId: string;
    reason: 'manual' | 'pagehide' | 'timeout' | 'override';
  };
};

export type ApprovedEvent = BaseEvent & {
  type: 'Approved';
  payload: { byMemberId: string };
};

export type RejectedEvent = BaseEvent & {
  type: 'Rejected';
  payload: { byMemberId: string; reason: string };
};

export type WithdrawnEvent = BaseEvent & {
  type: 'Withdrawn';
  payload: { byMemberId: string };
};

export type UnapprovedEvent = BaseEvent & {
  type: 'Unapproved';
  payload: { byMemberId: string; reason?: string | undefined };
};

export type AttachedToRunEvent = BaseEvent & {
  type: 'AttachedToRun';
  payload: { runId: string };
};

export type EjectedFromRunEvent = BaseEvent & {
  type: 'EjectedFromRun';
  payload: { runId: string; byMemberId: string; reason?: string | undefined };
};

export type ArchivedEvent = BaseEvent & {
  type: 'Archived';
  // 'run_finished' added 2026-05-03: cascaded from FinishRun so the
  // session leaves 'in_run' and lands in a terminal state visible in
  // the run-history view but no longer prompting the user with active
  // banners on the order page.
  payload: { reason: 'eod' | 'manual' | 'run_finished' };
};

export type OrderEvent =
  | DraftStartedEvent
  | ItemAdjustedEvent
  | ItemNoteSetEvent
  | SessionNoteSetEvent
  | SessionExtrasSetEvent
  | SubmittedEvent
  | ClaimedEvent
  | ClaimReleasedEvent
  | ApprovedEvent
  | RejectedEvent
  | WithdrawnEvent
  | UnapprovedEvent
  | AttachedToRunEvent
  | EjectedFromRunEvent
  | ArchivedEvent;

/** Type narrowing helper. */
export function isOrderEvent(e: { type: string }): e is OrderEvent {
  return [
    'DraftStarted',
    'ItemAdjusted',
    'ItemNoteSet',
    'SessionNoteSet',
    'SessionExtrasSet',
    'Submitted',
    'Claimed',
    'ClaimReleased',
    'Approved',
    'Rejected',
    'Withdrawn',
    'Unapproved',
    'AttachedToRun',
    'EjectedFromRun',
    'Archived',
  ].includes(e.type);
}
