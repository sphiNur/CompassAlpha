/**
 * Delivery: sending the goods to each store, and each store confirming
 * what it received.
 */
import { TRPCError } from '@trpc/server';
import {
  ConfirmStoreInputSchema,
  ConfirmStoreItemInputSchema,
  DispatchInputSchema,
  MarkStoreItemsOkInputSchema,
  RunReasonOnlyInputSchema,
  SimpleRunCommandSchema,
  UndeliverStoreInputSchema,
} from '@compass/contracts';
import {
  assertActorAssignedToStore,
  effectivePermissionsForStore,
} from '../../../services/storeScope';
import { applyRun, decideRun, type RunEvent } from '@compass/domain/run';
import { authedProcedure, idempotentMutation } from '../../trpc';
import { actorFromCtx, runSimpleCommand } from './command';

export const deliveryProcedures = {
  startDelivery: authedProcedure
    .input(SimpleRunCommandSchema)
    .mutation(async ({ ctx, input }) =>
      runSimpleCommand(ctx, input.runId, (state) =>
        decideRun(state, { type: 'StartDelivery', actor: actorFromCtx(ctx) }),
      ),
    ),

  /** Roll the run back to `purchasing` (only if no store delivered yet). */
  undoStartDelivery: authedProcedure
    .input(RunReasonOnlyInputSchema)
    .mutation(async ({ ctx, input }) =>
      runSimpleCommand(
        ctx,
        input.runId,
        (state) =>
          decideRun(state, {
            type: 'UndoStartDelivery',
            reason: input.reason,
            actor: actorFromCtx(ctx),
          }),
        { requiredPermission: 'delivery.dispatch' },
      ),
    ),

  deliverToStore: idempotentMutation.input(DispatchInputSchema).mutation(async ({ ctx, input }) => {
    // Purchaser delivering — they need run.purchase, NOT a store-scope
    // assignment. (The purchaser drives the run on behalf of all stores.)
    //
    // Per-store override (added 2026-05-06): even though the purchaser
    // doesn't need MSA, an admin may still have written a store-scoped
    // deny override on `delivery.dispatch` to lock this purchaser out
    // of one specific store's deliveries. Compute effective perms for
    // input.storeId and pass them into actorFromCtx.
    const effectivePerms = await ctx.withOrg((tx) =>
      effectivePermissionsForStore(
        tx,
        ctx.session!.memberId,
        input.storeId,
        ctx.session!.permissions,
      ),
    );
    return runSimpleCommand(
      ctx,
      input.runId,
      (state, scope) =>
        decideRun(state, {
          type: 'DeliverToStore',
          storeId: input.storeId,
          ...scope,
          actor: actorFromCtx(ctx, effectivePerms),
        }),
      { skipRunPermissionScope: true, withRunStoreIds: true },
    );
  }),

  /** Recall a delivery to a store that has not yet confirmed receipt. */
  undeliverStore: authedProcedure
    .input(UndeliverStoreInputSchema)
    .mutation(async ({ ctx, input }) => {
      const effectivePerms = await ctx.withOrg((tx) =>
        effectivePermissionsForStore(
          tx,
          ctx.session!.memberId,
          input.storeId,
          ctx.session!.permissions,
        ),
      );
      return runSimpleCommand(
        ctx,
        input.runId,
        (state) =>
          decideRun(state, {
            type: 'UndeliverStore',
            storeId: input.storeId,
            reason: input.reason,
            actor: actorFromCtx(ctx, effectivePerms),
          }),
        { skipRunPermissionScope: true },
      );
    }),

  confirmStoreItem: authedProcedure
    .input(ConfirmStoreItemInputSchema)
    .mutation(async ({ ctx, input }) => {
      // Receiver-side confirm: only members assigned to this store may
      // accept its incoming delivery. Same pass also computes the
      // store-effective permissions (added 2026-05-06) so allow/deny
      // overrides scoped to this store flow into the domain check.
      const effectivePerms = await ctx.withOrg(async (tx) => {
        await assertActorAssignedToStore(
          tx,
          ctx.session!.memberId,
          input.storeId,
          ctx.session!.permissions,
        );
        return effectivePermissionsForStore(
          tx,
          ctx.session!.memberId,
          input.storeId,
          ctx.session!.permissions,
        );
      });
      return runSimpleCommand(
        ctx,
        input.runId,
        (state) =>
          decideRun(state, {
            type: 'ConfirmStoreItem',
            storeId: input.storeId,
            skuId: input.skuId,
            status: input.status,
            note: input.note,
            photoUrl: input.photoUrl,
            receivedQty: input.receivedQty ?? null,
            actor: actorFromCtx(ctx, effectivePerms),
          }),
        { skipRunPermissionScope: true },
      );
    }),

  /**
   * Bulk receiver action: mark every undecided line at one store as OK.
   * One transaction, one projection pass and one notification dispatch.
   * Individual `StoreItemConfirmed` events remain in the audit stream.
   */
  markStoreItemsOk: authedProcedure
    .input(MarkStoreItemsOkInputSchema)
    .mutation(async ({ ctx, input }) => {
      const effectivePerms = await ctx.withOrg(async (tx) => {
        await assertActorAssignedToStore(
          tx,
          ctx.session!.memberId,
          input.storeId,
          ctx.session!.permissions,
        );
        return effectivePermissionsForStore(
          tx,
          ctx.session!.memberId,
          input.storeId,
          ctx.session!.permissions,
        );
      });
      const skuIds = [...new Set(input.skuIds)];
      const result = await runSimpleCommand(
        ctx,
        input.runId,
        (state) => {
          // 2026-10-21 audit CA-30: same receipt-phase guard as the
          // domain's ConfirmStoreItem, checked up front so a request whose
          // SKUs are all already decided still fails before delivery /
          // after the store has signed.
          const target = state.stores.get(input.storeId);
          if (!target?.deliveredAt) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'run.errors.storeNotDelivered',
            });
          }
          if (target.confirmedAt) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'run.errors.storeAlreadyConfirmed',
            });
          }
          const expected = new Set<string>();
          for (const item of state.items.values()) {
            if (item.status !== 'purchased') continue;
            for (const split of item.storeSplits) {
              if (split.storeId === input.storeId) expected.add(item.skuId);
            }
          }

          let current = state;
          const events: RunEvent[] = [];
          for (const skuId of skuIds) {
            if (!expected.has(skuId)) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: 'run.errors.itemNotInRun',
              });
            }
            if (current.stores.get(input.storeId)?.itemConfirms.has(skuId)) continue;
            const out = decideRun(current, {
              type: 'ConfirmStoreItem',
              storeId: input.storeId,
              skuId,
              status: 'ok',
              note: null,
              photoUrl: null,
              actor: actorFromCtx(ctx, effectivePerms),
            });
            events.push(...out);
            current = out.reduce(applyRun, current);
          }
          return events;
        },
        { skipRunPermissionScope: true },
      );
      return { marked: result.eventCount, lastSeq: result.lastSeq };
    }),

  confirmStore: authedProcedure.input(ConfirmStoreInputSchema).mutation(async ({ ctx, input }) => {
    const effectivePerms = await ctx.withOrg(async (tx) => {
      await assertActorAssignedToStore(
        tx,
        ctx.session!.memberId,
        input.storeId,
        ctx.session!.permissions,
      );
      return effectivePermissionsForStore(
        tx,
        ctx.session!.memberId,
        input.storeId,
        ctx.session!.permissions,
      );
    });
    return runSimpleCommand(
      ctx,
      input.runId,
      (state) =>
        decideRun(state, {
          type: 'ConfirmStore',
          storeId: input.storeId,
          actor: actorFromCtx(ctx, effectivePerms),
        }),
      { skipRunPermissionScope: true },
    );
  }),
};
