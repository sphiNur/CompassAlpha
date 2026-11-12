/**
 * Delivery: sending the goods to each store, and each store confirming
 * what it received.
 */
import {
  ConfirmStoreInputSchema,
  ConfirmStoreItemInputSchema,
  DispatchInputSchema,
  MarkStoreItemsOkInputSchema,
  RunReasonOnlyInputSchema,
  SimpleRunCommandSchema,
  UndeliverStoreInputSchema,
} from '@compass/contracts';
import { decideRun } from '@compass/domain/run';
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

  deliverToStore: idempotentMutation.input(DispatchInputSchema).mutation(async ({ ctx, input }) =>
    // Purchaser delivering — they need run.purchase, NOT a store-scope
    // assignment. (The purchaser drives the run on behalf of all stores.)
    //
    // Per-store override (added 2026-05-06): even though the purchaser
    // doesn't need MSA, an admin may still have written a store-scoped
    // deny override on `delivery.dispatch` to lock this purchaser out
    // of one specific store's deliveries, so the actor carries the
    // effective permissions for input.storeId.
    runSimpleCommand(
      ctx,
      input.runId,
      (state, scope) =>
        decideRun(state, {
          type: 'DeliverToStore',
          storeId: input.storeId,
          runStoreIds: scope.runStoreIds,
          actor: actorFromCtx(ctx, scope.storePermissions),
        }),
      { skipRunPermissionScope: true, withRunStoreIds: true, store: { storeId: input.storeId } },
    ),
  ),

  /** Recall a delivery to a store that has not yet confirmed receipt. */
  undeliverStore: authedProcedure
    .input(UndeliverStoreInputSchema)
    .mutation(async ({ ctx, input }) =>
      runSimpleCommand(
        ctx,
        input.runId,
        (state, scope) =>
          decideRun(state, {
            type: 'UndeliverStore',
            storeId: input.storeId,
            reason: input.reason,
            actor: actorFromCtx(ctx, scope.storePermissions),
          }),
        { skipRunPermissionScope: true, store: { storeId: input.storeId } },
      ),
    ),

  // Receiver-side confirm: only members assigned to this store may accept
  // its incoming delivery, with the store-effective permissions (added
  // 2026-05-06) so allow/deny overrides scoped to this store reach the
  // domain check.
  confirmStoreItem: authedProcedure
    .input(ConfirmStoreItemInputSchema)
    .mutation(async ({ ctx, input }) =>
      runSimpleCommand(
        ctx,
        input.runId,
        (state, scope) =>
          decideRun(state, {
            type: 'ConfirmStoreItem',
            storeId: input.storeId,
            skuId: input.skuId,
            status: input.status,
            note: input.note,
            photoUrl: input.photoUrl,
            receivedQty: input.receivedQty ?? null,
            actor: actorFromCtx(ctx, scope.storePermissions),
          }),
        { skipRunPermissionScope: true, store: { storeId: input.storeId, assigned: true } },
      ),
    ),

  /**
   * Bulk receiver action: mark every undecided line at one store as OK.
   * One transaction, one projection pass and one notification dispatch.
   * Individual `StoreItemConfirmed` events remain in the audit stream.
   */
  markStoreItemsOk: authedProcedure
    .input(MarkStoreItemsOkInputSchema)
    .mutation(async ({ ctx, input }) => {
      // Review RUNAPI-13: the domain decides the whole request, with the
      // checks ConfirmStoreItem makes; this router looped over that
      // command itself.
      const result = await runSimpleCommand(
        ctx,
        input.runId,
        (state, scope) =>
          decideRun(state, {
            type: 'ConfirmStoreItemsOk',
            storeId: input.storeId,
            skuIds: input.skuIds,
            actor: actorFromCtx(ctx, scope.storePermissions),
          }),
        { skipRunPermissionScope: true, store: { storeId: input.storeId, assigned: true } },
      );
      return { marked: result.eventCount, lastSeq: result.lastSeq };
    }),

  confirmStore: authedProcedure.input(ConfirmStoreInputSchema).mutation(async ({ ctx, input }) =>
    runSimpleCommand(
      ctx,
      input.runId,
      (state, scope) =>
        decideRun(state, {
          type: 'ConfirmStore',
          storeId: input.storeId,
          actor: actorFromCtx(ctx, scope.storePermissions),
        }),
      { skipRunPermissionScope: true, store: { storeId: input.storeId, assigned: true } },
    ),
  ),
};
