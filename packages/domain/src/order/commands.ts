/**
 * Order commands → events.
 *
 * `decide()` is a pure function: (state, command, ctx) → events[].
 * No DB, no clock leaks. The infra layer wraps decide() in a transaction
 * with optimistic seq enforcement: if `(streamId, seq+N)` collides with a
 * concurrent writer, postgres unique violation → retry with fresh state.
 */
import { conflict, forbidden, preconditionFailed, validation } from '../shared/errors';
import type { Clock } from '../shared/clock';
import { systemClock } from '../shared/clock';
import type { OrderEvent, SessionExtraItem } from './events';
import type { OrderState } from './state';
import { itemKey } from './state';

export type OrderCommand =
  | {
      type: 'StartDraft';
      orgId: string;
      storeId: string;
      orderDate: string;
      actor: ActorCtx;
    }
  | {
      type: 'AdjustItem';
      skuId: string;
      qty: string;
      sku: SkuCtx;
      actor: ActorCtx;
      /** Whose contributor row to mutate. Defaults to actor.memberId.
       *  Setting to a different member requires `order.approve` (manager
       *  reviewing a submitted order, per #6). */
      targetMemberId?: string;
      correlationId?: string;
    }
  | { type: 'SetNote'; skuId: string; note: string | null; actor: ActorCtx; targetMemberId?: string }
  | { type: 'SetSessionNote'; note: string | null; actor: ActorCtx }
  /**
   * M3.16-C (2026-05-16): atomic replace of the session's structured
   * "其他物品" list. Payload contains the full new list; an empty
   * array clears all extras. Same edit gate as SetSessionNote.
   */
  | { type: 'SetSessionExtras'; extras: SessionExtraItem[]; actor: ActorCtx }
  /**
   * M3.37 (2026-05-19, Wave2 #5): purchaser marks one "其他物品" row as
   * bought/unavailable/pending during a run. The session must be
   * in_run (= attached to an active run); the actor must hold
   * `run.purchase`. Index addresses the row in `state.extras`.
   */
  | {
      type: 'MarkExtraStatus';
      extraIndex: number;
      status: 'pending' | 'bought' | 'unavailable';
      actor: ActorCtx;
    }
  | { type: 'Submit'; actor: ActorCtx }
  | { type: 'Claim'; actor: ActorCtx }
  | { type: 'ReleaseClaim'; actor: ActorCtx; reason: 'manual' | 'pagehide' }
  | { type: 'Approve'; actor: ActorCtx }
  | { type: 'Reject'; actor: ActorCtx; reason: string }
  | { type: 'Withdraw'; actor: ActorCtx }
  | { type: 'Unapprove'; actor: ActorCtx; reason?: string | undefined }
  | { type: 'AttachToRun'; runId: string; actor: ActorCtx }
  | { type: 'EjectFromRun'; runId: string; actor: ActorCtx; reason?: string | undefined }
  // Terminal archive — emitted when a run finishes (FinishRun cascade) or
  // by a future end-of-day batch. Locks the session forever; status flips
  // to 'archived' so the order page no longer shows it as "in run".
  | { type: 'Archive'; reason: 'eod' | 'manual' | 'run_finished'; actor: ActorCtx };

export interface ActorCtx {
  userId: string;
  memberId: string;
  /**
   * Permissions resolved by the policy engine. decide() does NOT recompute
   * permissions; it trusts the caller to have evaluated `policy.eval()`.
   * Use these for cheap branching, not authorization.
   */
  permissions: ReadonlySet<string>;
  /** Whether this actor is the current claimer of the session. */
  isClaimer: boolean;
}

export interface SkuCtx {
  id: string;
  step: string; // decimal as string
  unit: string;
  isArchived: boolean;
}

export interface DecideOptions {
  clock?: Clock;
}

const STEP_TOLERANCE = 1e-6;

export function decide(
  state: OrderState,
  command: OrderCommand,
  options: DecideOptions = {},
): OrderEvent[] {
  const clock = options.clock ?? systemClock;
  const now = clock.now();
  const baseFor = (seqOffset: number, type: OrderEvent['type']) => ({
    streamId: state.streamId,
    seq: state.seq + seqOffset,
    occurredAt: now,
    actorUserId: command.actor.userId,
    actorMemberId: command.actor.memberId,
    type,
    correlationId: 'correlationId' in command ? command.correlationId : undefined,
  });

  switch (command.type) {
    case 'StartDraft': {
      if (state.status !== 'absent') {
        throw conflict('order.errors.alreadyStarted', { status: state.status });
      }
      if (!command.orderDate.match(/^\d{4}-\d{2}-\d{2}$/)) {
        throw validation('order.errors.invalidDate');
      }
      // Per-store collaborative model: any member with `order.draft` can
      // start the day's session for their store. The first one to add a
      // line is recorded as the initiator (informational only).
      if (!command.actor.permissions.has('order.draft')) {
        throw forbidden('order.errors.cannotDraft');
      }
      return [
        {
          ...baseFor(1, 'DraftStarted'),
          type: 'DraftStarted',
          payload: {
            orgId: command.orgId,
            storeId: command.storeId,
            initiatedByMemberId: command.actor.memberId,
            orderDate: command.orderDate,
          },
        },
      ];
    }

    case 'AdjustItem': {
      assertActiveStream(state);
      assertCanEditSession(state, command.actor);
      // Resolve which contributor row this adjustment targets.
      // Default: actor's own row. Manager override allowed only with
      // `order.approve` AND the target row already exists (we don't
      // let managers create lines on behalf of staff who haven't
      // contributed at all — that would be confusing).
      const target = command.targetMemberId ?? command.actor.memberId;
      if (target !== command.actor.memberId) {
        if (!command.actor.permissions.has('order.approve')) {
          throw forbidden('order.errors.cannotEditOthersLine');
        }
        const targetKey = itemKey(command.skuId, target);
        if (!state.items.has(targetKey)) {
          throw validation('order.errors.targetLineNotFound', {
            skuId: command.skuId,
            target,
          });
        }
      }
      if (command.sku.isArchived) {
        throw validation('order.errors.skuArchived', { skuId: command.skuId });
      }
      const qty = parseDecimal(command.qty, 'order.errors.invalidQty');
      if (qty < 0) throw validation('order.errors.qtyNegative');
      const step = parseDecimal(command.sku.step, 'order.errors.invalidStep');
      if (step > 0 && !isMultipleOf(qty, step)) {
        throw validation('order.errors.qtyNotMultipleOfStep', { step: command.sku.step });
      }
      const prev = state.items.get(itemKey(command.skuId, target))?.qty ?? '0';
      // Idempotent merge: same qty → no event.
      if (sameDecimal(prev, command.qty)) return [];
      return [
        {
          ...baseFor(1, 'ItemAdjusted'),
          type: 'ItemAdjusted',
          payload: {
            skuId: command.skuId,
            qty: normalizeDecimal(command.qty),
            prevQty: prev,
            byMemberId: command.actor.memberId,
            forMemberId: target,
          },
        },
      ];
    }

    case 'SetNote': {
      assertActiveStream(state);
      assertCanEditSession(state, command.actor);
      const target = command.targetMemberId ?? command.actor.memberId;
      if (target !== command.actor.memberId && !command.actor.permissions.has('order.approve')) {
        throw forbidden('order.errors.cannotEditOthersLine');
      }
      const note = command.note?.trim() ?? null;
      if (note && note.length > 500) throw validation('order.errors.noteTooLong');
      const prev = state.items.get(itemKey(command.skuId, target))?.note ?? null;
      if (prev === note) return [];
      return [
        {
          ...baseFor(1, 'ItemNoteSet'),
          type: 'ItemNoteSet',
          payload: {
            skuId: command.skuId,
            note,
            byMemberId: command.actor.memberId,
            forMemberId: target,
          },
        },
      ];
    }

    case 'SetSessionNote': {
      // M1.8 (2026-05-07): session-level free-text "其他物品" note.
      // Same edit gate as line items — only the session owner during
      // draft/rejected, or claimer during submitted review. Locked
      // once approved/in_run/archived.
      assertActiveStream(state);
      assertCanEditSession(state, command.actor);
      const note = command.note?.trim() || null;
      if (note && note.length > 1000) throw validation('order.errors.sessionNoteTooLong');
      // Idempotent — re-setting same value is a no-op.
      if (state.notes === note) return [];
      return [
        {
          ...baseFor(1, 'SessionNoteSet'),
          type: 'SessionNoteSet',
          payload: {
            note,
            byMemberId: command.actor.memberId,
          },
        },
      ];
    }

    case 'SetSessionExtras': {
      // M3.16-C (2026-05-16): structured "其他物品" list. Same edit
      // gate + locking rules as SetSessionNote. The whole list is
      // replaced atomically; the command layer is responsible for
      // shape validation (UI sends a clean array — the server-side
      // zod schema in the tRPC router enforces it before reaching
      // decide()), and this branch handles the domain checks:
      //   - max 50 extras per session (hard cap)
      //   - each name 1..200 chars after trim
      //   - each qty must parse > 0
      //   - each unit 1..16 chars after trim
      //   - each optional note ≤200 chars
      assertActiveStream(state);
      assertCanEditSession(state, command.actor);
      if (command.extras.length > 50) {
        throw validation('order.errors.tooManyExtras');
      }
      const normalised: SessionExtraItem[] = [];
      for (const raw of command.extras) {
        const name = (raw.name ?? '').trim();
        const unit = (raw.unit ?? '').trim();
        const qty = (raw.qty ?? '').trim();
        if (!name || name.length > 200) throw validation('order.errors.invalidExtraName');
        if (!unit || unit.length > 16) throw validation('order.errors.invalidExtraUnit');
        if (!/^\d+(\.\d{1,3})?$/.test(qty) || Number(qty) <= 0) {
          throw validation('order.errors.invalidExtraQty');
        }
        const note = raw.note?.trim() || undefined;
        if (note && note.length > 200) throw validation('order.errors.extraNoteTooLong');
        normalised.push({ name, qty, unit, ...(note ? { note } : {}) });
      }
      // Idempotent — re-setting an identical list is a no-op.
      if (extrasEqual(state.extras, normalised)) return [];
      return [
        {
          ...baseFor(1, 'SessionExtrasSet'),
          type: 'SessionExtrasSet',
          payload: {
            extras: normalised,
            byMemberId: command.actor.memberId,
          },
        },
      ];
    }

    case 'MarkExtraStatus': {
      // M3.37 (2026-05-19, Wave2 #5): purchaser updates one extra
      // row's outcome. Bound to the purchasing run lifecycle —
      // session must be `in_run` (attached to an active run, not yet
      // archived) and actor must have `run.purchase`. Out-of-range
      // index throws so a malformed FE call surfaces as a clear
      // validation error rather than a silent reducer no-op.
      assertActiveStream(state);
      if (!command.actor.permissions.has('run.purchase')) {
        throw forbidden('order.errors.cannotMarkExtra');
      }
      if (state.status !== 'in_run') {
        throw preconditionFailed('order.errors.extraStatusOnlyDuringRun', {
          status: state.status,
        });
      }
      if (
        !Number.isInteger(command.extraIndex) ||
        command.extraIndex < 0 ||
        command.extraIndex >= state.extras.length
      ) {
        throw validation('order.errors.extraIndexOutOfRange', {
          extraIndex: command.extraIndex,
          extrasLen: state.extras.length,
        });
      }
      const cur = state.extras[command.extraIndex]!;
      const prev = cur.status ?? 'pending';
      // Idempotent — re-setting same status is a no-op.
      if (prev === command.status) return [];
      return [
        {
          ...baseFor(1, 'ExtraStatusSet'),
          type: 'ExtraStatusSet',
          payload: {
            extraIndex: command.extraIndex,
            status: command.status,
            byMemberId: command.actor.memberId,
          },
        },
      ];
    }

    case 'Submit': {
      assertActiveStream(state);
      // 0005 (2026-05-04): only the SESSION OWNER can submit their own
      // session. Different staff at the same store have their own
      // separate sessions; one staff can't submit another's draft.
      if (!command.actor.permissions.has('order.submit')) {
        throw forbidden('order.errors.cannotSubmit');
      }
      if (state.initiatedByMemberId && state.initiatedByMemberId !== command.actor.memberId) {
        throw forbidden('order.errors.notOwner');
      }
      if (state.status !== 'draft' && state.status !== 'rejected') {
        throw preconditionFailed('order.errors.notSubmittable', { status: state.status });
      }
      // M3.33 (2026-05-18, Wave1 #6): an order with zero SKU rows but
      // non-empty `其他物品` extras is a legitimate submission — the
      // staff member is asking the purchaser to grab a one-off item
      // that hasn't been promoted to a catalog SKU yet. Before this
      // fix, submitting an extras-only batch threw `emptyOrder` and
      // the staff had to fake-add a SKU just to get past the gate.
      const itemCount = countNonZero(state);
      const hasExtras = state.extras.length > 0;
      if (itemCount === 0 && !hasExtras) {
        throw validation('order.errors.emptyOrder');
      }
      return [
        {
          ...baseFor(1, 'Submitted'),
          type: 'Submitted',
          payload: { itemCount, byMemberId: command.actor.memberId },
        },
      ];
    }

    case 'Claim': {
      assertActiveStream(state);
      if (!command.actor.permissions.has('order.claim')) {
        throw forbidden('order.errors.cannotClaim');
      }
      if (state.status !== 'submitted') {
        throw preconditionFailed('order.errors.notClaimable', { status: state.status });
      }
      if (state.claimedByMemberId && state.claimedByMemberId !== command.actor.memberId) {
        throw conflict('order.errors.alreadyClaimed', {
          claimedBy: state.claimedByMemberId,
        });
      }
      if (state.claimedByMemberId === command.actor.memberId) return []; // already mine
      return [
        {
          ...baseFor(1, 'Claimed'),
          type: 'Claimed',
          payload: { byMemberId: command.actor.memberId },
        },
      ];
    }

    case 'ReleaseClaim': {
      assertActiveStream(state);
      if (!state.claimedByMemberId) return [];
      const isSelf = state.claimedByMemberId === command.actor.memberId;
      // Escape valve: another approver with `order.approve` can release
      // a stale claim that's blocking the queue. Without this an idle
      // claimer freezes the order indefinitely (the original audit
      // bug 2026-05-18). The event records `byMemberId` (the overrider)
      // + reason='override' so contested releases are traceable.
      if (!isSelf && !command.actor.permissions.has('order.approve')) {
        throw forbidden('order.errors.notClaimer');
      }
      return [
        {
          ...baseFor(1, 'ClaimReleased'),
          type: 'ClaimReleased',
          payload: {
            byMemberId: command.actor.memberId,
            reason: isSelf ? command.reason : 'override',
          },
        },
      ];
    }

    case 'Approve': {
      assertActiveStream(state);
      if (!command.actor.permissions.has('order.approve')) {
        throw forbidden('order.errors.cannotApprove');
      }
      if (state.status !== 'submitted') {
        throw preconditionFailed('order.errors.notApprovable', { status: state.status });
      }
      if (state.claimedByMemberId && state.claimedByMemberId !== command.actor.memberId) {
        throw conflict('order.errors.claimedByOther');
      }
      return [
        {
          ...baseFor(1, 'Approved'),
          type: 'Approved',
          payload: { byMemberId: command.actor.memberId },
        },
      ];
    }

    case 'Reject': {
      assertActiveStream(state);
      if (!command.actor.permissions.has('order.approve')) {
        throw forbidden('order.errors.cannotApprove');
      }
      if (state.status !== 'submitted') {
        throw preconditionFailed('order.errors.notRejectable', { status: state.status });
      }
      if (state.claimedByMemberId && state.claimedByMemberId !== command.actor.memberId) {
        throw conflict('order.errors.claimedByOther');
      }
      const reason = command.reason.trim();
      if (!reason) throw validation('order.errors.rejectReasonRequired');
      if (reason.length > 500) throw validation('order.errors.noteTooLong');
      return [
        {
          ...baseFor(1, 'Rejected'),
          type: 'Rejected',
          payload: { byMemberId: command.actor.memberId, reason },
        },
      ];
    }

    case 'Withdraw': {
      assertActiveStream(state);
      // Withdraw is allowed for: the original submitter, or anyone with
      // `order.approve` (the store manager). Either can pull a submitted
      // order back to draft so the team can keep editing.
      const isSubmitter =
        state.submittedByMemberId !== null &&
        state.submittedByMemberId === command.actor.memberId;
      const isManager = command.actor.permissions.has('order.approve');
      if (!isSubmitter && !isManager) {
        throw forbidden('order.errors.cannotWithdraw');
      }
      if (state.status !== 'submitted' && state.status !== 'rejected') {
        throw preconditionFailed('order.errors.notWithdrawable', { status: state.status });
      }
      if (state.claimedByMemberId) {
        throw conflict('order.errors.cannotWithdrawWhileClaimed');
      }
      return [
        {
          ...baseFor(1, 'Withdrawn'),
          type: 'Withdrawn',
          payload: { byMemberId: command.actor.memberId },
        },
      ];
    }

    case 'Unapprove': {
      assertActiveStream(state);
      if (!command.actor.permissions.has('order.unapprove')) {
        throw forbidden('order.errors.cannotUnapprove');
      }
      if (state.status !== 'approved') {
        throw preconditionFailed('order.errors.notUnapprovable', { status: state.status });
      }
      if (state.runId) {
        throw preconditionFailed('order.errors.alreadyInRun');
      }
      return [
        {
          ...baseFor(1, 'Unapproved'),
          type: 'Unapproved',
          payload: { byMemberId: command.actor.memberId, reason: command.reason },
        },
      ];
    }

    case 'AttachToRun': {
      assertActiveStream(state);
      if (state.status !== 'approved') {
        throw preconditionFailed('order.errors.cannotAttach', { status: state.status });
      }
      return [
        {
          ...baseFor(1, 'AttachedToRun'),
          type: 'AttachedToRun',
          payload: { runId: command.runId },
        },
      ];
    }

    case 'EjectFromRun': {
      assertActiveStream(state);
      if (!command.actor.permissions.has('run.eject_session')) {
        throw forbidden('order.errors.cannotEject');
      }
      // Wave2 #15 (M3.40, 2026-05-20): make ejection IDEMPOTENT and
      // SOFTLY NO-OP when the session has already drifted out of the
      // expected (in_run + matching runId) state. Previously this
      // threw preconditionFailed, which was the original "cancel-run
      // leaves orphans" failure mode: the run.cancel cascade tried to
      // eject every attached session, and any single mismatch threw
      // a DomainError that the cascade's catch swallowed silently,
      // leaving the session stuck in `in_run`.
      //
      // Behavior matrix:
      //   - status='in_run' AND runId === command.runId  → emit event (the
      //     normal success path).
      //   - status='approved' / runId=null               → idempotent no-op
      //     (caller already got what it wanted from a prior run).
      //   - status='in_run' but runId !== command.runId  → no-op (the
      //     session has been re-attached to a different run; ejecting
      //     against the OLD runId would be a lie).
      //   - any other status (draft/submitted/rejected/archived)       → no-op
      //     (caller is racing against another workflow; not our job to
      //     destabilize it).
      // The repair worker (Wave2 #15 part B) sweeps for stuck sessions
      // and emits a fresh EjectFromRun targeted at the CURRENT runId,
      // so misalignments self-heal.
      if (state.status !== 'in_run' || state.runId !== command.runId) {
        return [];
      }
      return [
        {
          ...baseFor(1, 'EjectedFromRun'),
          type: 'EjectedFromRun',
          payload: {
            runId: command.runId,
            byMemberId: command.actor.memberId,
            reason: command.reason,
          },
        },
      ];
    }

    case 'Archive': {
      // Idempotent dedupe — re-archiving an already-archived session
      // returns []. We MUST short-circuit before assertActiveStream
      // because the latter throws for archived. Without this dedupe,
      // a re-run of the FinishRun cascade (e.g. retry on partial
      // failure) would blow up with order.errors.archived.
      if (state.status === 'archived') return [];
      if (state.status === 'absent') {
        throw preconditionFailed('order.errors.streamMissing');
      }
      // From the FinishRun cascade we expect status='in_run'. Allow
      // 'approved' too so a future "end-of-day" batch could archive
      // sessions that never made it into a run.
      if (state.status !== 'in_run' && state.status !== 'approved') {
        throw preconditionFailed('order.errors.cannotArchive', {
          status: state.status,
        });
      }
      return [
        {
          ...baseFor(1, 'Archived'),
          type: 'Archived',
          payload: { reason: command.reason },
        },
      ];
    }

    default: {
      const _exhaustive: never = command;
      void _exhaustive;
      return [];
    }
  }
}

function assertActiveStream(state: OrderState): void {
  if (state.status === 'absent') throw preconditionFailed('order.errors.streamMissing');
  if (state.status === 'archived') throw preconditionFailed('order.errors.archived');
}

/**
 * Session-level edit gate. Returns silently if the actor can edit this
 * session in the current status; throws otherwise.
 *
 * 0005 (2026-05-04) — per-member ownership restored. Rules:
 *   - draft / rejected → only the SESSION OWNER (`initiatedByMemberId`)
 *     can edit. Other members at the same store have their own
 *     separate sessions; they don't touch this one.
 *   - submitted-with-claim → only the claimer (manager mid-review).
 *   - submitted-pre-claim → only the owner (effectively "withdraw +
 *     keep editing"). Others can't claim by editing.
 *   - approved / in_run / archived → locked, nobody edits.
 *
 * The owner's `targetMemberId` override on AdjustItem is a holdover
 * from 0002's per-contributor item rows; it still works (manager mid-
 * claim can target the owner's row) but is never used to edit a
 * non-owner contributor since each session has a single owner now.
 */
function assertCanEditSession(state: OrderState, actor: ActorCtx): void {
  if (state.status === 'in_run' || state.status === 'archived') {
    throw preconditionFailed('order.errors.lockedByStatus', { status: state.status });
  }
  if (state.status === 'approved') {
    throw preconditionFailed('order.errors.lockedByStatus', { status: 'approved' });
  }
  const isOwner = state.initiatedByMemberId === actor.memberId;
  if (state.status === 'draft' || state.status === 'rejected') {
    if (!actor.permissions.has('order.draft')) {
      throw forbidden('order.errors.cannotDraft');
    }
    // The session is private to its owner. Reject edits from other
    // staff at the same store — they have their own sessions.
    if (!isOwner) {
      throw forbidden('order.errors.notOwner');
    }
    return;
  }
  if (state.status === 'submitted') {
    if (state.claimedByMemberId === actor.memberId) return; // claimer mid-review
    if (!state.claimedByMemberId && isOwner && actor.permissions.has('order.draft')) {
      return; // owner can keep editing pre-claim (effectively a withdraw)
    }
    throw forbidden('order.errors.notEditor');
  }
}

/**
 * Per-(sku, member) lines (since 0002): each contributor edits their
 * OWN row. The "edit someone else's line" path is now an explicit
 * `targetMemberId` override on AdjustItem, gated on `order.approve`.
 * No separate line-level helper needed.
 */

/**
 * Counts distinct SKUs with non-zero AGGREGATE qty (sum across
 * contributors). Two staff each adding 1 apple → counts as 1 SKU
 * with total qty 2. Single staff with 0 → counts as 0.
 */
function countNonZero(state: OrderState): number {
  const sums = new Map<string, number>();
  for (const item of state.items.values()) {
    const v = parseDecimal(item.qty, 'order.errors.invalidQty');
    sums.set(item.skuId, (sums.get(item.skuId) ?? 0) + v);
  }
  let n = 0;
  for (const total of sums.values()) {
    if (total > 0) n++;
  }
  return n;
}

// ---------- decimal helpers (string-based, no float drift) ----------

function parseDecimal(s: string, errorKey: string): number {
  const v = Number(s);
  if (!Number.isFinite(v)) throw validation(errorKey, { value: s });
  return v;
}

function normalizeDecimal(s: string): string {
  // Trim trailing zeros after decimal point, preserve at least 0.
  const v = Number(s);
  if (!Number.isFinite(v)) return s;
  // Up to 3 fractional digits to match DB precision.
  return Number(v.toFixed(3)).toString();
}

function sameDecimal(a: string, b: string): boolean {
  return Math.abs(Number(a) - Number(b)) < STEP_TOLERANCE;
}

function isMultipleOf(value: number, step: number): boolean {
  if (step <= 0) return true;
  const ratio = value / step;
  return Math.abs(ratio - Math.round(ratio)) < STEP_TOLERANCE;
}

/**
 * Deep equality check for two SessionExtraItem lists. Used to make
 * SetSessionExtras idempotent — re-issuing the same list after a
 * round-trip retry shouldn't emit a duplicate event.
 */
function extrasEqual(a: SessionExtraItem[], b: SessionExtraItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    if (ai.name !== bi.name) return false;
    if (ai.unit !== bi.unit) return false;
    if (!sameDecimal(ai.qty, bi.qty)) return false;
    if ((ai.note ?? '') !== (bi.note ?? '')) return false;
  }
  return true;
}
