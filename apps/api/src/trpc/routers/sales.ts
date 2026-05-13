/**
 * Sales router (M2.0c, 2026-05-08).
 *
 * Closes the ERP loop: purchase → receive (M2.0a) → menu + BOM
 * (M2.0b) → consume (M2.0c).
 *
 * Two procedures:
 *
 *   record(storeId, dishId, qty, occurredAt?)
 *     Logs one sale event AND writes the corresponding ingredient
 *     deductions in a single DB transaction. If the dish has no
 *     recipe, the sale is rejected — recording consumption with no
 *     deduction would leave inventory wrong. Per-store gated
 *     (`sales.record`, with per-store effective-perm override).
 *
 *   list(storeId, fromDate, toDate)
 *     Lists recorded sales in the range. Newest first. Cap 200 rows
 *     per call (covers a busy week per store).
 *
 * What happens on `record`:
 *
 *   1. Validate qty > 0 and dish belongs to org.
 *   2. Read the dish's `dish_ingredients` rows. Reject if empty
 *      (operator should set a recipe first).
 *   3. Insert `inventory.sales` row.
 *   4. Bulk-insert `inventory.movements` rows — one per ingredient
 *      with delta = -(qty × qtyPerServing), sourceType='sale',
 *      sourceId=<sale.id>, reason='consumption'.
 *   5. Return { saleId, deducted: [{skuId, qty}] }.
 *
 * Idempotency: the partial UNIQUE index on
 * `inventory.movements (source_type, source_id, store_id, sku_id)`
 * guards against double-fire. A retry of the same logical sale
 * (same source_id) becomes a no-op via ON CONFLICT DO NOTHING.
 */
import { TRPCError } from '@trpc/server';
import { and, between, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schema as s } from '@compass/db';
import {
  DateStringSchema,
  PositiveDecimalStringSchema,
  UuidSchema,
} from '@compass/contracts';
import { authedProcedure, idempotentMutation, router } from '../trpc';
import { effectivePermissionsForStore } from '../../services/storeScope';

function requireSalesRecord(perms: ReadonlySet<string>): void {
  if (!perms.has('sales.record') && !perms.has('users.manage')) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'sales.errors.cannotRecord',
    });
  }
}

const RecordInputSchema = z.object({
  storeId: UuidSchema,
  dishId: UuidSchema,
  qty: PositiveDecimalStringSchema,
  /** Optional ISO timestamp; defaults to NOW(). Lets shift leads
   *  back-fill the day's sales at close-out. */
  occurredAt: z.string().datetime().optional(),
});

const ListInputSchema = z.object({
  storeId: UuidSchema,
  /** Inclusive start. Defaults to today (org timezone). */
  fromDate: DateStringSchema.optional(),
  /** Inclusive end. Defaults to today. */
  toDate: DateStringSchema.optional(),
});

export const salesRouter = router({
  // M1.20: idempotent — sales.record writes a sale row AND the
  // ingredient-deduction movements in one tx. Network retry without
  // a key = double inventory deduction.
  record: idempotentMutation
    .input(RecordInputSchema)
    .mutation(async ({ ctx, input }) => {
      requireSalesRecord(ctx.session!.permissions);
      // Per-store override: an admin may have explicitly denied this
      // actor sales.record on this specific store.
      const effective = await ctx.withOrg((tx) =>
        effectivePermissionsForStore(
          tx,
          ctx.session!.memberId,
          input.storeId,
          ctx.session!.permissions,
        ),
      );
      requireSalesRecord(effective);

      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;

        // 1. Verify the dish exists in this org.
        const dish = await tx.query.dishes.findFirst({
          where: (d, { eq: eq2, and: and2 }) =>
            and2(eq2(d.id, input.dishId), eq2(d.orgId, orgId)),
        });
        if (!dish) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'sales.errors.dishNotFound' });
        }
        if (dish.isArchived) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'sales.errors.dishArchived',
          });
        }

        // 2. Verify the store exists in this org.
        const store = await tx.query.stores.findFirst({
          where: (st, { eq: eq2, and: and2 }) =>
            and2(eq2(st.id, input.storeId), eq2(st.orgId, orgId)),
        });
        if (!store) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'sales.errors.storeNotFound' });
        }

        // 3. Read the dish's recipe.
        const recipe = await tx
          .select({
            skuId: s.dishIngredients.skuId,
            qtyPerServing: s.dishIngredients.qtyPerServing,
          })
          .from(s.dishIngredients)
          .where(eq(s.dishIngredients.dishId, input.dishId));
        if (recipe.length === 0) {
          // Recording consumption with no deduction would leave
          // inventory inaccurate. Fail loudly so the operator goes
          // back and writes a recipe.
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'sales.errors.dishHasNoRecipe',
          });
        }

        // 4. Insert the sale row.
        const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();
        const [inserted] = await tx
          .insert(s.sales)
          .values({
            orgId,
            storeId: input.storeId,
            dishId: input.dishId,
            qty: input.qty,
            // Snapshot the dish's selling price at sale time. If the
            // dish has no price set we record NULL (still a valid
            // consumption event; revenue rolls up to "—" later).
            unitPrice: dish.unitPrice,
            recordedByMemberId: ctx.session!.memberId,
            occurredAt,
          })
          .returning({ id: s.sales.id });

        const saleId = inserted!.id;

        // 5. Auto-deduct ingredient inventory.
        const saleQty = Number(input.qty);
        const deductions = recipe.map((r) => {
          const lineQty = Number(r.qtyPerServing) * saleQty;
          // Negative delta — that's a consumption.
          const delta = (-lineQty).toFixed(3);
          return { skuId: r.skuId, qty: lineQty.toFixed(3), delta };
        });

        await tx
          .insert(s.inventoryMovements)
          .values(
            deductions.map((d) => ({
              orgId,
              storeId: input.storeId,
              skuId: d.skuId,
              delta: d.delta,
              reason: 'consumption' as const,
              sourceType: 'sale' as const,
              sourceId: saleId,
              actorMemberId: ctx.session!.memberId,
              occurredAt,
            })),
          )
          .onConflictDoNothing();

        return {
          saleId,
          deducted: deductions.map(({ skuId, qty }) => ({ skuId, qty })),
        };
      });
    }),

  list: authedProcedure.input(ListInputSchema).query(async ({ ctx, input }) => {
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      // Default: today (UTC start to UTC end). Refining to org TZ is
      // a follow-up — UTC is correct-enough for the first cut.
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      const todayEnd = new Date();
      todayEnd.setUTCHours(23, 59, 59, 999);
      const from = input.fromDate ? new Date(input.fromDate + 'T00:00:00Z') : todayStart;
      const to = input.toDate ? new Date(input.toDate + 'T23:59:59Z') : todayEnd;

      const rows = await tx
        .select({
          id: s.sales.id,
          dishId: s.sales.dishId,
          qty: s.sales.qty,
          unitPrice: s.sales.unitPrice,
          recordedByMemberId: s.sales.recordedByMemberId,
          occurredAt: s.sales.occurredAt,
        })
        .from(s.sales)
        .where(
          and(
            eq(s.sales.orgId, orgId),
            eq(s.sales.storeId, input.storeId),
            between(s.sales.occurredAt, from, to),
          ),
        )
        .orderBy(desc(s.sales.occurredAt))
        .limit(200);
      return rows;
    });
  }),
});
