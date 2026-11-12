/**
 * At the market: claiming the run, buying, revising and undoing lines,
 * marking items unavailable, and the run's expenses.
 */
import { TRPCError } from '@trpc/server';
import { logger } from '../../../infra/log';
import { z } from 'zod';
import {
  AddPurchaserItemInputSchema,
  AddRunExpenseInputSchema,
  MarkUnavailableInputSchema,
  PurchaseItemInputSchema,
  RemoveRunExpenseInputSchema,
  RevisePurchaseInputSchema,
  RunReasonOnlyInputSchema,
  SimpleRunCommandSchema,
  UndoPurchaseInputSchema,
  UnmarkUnavailableInputSchema,
  DismissTopUpInputSchema,
} from '@compass/contracts';
import { decideRun } from '@compass/domain/run';
import { authedProcedure, idempotentMutation } from '../../trpc';
import {
  hiddenSplits,
  mergeScopedRevision,
  StoreOutOfScopeError,
} from '../../../services/scopedRunRevision';
import { readExpenseTemplates } from '../../../services/expenseTemplates';
import { actorFromCtx, runSimpleCommand } from './command';

export const purchaseProcedures = {
  expenseTemplates: authedProcedure.query(async ({ ctx }) => {
    const perms = ctx.session!.permissions;
    if (!perms.has('run.purchase') && !perms.has('users.manage') && !perms.has('org.admin')) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'auth.errors.missingPermission',
        cause: { missingPermission: 'run.purchase' },
      });
    }
    return ctx.withOrg((tx) => readExpenseTemplates(tx, ctx.session!, false));
  }),

  /**
   * C.2 (M3.38, 2026-05-19): mark a run as one purchaser's. Nothing
   * checks the claim: runs are collaborative, and the domain's claim
   * check was an empty function, removed in review RUNAPI-17.
   *
   * @deprecated BUY-20 (2026-10-30): the web app stopped calling it in
   * UIUX-B1 and Fine never did; logged when called so it can be removed.
   */
  claim: authedProcedure.input(SimpleRunCommandSchema).mutation(async ({ ctx, input }) => {
    logger.warn(
      { procedure: 'run.claim', orgId: ctx.session?.orgId },
      'deprecated procedure called',
    );
    return runSimpleCommand(ctx, input.runId, (state) =>
      decideRun(state, { type: 'ClaimRun', actor: actorFromCtx(ctx) }),
    );
  }),

  /**
   * C.2 (M3.38, 2026-05-19): release a run claim. Reason 'manual' for
   * the explicit Release button; 'pagehide' for the FE's
   * visibilitychange auto-release. Override path: when the caller is
   * NOT the current claimer, the domain layer re-tags the emitted
   * event with reason 'override' (the take-over button uses this).
   *
   * @deprecated BUY-20 (2026-10-30): no client calls it; see `claim`.
   */
  releaseClaim: authedProcedure
    .input(
      SimpleRunCommandSchema.extend({
        reason: z.enum(['manual', 'pagehide']).default('manual'),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      logger.warn(
        { procedure: 'run.releaseClaim', orgId: ctx.session?.orgId },
        'deprecated procedure called',
      );
      return runSimpleCommand(ctx, input.runId, (state) =>
        decideRun(state, {
          type: 'ReleaseRunClaim',
          reason: input.reason,
          actor: actorFromCtx(ctx),
        }),
      );
    }),

  startPurchase: authedProcedure
    .input(SimpleRunCommandSchema)
    .mutation(async ({ ctx, input }) =>
      runSimpleCommand(ctx, input.runId, (state) =>
        decideRun(state, { type: 'StartPurchase', actor: actorFromCtx(ctx) }),
      ),
    ),

  /** Roll the run back to `planned` (only if no item touched yet). */
  undoStartPurchase: authedProcedure
    .input(RunReasonOnlyInputSchema)
    .mutation(async ({ ctx, input }) =>
      runSimpleCommand(ctx, input.runId, (state) =>
        decideRun(state, {
          type: 'UndoStartPurchase',
          reason: input.reason,
          actor: actorFromCtx(ctx),
        }),
      ),
    ),

  // M1.20: idempotent — record-purchase replays would double-deduct
  // inventory + double-record price history.
  purchaseItem: idempotentMutation.input(PurchaseItemInputSchema).mutation(async ({ ctx, input }) =>
    runSimpleCommand(
      ctx,
      input.runId,
      (state, scope) =>
        decideRun(state, {
          type: 'PurchaseItem',
          skuId: input.skuId,
          supplierId: input.supplierId,
          unitPrice: input.unitPrice,
          actualQty: input.actualQty,
          receiptPhotoUrl: input.receiptPhotoUrl,
          storeSplits: input.storeSplits,
          paymentMethod: input.paymentMethod,
          priceConfirmed: input.priceConfirmed,
          ...scope,
          actor: actorFromCtx(ctx),
        }),
      {
        withRunStoreIds: true,
        item: {
          skuId: input.skuId,
          splitStoreIds: (input.storeSplits ?? []).map((split) => split.storeId),
        },
      },
    ),
  ),

  /**
   * M3.41 (2026-05-21): purchaser-initiated mid-run addition. Records
   * a purchase for a SKU that wasn't in the original aggregated demand
   * — used for impromptu bazaar buys, chef-call-in top-ups, etc.
   * The domain layer enforces that the SKU isn't already in the run
   * (use RevisePurchase to grow an existing row), that every storeId
   * in the splits is already part of the run's store scope (use
   * AttachSessions to bring in a new store), and that `reason` is
   * non-empty so audit can answer "why was this added?". The
   * resulting row carries `addedByPurchaser=true` so finish summary
   * + reports surface it separately from the planned ask.
   *
   * Idempotent: replays of the same X-Idempotency-Key short-circuit
   * back to the prior result.
   */
  addPurchaserItem: idempotentMutation
    .input(AddPurchaserItemInputSchema)
    .mutation(async ({ ctx, input }) =>
      runSimpleCommand(
        ctx,
        input.runId,
        (state, scope) =>
          decideRun(state, {
            type: 'AddPurchaserItem',
            skuId: input.skuId,
            supplierId: input.supplierId,
            unitPrice: input.unitPrice,
            actualQty: input.actualQty,
            receiptPhotoUrl: input.receiptPhotoUrl,
            storeSplits: input.storeSplits,
            paymentMethod: input.paymentMethod,
            reason: input.reason,
            priceConfirmed: input.priceConfirmed,
            ...scope,
            actor: actorFromCtx(ctx),
          }),
        {
          withRunStoreIds: true,
          item: {
            skuId: input.skuId,
            splitStoreIds: input.storeSplits.map((split) => split.storeId),
          },
        },
      ),
    ),

  /** Edit an already-purchased item (qty/price/supplier/photo/splits). */
  // M1.20: idempotent — revise rewrites unit price + splits; replay
  // could fork the price_history table.
  revisePurchase: idempotentMutation
    .input(RevisePurchaseInputSchema)
    .mutation(async ({ ctx, input }) =>
      runSimpleCommand(
        ctx,
        input.runId,
        (state, { readStoreIds = null, ...scope }) => {
          // 2026-10-21: a store-scoped reader only ever saw part of this
          // item (run.get redaction); keep the hidden stores' splits,
          // quantity, prices, supplier and receipt instead of letting the
          // wholesale replacement below erase them.
          const item = state.items.get(input.skuId);
          let revision = input;
          if (item) {
            try {
              revision = mergeScopedRevision(item, input, readStoreIds);
            } catch (err) {
              if (err instanceof StoreOutOfScopeError) {
                throw new TRPCError({ code: 'FORBIDDEN', message: 'run.errors.notVisible' });
              }
              throw err;
            }
          }
          return decideRun(state, {
            type: 'RevisePurchase',
            skuId: revision.skuId,
            supplierId: revision.supplierId,
            unitPrice: revision.unitPrice,
            actualQty: revision.actualQty,
            receiptPhotoUrl: revision.receiptPhotoUrl,
            storeSplits: revision.storeSplits,
            reason: revision.reason,
            paymentMethod: revision.paymentMethod,
            priceConfirmed: revision.priceConfirmed,
            ...scope,
            actor: actorFromCtx(ctx),
          });
        },
        {
          withRunStoreIds: true,
          withReadScope: true,
          item: {
            skuId: input.skuId,
            splitStoreIds: input.storeSplits.map((split) => split.storeId),
          },
        },
      ),
    ),

  /** Revert a purchased item back to pending (mistapped row, decided
   *  not to buy after all). Blocked once any destination store has
   *  accepted delivery. */
  undoPurchase: authedProcedure.input(UndoPurchaseInputSchema).mutation(async ({ ctx, input }) =>
    runSimpleCommand(
      ctx,
      input.runId,
      (state, { readStoreIds = null }) => {
        // 2026-10-21: undo erases every store's split; refuse it for an
        // actor who can't see all of them (see mergeScopedRevision).
        const item = state.items.get(input.skuId);
        if (item && hiddenSplits(item, readStoreIds).length > 0) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'run.errors.notVisible' });
        }
        return decideRun(state, {
          type: 'UndoPurchase',
          skuId: input.skuId,
          reason: input.reason,
          actor: actorFromCtx(ctx),
        });
      },
      { withReadScope: true, item: { skuId: input.skuId } },
    ),
  ),

  // BUY-9 (2026-10-30): idempotent, so an offline replay of a request
  // that already landed (lost response) is answered, not refused.
  markUnavailable: idempotentMutation
    .input(MarkUnavailableInputSchema)
    .mutation(async ({ ctx, input }) =>
      runSimpleCommand(
        ctx,
        input.runId,
        (state) =>
          decideRun(state, {
            type: 'MarkUnavailable',
            skuId: input.skuId,
            note: input.note,
            actor: actorFromCtx(ctx),
          }),
        { item: { skuId: input.skuId } },
      ),
    ),

  /** Flip an unavailable item back to pending (e.g. found another supplier). */
  unmarkUnavailable: authedProcedure
    .input(UnmarkUnavailableInputSchema)
    .mutation(async ({ ctx, input }) =>
      runSimpleCommand(
        ctx,
        input.runId,
        (state) =>
          decideRun(state, {
            type: 'UnmarkUnavailable',
            skuId: input.skuId,
            reason: input.reason,
            actor: actorFromCtx(ctx),
          }),
        { item: { skuId: input.skuId } },
      ),
    ),

  /** BUY-5 (2026-10-30): the extra demand that joined after this item was
   *  bought or marked unavailable will not be bought. */
  dismissTopUp: authedProcedure.input(DismissTopUpInputSchema).mutation(async ({ ctx, input }) =>
    runSimpleCommand(
      ctx,
      input.runId,
      (state) =>
        decideRun(state, {
          type: 'DismissTopUp',
          skuId: input.skuId,
          note: input.note,
          actor: actorFromCtx(ctx),
        }),
      { item: { skuId: input.skuId } },
    ),
  ),

  /**
   * M3.44 (2026-05-22): off-catalog expense — free-text item OR shared
   * cost (porter, taxi, parking). `expenseId` is CLIENT-generated so
   * the FE owns the id before save (no roundtrip to learn it) AND
   * replays of the same X-Idempotency-Key short-circuit cleanly.
   *
   * The domain layer enforces:
   *   - actor has `run.purchase`
   *   - status NOT in {finished, cancelled}; amending needs `run.amend`
   *   - a label and a reason; splits that add up to the quantity
   *   - all storeSplits within run scope
   * The receipt photo is optional (the 200,000 UZS rule went 2026-07-06).
   */
  addExpense: idempotentMutation.input(AddRunExpenseInputSchema).mutation(async ({ ctx, input }) =>
    runSimpleCommand(
      ctx,
      input.runId,
      (state, scope) =>
        decideRun(state, {
          type: 'AddRunExpense',
          expenseId: input.expenseId,
          label: input.label,
          ...(input.unitHint !== undefined ? { unitHint: input.unitHint } : {}),
          qty: input.qty,
          unitPrice: input.unitPrice,
          storeSplits: input.storeSplits,
          paymentMethod: input.paymentMethod,
          receiptPhotoUrl: input.receiptPhotoUrl,
          reason: input.reason,
          ...scope,
          actor: actorFromCtx(ctx),
        }),
      {
        withRunStoreIds: true,
        expense: {
          expenseId: input.expenseId,
          splitStoreIds: input.storeSplits.map((split) => split.storeId),
        },
      },
    ),
  ),

  /**
   * M3.44: soft-delete an expense before the run is finished. The
   * RunExpenseAdded event stays in the log; the read-model row gets
   * removed_at/removed_by_member_id/remove_reason filled in so admin
   * reports can show the full add → remove story.
   */
  removeExpense: authedProcedure
    .input(RemoveRunExpenseInputSchema)
    .mutation(async ({ ctx, input }) =>
      runSimpleCommand(
        ctx,
        input.runId,
        (state) =>
          decideRun(state, {
            type: 'RemoveRunExpense',
            expenseId: input.expenseId,
            reason: input.reason,
            actor: actorFromCtx(ctx),
          }),
        { expense: { expenseId: input.expenseId } },
      ),
    ),
};
