/**
 * Order router — the canonical event-sourced flow.
 *
 * Reads:   query the read_model.order_sessions_v + order_items_v
 * Writes:  load events → decide() → append events → project → return new state
 *
 * decide() is pure (`@compass/domain`); this file is the *only* place where
 * that pure logic touches the DB and the network.
 */
import { TRPCError } from '@trpc/server';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { schema as s } from '@compass/db';
import {
  AdjustItemInputSchema,
  PendingListInputSchema,
  RejectInputSchema,
  SessionDetailInputSchema,
  SetNoteInputSchema,
  SetSessionNoteInputSchema,
  SimpleSessionCommandSchema,
  TodaySessionInputSchema,
  UnapproveInputSchema,
} from '@compass/contracts';
import {
  apply,
  decide,
  emptyState,
  type ActorCtx,
  type OrderEvent,
  type OrderState,
  type SkuCtx,
} from '@compass/domain/order';
import { DomainError } from '@compass/domain';
import { authedProcedure, rethrowDomainError, router } from '../trpc';
import { appendEvents, readStream } from '../../services/eventStore';
import { projectOrder } from '../../services/orderProjection';
import { dispatchOrderEventNotifications } from '../../services/notifyForEvent';
import {
  assertActorAssignedToStore,
  effectivePermissionsForStore,
  getActorStoreIds,
} from '../../services/storeScope';
import { hub } from '../../realtime/hub';

function todayInOrgTz(): string {
  // For M0 we accept the server's UTC date. Org-local date support comes
  // when we wire org.timezone into req ctx (M1).
  return new Date().toISOString().slice(0, 10);
}

function buildActor(
  ctx: {
    session: NonNullable<{ permissions: ReadonlySet<string>; userId: string; memberId: string }>;
  },
  state: OrderState,
  /** When provided, overrides ctx.session.permissions — used by
   *  `runSimpleCommand` to inject the per-store effective permissions
   *  (with allow/deny overrides applied) so the domain command's
   *  `actor.permissions.has(...)` checks reflect store-scoped grants
   *  (added 2026-05-06). */
  effectivePermissions?: ReadonlySet<string>,
): ActorCtx {
  return {
    userId: ctx.session.userId,
    memberId: ctx.session.memberId,
    permissions: effectivePermissions ?? ctx.session.permissions,
    isClaimer: state.claimedByMemberId === ctx.session.memberId,
  };
}

async function loadSku(db: import('@compass/db').DB, orgId: string, skuId: string): Promise<SkuCtx> {
  const row = await db.query.skus.findFirst({
    where: (k, { eq: eq2, and: and2 }) => and2(eq2(k.id, skuId), eq2(k.orgId, orgId)),
  });
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'order.errors.skuMissing' });
  return { id: row.id, step: row.step, unit: row.unit, isArchived: row.isArchived };
}

export const orderRouter = router({
  /**
   * Returns the (storeId, date) session — shared across the store's staff.
   * Empty/null when nobody has touched it yet today.
   */
  todaySession: authedProcedure.input(TodaySessionInputSchema).query(async ({ ctx, input }) => {
    return ctx.withOrg(async (tx) => {
      // Verify storeId belongs to my org (cross-tenant guard).
      const store = await tx.query.stores.findFirst({
        where: (st, { eq: eq2, and: and2 }) =>
          and2(eq2(st.id, input.storeId), eq2(st.orgId, ctx.session!.orgId)),
      });
      if (!store) throw new TRPCError({ code: 'FORBIDDEN', message: 'auth.errors.storeForbidden' });
      // Multi-store isolation: even within the same org, a member must
      // be assigned to this store to read its draft.
      await assertActorAssignedToStore(
        tx,
        ctx.session!.memberId,
        input.storeId,
        ctx.session!.permissions,
      );

      const date = input.date ?? todayInOrgTz();
      // 0005 (2026-05-04): per-member sessions. Each staff sees ONLY
      // their own draft for this (store, date) — never another staff's.
      // The unique index now keys on initiated_by_member_id, so multiple
      // sessions can co-exist; this query picks the requesting user's.
      const session = await tx.query.orderSessionsV.findFirst({
        where: (sess, { eq: eq2, and: and2 }) =>
          and2(
            eq2(sess.orgId, ctx.session!.orgId),
            eq2(sess.storeId, input.storeId),
            eq2(sess.orderDate, date),
            eq2(sess.initiatedByMemberId, ctx.session!.memberId),
          ),
      });
      if (!session) return null;
      const items = await tx.query.orderItemsV.findMany({
        where: (it, { eq: eq2 }) => eq2(it.sessionId, session.id),
      });
      // Per-(sku, member) rows. Aggregate by sku for the UI's running
      // total; also expose the raw per-contributor rows so the OrderPage
      // can show "Apple — your 3, total 5" and ApprovalPage can show
      // the breakdown for in-place manager edits.
      const totalBySku = new Map<string, number>();
      for (const it of items) {
        const v = Number(it.qty);
        if (v > 0) totalBySku.set(it.skuId, (totalBySku.get(it.skuId) ?? 0) + v);
      }
      return {
        id: session.id,
        storeId: session.storeId,
        initiatedByMemberId: session.initiatedByMemberId,
        submittedByMemberId: session.submittedByMemberId,
        orderDate: session.orderDate,
        status: session.status,
        claimedByMemberId: session.claimedByMemberId,
        claimedAt: session.claimedAt?.toISOString() ?? null,
        submittedAt: session.submittedAt?.toISOString() ?? null,
        decidedAt: session.decidedAt?.toISOString() ?? null,
        decidedByMemberId: session.decidedByMemberId,
        rejectReason: session.rejectReason,
        runId: session.runId,
        lastSeq: session.lastSeq,
        /** Session-level free-text "其他物品" note (M1.8). */
        notes: session.notes,
        /** Aggregate qty per SKU (sum across contributors). */
        totals: [...totalBySku.entries()].map(([skuId, qty]) => ({
          skuId,
          qty: qty.toFixed(3).replace(/\.?0+$/, ''),
        })),
        /** Raw per-(sku, contributor) rows. */
        items: items.map((i) => ({
          skuId: i.skuId,
          contributorMemberId: i.contributorMemberId,
          qty: i.qty,
          note: i.note,
          updatedByMemberId: i.updatedByMemberId,
          updatedAt: i.updatedAt?.toISOString() ?? null,
        })),
      };
    });
  }),

  /** Look up a session by id (any status). Used by ApprovalPage's expand-row,
   *  Withdraw history, RunPage's session-list. */
  sessionDetail: authedProcedure
    .input(SessionDetailInputSchema)
    .query(async ({ ctx, input }) => {
      return ctx.withOrg(async (tx) => {
        const session = await tx.query.orderSessionsV.findFirst({
          where: (sess, { eq: eq2, and: and2 }) =>
            and2(eq2(sess.id, input.sessionId), eq2(sess.orgId, ctx.session!.orgId)),
        });
        if (!session) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'order.errors.sessionMissing' });
        }
        await assertActorAssignedToStore(
          tx,
          ctx.session!.memberId,
          session.storeId,
          ctx.session!.permissions,
        );
        const items = await tx.query.orderItemsV.findMany({
          where: (it, { eq: eq2 }) => eq2(it.sessionId, session.id),
        });
        // Same shape as todaySession: per-(sku, contributor) rows + sku totals.
        const totalBySku = new Map<string, number>();
        for (const it of items) {
          const v = Number(it.qty);
          if (v > 0) totalBySku.set(it.skuId, (totalBySku.get(it.skuId) ?? 0) + v);
        }
        return {
          id: session.id,
          storeId: session.storeId,
          initiatedByMemberId: session.initiatedByMemberId,
          submittedByMemberId: session.submittedByMemberId,
          orderDate: session.orderDate,
          status: session.status,
          claimedByMemberId: session.claimedByMemberId,
          claimedAt: session.claimedAt?.toISOString() ?? null,
          submittedAt: session.submittedAt?.toISOString() ?? null,
          decidedAt: session.decidedAt?.toISOString() ?? null,
          decidedByMemberId: session.decidedByMemberId,
          rejectReason: session.rejectReason,
          runId: session.runId,
          lastSeq: session.lastSeq,
          notes: session.notes,
          totals: [...totalBySku.entries()].map(([skuId, qty]) => ({
            skuId,
            qty: qty.toFixed(3).replace(/\.?0+$/, ''),
          })),
          items: items.map((i) => ({
            skuId: i.skuId,
            contributorMemberId: i.contributorMemberId,
            qty: i.qty,
            note: i.note,
            updatedByMemberId: i.updatedByMemberId,
            updatedAt: i.updatedAt?.toISOString() ?? null,
          })),
        };
      });
    }),

  /** All sessions in an approver's queue.
   *
   *  Enriched: each row carries `storeName`, `memberName`, `itemCount`,
   *  `totalQty` so the FE doesn't need 3+ extra round-trips per card. */
  pendingList: authedProcedure.input(PendingListInputSchema).query(async ({ ctx, input }) => {
    return ctx.withOrg(async (tx) => {
      // Scope: a manager only sees their assigned stores' queues.
      // Admins see everything (getActorStoreIds returns null = no filter).
      const allowedStoreIds = await getActorStoreIds(
        tx,
        ctx.session!.memberId,
        ctx.session!.permissions,
      );
      if (allowedStoreIds !== null && allowedStoreIds.length === 0) {
        // No assigned stores → nothing to approve.
        return [];
      }
      const storeFilterClause =
        allowedStoreIds === null
          ? undefined
          : input.storeId
            ? // Caller asked for a specific store — only allowed if it's
              // in their scope.
              allowedStoreIds.includes(input.storeId)
              ? eq(s.orderSessionsV.storeId, input.storeId)
              : // Asked for a store they don't own → return empty rather
                // than 403; queue UIs filter by store and we don't want
                // to break them with errors.
                eq(s.orderSessionsV.storeId, '00000000-0000-0000-0000-000000000000')
            : inArray(s.orderSessionsV.storeId, allowedStoreIds);

      const sessions = await tx
        .select()
        .from(s.orderSessionsV)
        .where(
          and(
            eq(s.orderSessionsV.orgId, ctx.session!.orgId),
            input.status
              ? eq(s.orderSessionsV.status, input.status)
              : eq(s.orderSessionsV.status, 'submitted'),
            // If allowedStoreIds is null, no scoping; otherwise applied above.
            storeFilterClause,
            !storeFilterClause && input.storeId
              ? eq(s.orderSessionsV.storeId, input.storeId)
              : undefined,
            input.date ? eq(s.orderSessionsV.orderDate, input.date) : undefined,
          ),
        )
        .orderBy(desc(s.orderSessionsV.submittedAt))
        .limit(100);
      if (sessions.length === 0) return [];

      const sessionIds = sessions.map((x) => x.id);
      const storeIds = [...new Set(sessions.map((x) => x.storeId))];
      // Display attribution: prefer the submitter (the person who actually
      // finalized the order), fall back to the initiator (first to add a
      // line) if not yet submitted.
      const memberIds = [
        ...new Set(
          sessions
            .map((x) => x.submittedByMemberId ?? x.initiatedByMemberId)
            .filter(Boolean) as string[],
        ),
      ];
      // Item-level distinct contributors per session (for "edited by N people" stat).
      const [items, stores, members] = await Promise.all([
        tx.query.orderItemsV.findMany({
          where: (it, { inArray }) => inArray(it.sessionId, sessionIds),
        }),
        tx.query.stores.findMany({
          where: (st, { inArray }) => inArray(st.id, storeIds),
        }),
        memberIds.length
          ? tx
              .select({
                memberId: s.members.id,
                displayName: s.users.displayName,
                avatarUrl: s.users.avatarUrl,
              })
              .from(s.members)
              .innerJoin(s.users, eq(s.users.id, s.members.userId))
              .where(inArray(s.members.id, memberIds))
          : Promise.resolve([] as Array<{ memberId: string; displayName: string; avatarUrl: string | null }>),
      ]);

      const storeById = new Map(stores.map((x) => [x.id, x]));
      const memberById = new Map(members.map((x) => [x.memberId, x]));

      // Per (session, sku) aggregate first, then per-session summary.
      const skuTotalsBySession = new Map<string, Map<string, number>>();
      const contributorsBySession = new Map<string, Set<string>>();
      for (const it of items) {
        const qty = Number(it.qty);
        const skuTotals = skuTotalsBySession.get(it.sessionId) ?? new Map<string, number>();
        if (qty > 0) {
          skuTotals.set(it.skuId, (skuTotals.get(it.skuId) ?? 0) + qty);
        }
        skuTotalsBySession.set(it.sessionId, skuTotals);
        const cs = contributorsBySession.get(it.sessionId) ?? new Set<string>();
        if (it.contributorMemberId && qty > 0) cs.add(it.contributorMemberId);
        contributorsBySession.set(it.sessionId, cs);
      }
      const aggregateBySession = new Map<
        string,
        { itemCount: number; totalQty: number; contributors: Set<string> }
      >();
      for (const [sessionId, skuTotals] of skuTotalsBySession) {
        let count = 0;
        let total = 0;
        for (const v of skuTotals.values()) {
          if (v > 0) {
            count += 1;
            total += v;
          }
        }
        aggregateBySession.set(sessionId, {
          itemCount: count,
          totalQty: total,
          contributors: contributorsBySession.get(sessionId) ?? new Set<string>(),
        });
      }

      return sessions.map((sess) => {
        const agg = aggregateBySession.get(sess.id) ?? {
          itemCount: 0,
          totalQty: 0,
          contributors: new Set<string>(),
        };
        const store = storeById.get(sess.storeId);
        const attribMemberId = sess.submittedByMemberId ?? sess.initiatedByMemberId;
        const member = attribMemberId ? memberById.get(attribMemberId) : null;
        return {
          ...sess,
          claimedAt: sess.claimedAt?.toISOString() ?? null,
          submittedAt: sess.submittedAt?.toISOString() ?? null,
          decidedAt: sess.decidedAt?.toISOString() ?? null,
          updatedAt: sess.updatedAt?.toISOString() ?? null,
          storeName: store?.name ?? null,
          storeCode: store?.code ?? null,
          /** "Submitted by" name (or initiator if not yet submitted). */
          attribDisplayName: member?.displayName ?? null,
          attribAvatarUrl: member?.avatarUrl ?? null,
          itemCount: agg.itemCount,
          totalQty: agg.totalQty.toFixed(3).replace(/\.?0+$/, ''),
          contributorCount: agg.contributors.size,
        };
      });
    });
  }),

  /** Adjust an item qty. Lazy-creates a draft if none exists for today. */
  adjustItem: authedProcedure.input(AdjustItemInputSchema).mutation(async ({ ctx, input }) => {
    const date = input.date ?? todayInOrgTz();
    return ctx.withOrg(async (tx) => {
      // Verify store ownership.
      const store = await tx.query.stores.findFirst({
        where: (st, { eq: eq2, and: and2 }) =>
          and2(eq2(st.id, input.storeId), eq2(st.orgId, ctx.session!.orgId)),
      });
      if (!store) throw new TRPCError({ code: 'FORBIDDEN', message: 'auth.errors.storeForbidden' });
      // SECURITY (2026-05-04): refuse mutations against soft-deleted
      // stores. Previously the row still existed so this query
      // succeeded, then the SKU/qty write went through silently into
      // an "archived" store's session. Now both staff and admins are
      // blocked. (Admins editing the store's history still works via
      // admin endpoints — this only locks order-write.)
      if (!store.isActive) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'auth.errors.storeArchived',
        });
      }
      await assertActorAssignedToStore(
        tx,
        ctx.session!.memberId,
        input.storeId,
        ctx.session!.permissions,
      );

      const sku = await loadSku(tx, ctx.session!.orgId, input.skuId);

      // 0005 (2026-05-04): per-member session lookup.
      //   - Self-edit:     session keyed by (org, store, ME, date).
      //                    Lazy-created if missing.
      //   - Manager-edit:  when `targetMemberId` is supplied, look up
      //                    the TARGET staff's session and edit that.
      //                    Manager doesn't get their own session
      //                    auto-created in this path. Domain
      //                    `assertCanEditSession` then verifies the
      //                    actor is the claimer of that session.
      const ownerForLookup = input.targetMemberId ?? ctx.session!.memberId;
      let session = await tx.query.orderSessionsV.findFirst({
        where: (sess, { eq: eq2, and: and2 }) =>
          and2(
            eq2(sess.orgId, ctx.session!.orgId),
            eq2(sess.storeId, input.storeId),
            eq2(sess.orderDate, date),
            eq2(sess.initiatedByMemberId, ownerForLookup),
          ),
      });

      let state: OrderState;
      let streamId: string;
      const collected: OrderEvent[] = [];

      if (!session) {
        // 0005: only allow lazy-create when the actor is editing their
        // OWN session. A manager passing targetMemberId for a staff
        // whose session doesn't exist yet must not create a phantom
        // draft on their behalf — the staff has to start their own.
        if (input.targetMemberId && input.targetMemberId !== ctx.session!.memberId) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'order.errors.sessionMissing',
          });
        }
        streamId = randomUUID();
        state = emptyState(streamId);
        // Implicit StartDraft. Initiator = first member to add a line.
        const startEvents = decide(
          state,
          {
            type: 'StartDraft',
            orgId: ctx.session!.orgId,
            storeId: input.storeId,
            orderDate: date,
            actor: buildActor(ctx, state),
          },
        );
        for (const e of startEvents) {
          state = apply(state, e);
          collected.push(e);
        }
      } else {
        streamId = session.id;
        const events = (await readStream(tx, 'order', streamId)) as unknown as OrderEvent[];
        state = emptyState(streamId);
        for (const e of events) state = apply(state, e);
      }

      try {
        const adjustEvents = decide(state, {
          type: 'AdjustItem',
          skuId: input.skuId,
          qty: input.qty,
          sku,
          actor: buildActor(ctx, state),
          targetMemberId: input.targetMemberId,
          correlationId: input.idempotencyKey,
        });
        if (adjustEvents.length === 0 && collected.length === 0) {
          // No-op: existing qty equals incoming qty and no implicit start needed.
          return { sessionId: streamId, lastSeq: state.seq, applied: [] };
        }
        for (const e of adjustEvents) {
          state = apply(state, e);
          collected.push(e);
        }
      } catch (err) {
        rethrowDomainError(err);
      }

      try {
        await appendEvents(tx, {
          streamType: 'order',
          streamId,
          orgId: ctx.session!.orgId,
          events: collected.map((e) => ({
            type: e.type,
            seq: e.seq,
            payload: e.payload,
            actorUserId: e.actorUserId,
            actorMemberId: e.actorMemberId,
            occurredAt: e.occurredAt,
            correlationId: e.correlationId,
            causationId: e.causationId,
          })),
          idempotencyKey: input.idempotencyKey,
        });
      } catch (err) {
        // Optimistic concurrency: (streamId, seq) collision → tell client to refetch.
        if (isUniqueViolation(err)) {
          ctx.log.warn(
            {
              streamId,
              skuId: input.skuId,
              userId: ctx.session!.userId,
              seq: state.seq,
            },
            'order.adjustItem CONFLICT (concurrent writers)',
          );
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'order.errors.staleSeq',
          });
        }
        ctx.log.error(
          {
            err: err instanceof Error ? err.message : String(err),
            streamId,
            skuId: input.skuId,
            userId: ctx.session!.userId,
          },
          'order.adjustItem failed',
        );
        throw err;
      }

      await projectOrder(tx, ctx.session!.orgId, collected);
      return { sessionId: streamId, lastSeq: state.seq, applied: collected.map((e) => e.type) };
    });
  }),

  setNote: authedProcedure.input(SetNoteInputSchema).mutation(async ({ ctx, input }) => {
    return ctx.withOrg(async (tx) => {
      const session = await loadSession(tx, ctx.session!.orgId, input.sessionId);
      const events = (await readStream(tx, 'order', session.id)) as unknown as OrderEvent[];
      let state = emptyState(session.id);
      for (const e of events) state = apply(state, e);
      try {
        const out = decide(state, {
          type: 'SetNote',
          skuId: input.skuId,
          note: input.note,
          actor: buildActor(ctx, state),
          targetMemberId: input.targetMemberId,
        });
        if (out.length === 0) return { lastSeq: state.seq };
        await appendEvents(tx, {
          streamType: 'order',
          streamId: session.id,
          orgId: ctx.session!.orgId,
          events: out.map((e) => ({ ...e })),
        });
        for (const e of out) state = apply(state, e);
        await projectOrder(tx, ctx.session!.orgId, out);
        return { lastSeq: state.seq };
      } catch (err) {
        rethrowDomainError(err);
      }
    });
  }),

  /**
   * Session-level free-text note ("其他物品"). M1.8 (2026-05-07).
   * Mirrors setNote's flow but with no skuId/targetMemberId — the
   * note belongs to the session. Same edit gate as line items
   * (only the session owner during draft/rejected, claimer during
   * submitted-with-claim review).
   */
  setSessionNote: authedProcedure
    .input(SetSessionNoteInputSchema)
    .mutation(async ({ ctx, input }) => {
      return ctx.withOrg(async (tx) => {
        const session = await loadSession(tx, ctx.session!.orgId, input.sessionId);
        await assertActorAssignedToStore(
          tx,
          ctx.session!.memberId,
          session.storeId,
          ctx.session!.permissions,
        );
        const effectivePerms = await effectivePermissionsForStore(
          tx,
          ctx.session!.memberId,
          session.storeId,
          ctx.session!.permissions,
        );
        const events = (await readStream(tx, 'order', session.id)) as unknown as OrderEvent[];
        let state = emptyState(session.id);
        for (const e of events) state = apply(state, e);
        try {
          const out = decide(state, {
            type: 'SetSessionNote',
            note: input.note,
            actor: buildActor(ctx, state, effectivePerms),
          });
          if (out.length === 0) return { lastSeq: state.seq };
          await appendEvents(tx, {
            streamType: 'order',
            streamId: session.id,
            orgId: ctx.session!.orgId,
            events: out.map((e) => ({ ...e })),
          });
          for (const e of out) state = apply(state, e);
          await projectOrder(tx, ctx.session!.orgId, out);
          // Realtime fan-out so collaborators on the same session see
          // the note appear without manual refetch (managers eyeing
          // the approval queue, purchasers watching the run preview).
          hub.publish(ctx.session!.orgId, {
            type: 'order.changed',
            orgId: ctx.session!.orgId,
            sessionId: state.streamId,
            lastSeq: state.seq,
          });
          return { lastSeq: state.seq };
        } catch (err) {
          rethrowDomainError(err);
        }
      });
    }),

  submit: authedProcedure.input(SimpleSessionCommandSchema).mutation(async ({ ctx, input }) =>
    runSimpleCommand(ctx, input.sessionId, (state, perms) =>
      decide(state, { type: 'Submit', actor: buildActor(ctx, state, perms) }),
    ),
  ),

  claim: authedProcedure.input(SimpleSessionCommandSchema).mutation(async ({ ctx, input }) =>
    runSimpleCommand(ctx, input.sessionId, (state, perms) =>
      decide(state, { type: 'Claim', actor: buildActor(ctx, state, perms) }),
    ),
  ),

  releaseClaim: authedProcedure
    .input(SimpleSessionCommandSchema.extend({ reason: SimpleSessionCommandSchema.shape.expectedSeq.optional() }).pick({ sessionId: true }))
    .mutation(async ({ ctx, input }) =>
      runSimpleCommand(ctx, input.sessionId, (state, perms) =>
        decide(state, { type: 'ReleaseClaim', reason: 'manual', actor: buildActor(ctx, state, perms) }),
      ),
    ),

  approve: authedProcedure.input(SimpleSessionCommandSchema).mutation(async ({ ctx, input }) =>
    runSimpleCommand(ctx, input.sessionId, (state, perms) =>
      decide(state, { type: 'Approve', actor: buildActor(ctx, state, perms) }),
    ),
  ),

  reject: authedProcedure.input(RejectInputSchema).mutation(async ({ ctx, input }) =>
    runSimpleCommand(ctx, input.sessionId, (state, perms) =>
      decide(state, { type: 'Reject', reason: input.reason, actor: buildActor(ctx, state, perms) }),
    ),
  ),

  withdraw: authedProcedure.input(SimpleSessionCommandSchema).mutation(async ({ ctx, input }) =>
    runSimpleCommand(ctx, input.sessionId, (state, perms) =>
      decide(state, { type: 'Withdraw', actor: buildActor(ctx, state, perms) }),
    ),
  ),

  unapprove: authedProcedure.input(UnapproveInputSchema).mutation(async ({ ctx, input }) =>
    runSimpleCommand(ctx, input.sessionId, (state, perms) =>
      decide(state, { type: 'Unapprove', reason: input.reason, actor: buildActor(ctx, state, perms) }),
    ),
  ),
});

async function runSimpleCommand(
  ctx: Awaited<ReturnType<typeof import('../context.js').createContext>>,
  sessionId: string,
  produce: (state: OrderState, perms: ReadonlySet<string>) => OrderEvent[],
): Promise<{ lastSeq: number }> {
  return ctx.withOrg(async (tx) => {
    const session = await loadSession(tx, ctx.session!.orgId, sessionId);
    // Multi-store guard: the actor must be assigned to this session's
    // store (or be an admin / super_admin via the bypass). This makes
    // "store A's manager approves store B's order" impossible at the
    // server level.
    await assertActorAssignedToStore(
      tx,
      ctx.session!.memberId,
      session.storeId,
      ctx.session!.permissions,
    );
    // Per-store effective permissions (added 2026-05-06). Apply
    // store-scoped allow/deny overrides on top of the flat session
    // perms. The domain command's `actor.permissions.has(...)` then
    // sees the right answer for THIS store. Admins keep their full
    // set (helper handles the bypass).
    const effectivePerms = await effectivePermissionsForStore(
      tx,
      ctx.session!.memberId,
      session.storeId,
      ctx.session!.permissions,
    );
    const events = (await readStream(tx, 'order', session.id)) as unknown as OrderEvent[];
    let state = emptyState(session.id);
    for (const e of events) state = apply(state, e);
    try {
      const out = produce(state, effectivePerms);
      if (out.length === 0) return { lastSeq: state.seq };
      await appendEvents(tx, {
        streamType: 'order',
        streamId: session.id,
        orgId: ctx.session!.orgId,
        events: out.map((e) => ({ ...e })),
      });
      for (const e of out) state = apply(state, e);
      await projectOrder(tx, ctx.session!.orgId, out);
      // Fire notifications inside the same tx as the projection so
      // recipients see them in lockstep with the read model.
      await dispatchOrderEventNotifications(tx, ctx.session!.orgId, ctx.session!.userId, state, out);
      // Best-effort realtime fan-out so other tabs in this org refetch.
      hub.publish(ctx.session!.orgId, {
        type: 'order.changed',
        orgId: ctx.session!.orgId,
        sessionId: state.streamId,
        lastSeq: state.seq,
      });
      return { lastSeq: state.seq };
    } catch (err) {
      // Surface the failure in journalctl so we can diagnose silent-fail
      // reports without having to attach a debugger to the user's phone.
      ctx.log.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          domainCode: err instanceof DomainError ? err.code : undefined,
          i18nKey: err instanceof DomainError ? err.i18nKey : undefined,
          sessionId,
          userId: ctx.session?.userId,
        },
        'order.runSimpleCommand failed',
      );
      if (err instanceof DomainError) rethrowDomainError(err);
      if (isUniqueViolation(err)) {
        throw new TRPCError({ code: 'CONFLICT', message: 'order.errors.staleSeq' });
      }
      throw err;
    }
  });
}

async function loadSession(db: import('@compass/db').DB, orgId: string, sessionId: string) {
  const row = await db.query.orderSessionsV.findFirst({
    where: (sess, { eq: eq2, and: and2 }) =>
      and2(eq2(sess.id, sessionId), eq2(sess.orgId, orgId)),
  });
  if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'order.errors.sessionMissing' });
  return row;
}

function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505');
}
