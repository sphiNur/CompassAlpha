/**
 * Dishes router (M2.0b, 2026-05-08).
 *
 * CRUD for menu items (`inventory.dishes`) and their recipes
 * (`inventory.dish_ingredients`). Mirrors the shape of the existing
 * SKU admin surface — same i18n names, same archive-not-delete
 * pattern, same JSON validation for names jsonb.
 *
 * Procedures:
 *
 *   list({ includeArchived })   — returns every dish + its ingredient
 *                                  rows in a single round trip. The
 *                                  FE renders the list lazily; the
 *                                  one-shot payload keeps the editor
 *                                  responsive without per-row N+1
 *                                  fetches.
 *
 *   create({ code?, names, description?, unitPrice?, ingredients[] })
 *                                — single mutation that creates the
 *                                  dish AND its ingredient rows in
 *                                  one transaction. Atomic — a half-
 *                                  saved dish without a recipe is
 *                                  useless (and confusing).
 *
 *   update({ dishId, ...patch })  — partial update. Only fields
 *                                  present in the input are written;
 *                                  unspecified fields are left alone.
 *
 *   setIngredients({ dishId, ingredients[] })
 *                                — Replace-all semantics for the
 *                                  recipe. We diff against current
 *                                  rows so any unchanged ingredient
 *                                  preserves its `created_at`.
 *
 *   archive({ dishId })           — Soft-delete. Recipe rows stay
 *                                  (we may need them for historical
 *                                  consumption analysis).
 *
 * Permissions: `dishes.manage` for all writes. `list` is read-only
 * for any authed member of the org.
 */
import { TRPCError } from '@trpc/server';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema as s } from '@compass/db';
import { UuidSchema } from '@compass/contracts';
import { authedProcedure, router } from '../trpc';

/**
 * i18n names jsonb shape. At least one non-empty locale required —
 * an unnamed dish is useless. Same validator as catalog SKUs.
 */
const NamesSchema = z
  .record(z.string(), z.string().max(200))
  .refine(
    (v) => Object.values(v).some((s2) => typeof s2 === 'string' && s2.trim().length > 0),
    { message: 'dishes.errors.namesRequired' },
  );

const IngredientSchema = z.object({
  skuId: UuidSchema,
  /** Decimal string with up to 4 fraction digits, must be > 0. */
  qtyPerServing: z
    .string()
    .regex(/^\d+(\.\d{1,4})?$/, 'qty must be > 0 with at most 4 decimals')
    .refine((s2) => Number(s2) > 0, { message: 'dishes.errors.ingredientQtyMustBePositive' }),
  note: z.string().max(500).optional().nullable(),
});

const CreateInputSchema = z.object({
  code: z.string().max(32).optional().nullable(),
  names: NamesSchema,
  description: z.record(z.string(), z.string().max(2000)).optional(),
  unitPrice: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/, 'unitPrice must be ≥ 0 with at most 2 decimals')
    .optional()
    .nullable(),
  ingredients: z.array(IngredientSchema).max(100),
});

const UpdateInputSchema = z.object({
  dishId: UuidSchema,
  code: z.string().max(32).optional().nullable(),
  names: NamesSchema.optional(),
  description: z.record(z.string(), z.string().max(2000)).optional(),
  unitPrice: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/, 'unitPrice must be ≥ 0 with at most 2 decimals')
    .optional()
    .nullable(),
  sortIndex: z.number().int().optional(),
});

const SetIngredientsInputSchema = z.object({
  dishId: UuidSchema,
  ingredients: z.array(IngredientSchema).max(100),
});

function requireDishesManage(perms: ReadonlySet<string>): void {
  // M3.2 (2026-05-15): the `users.manage` fallback was DROPPED. The
  // pre-launch audit found that manager (rank 60, store-tier) holds
  // `users.manage` for the M1.9 "store manager invites own staff"
  // path. With the fallback, manager could write to the org-wide
  // dishes/recipes table via the OR even after dishes.manage was
  // removed from their seed list — a cross-store leak (Store-A
  // manager editing a recipe affects every store's sales auto-
  // deduction). Migration 0021 backfills `dishes.manage` explicitly
  // onto admin + super_admin for every existing org so admins keep
  // their authority; manager now hits FORBIDDEN.
  if (!perms.has('dishes.manage')) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'dishes.errors.cannotManage',
    });
  }
}

export const dishesRouter = router({
  list: authedProcedure
    .input(
      z
        .object({ includeArchived: z.boolean().optional() })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const includeArchived = input?.includeArchived ?? false;
        const dishes = await tx.query.dishes.findMany({
          where: includeArchived
            ? (d, { eq: eq2 }) => eq2(d.orgId, orgId)
            : (d, { eq: eq2, and: and2 }) =>
                and2(eq2(d.orgId, orgId), eq2(d.isArchived, false)),
          orderBy: (d, { asc: asc2 }) => [asc2(d.sortIndex), asc2(d.id)],
        });
        if (dishes.length === 0) return { dishes: [], ingredients: [] };
        const ids = dishes.map((d) => d.id);
        const ingredients = await tx
          .select({
            dishId: s.dishIngredients.dishId,
            skuId: s.dishIngredients.skuId,
            qtyPerServing: s.dishIngredients.qtyPerServing,
            note: s.dishIngredients.note,
          })
          .from(s.dishIngredients)
          .where(inArray(s.dishIngredients.dishId, ids))
          .orderBy(asc(s.dishIngredients.skuId));
        return { dishes, ingredients };
      });
    }),

  create: authedProcedure
    .input(CreateInputSchema)
    .mutation(async ({ ctx, input }) => {
      requireDishesManage(ctx.session!.permissions);
      // Validate every SKU referenced actually belongs to this org.
      // Don't trust the client; the dish_ingredients FK would block
      // the insert, but rejecting BEFORE the tx gives a cleaner error.
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        if (input.ingredients.length > 0) {
          const skuIds = input.ingredients.map((i) => i.skuId);
          const ownedSkus = await tx
            .select({ id: s.skus.id })
            .from(s.skus)
            .where(and(eq(s.skus.orgId, orgId), inArray(s.skus.id, skuIds)));
          if (ownedSkus.length !== new Set(skuIds).size) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'dishes.errors.ingredientSkuNotFound',
            });
          }
        }
        // Highest sort_index + 1 so new dishes append at the bottom.
        const last = await tx
          .select({ max: sql<number>`coalesce(max(${s.dishes.sortIndex}), 0)::int` })
          .from(s.dishes)
          .where(eq(s.dishes.orgId, orgId));
        const nextSort = (last[0]?.max ?? 0) + 1;
        const [inserted] = await tx
          .insert(s.dishes)
          .values({
            orgId,
            code: input.code ?? null,
            names: input.names as unknown as Record<string, unknown>,
            description: (input.description ?? {}) as unknown as Record<string, unknown>,
            unitPrice: input.unitPrice ?? null,
            sortIndex: nextSort,
          })
          .returning({ id: s.dishes.id });
        const dishId = inserted!.id;
        if (input.ingredients.length > 0) {
          await tx.insert(s.dishIngredients).values(
            input.ingredients.map((i) => ({
              dishId,
              skuId: i.skuId,
              qtyPerServing: i.qtyPerServing,
              note: i.note ?? null,
            })),
          );
        }
        return { dishId };
      });
    }),

  update: authedProcedure
    .input(UpdateInputSchema)
    .mutation(async ({ ctx, input }) => {
      requireDishesManage(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const patch: Record<string, unknown> = { updatedAt: new Date() };
        if (input.code !== undefined) patch.code = input.code;
        if (input.names !== undefined) patch.names = input.names;
        if (input.description !== undefined) patch.description = input.description;
        if (input.unitPrice !== undefined) patch.unitPrice = input.unitPrice;
        if (input.sortIndex !== undefined) patch.sortIndex = input.sortIndex;
        const r = await tx
          .update(s.dishes)
          .set(patch)
          .where(and(eq(s.dishes.id, input.dishId), eq(s.dishes.orgId, orgId)))
          .returning({ id: s.dishes.id });
        if (r.length === 0) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'dishes.errors.notFound' });
        }
        return { ok: true as const };
      });
    }),

  /**
   * Replace-all recipe edit. Diffs against current rows: identical
   * (skuId, qty, note) is left alone (preserves created_at); changed
   * rows are upserted; removed rows are deleted.
   */
  setIngredients: authedProcedure
    .input(SetIngredientsInputSchema)
    .mutation(async ({ ctx, input }) => {
      requireDishesManage(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const dish = await tx.query.dishes.findFirst({
          where: (d, { eq: eq2, and: and2 }) =>
            and2(eq2(d.id, input.dishId), eq2(d.orgId, orgId)),
        });
        if (!dish) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'dishes.errors.notFound' });
        }
        // Verify ingredient SKUs are this org's.
        if (input.ingredients.length > 0) {
          const skuIds = input.ingredients.map((i) => i.skuId);
          const owned = await tx
            .select({ id: s.skus.id })
            .from(s.skus)
            .where(and(eq(s.skus.orgId, orgId), inArray(s.skus.id, skuIds)));
          if (owned.length !== new Set(skuIds).size) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'dishes.errors.ingredientSkuNotFound',
            });
          }
        }
        const current = await tx
          .select()
          .from(s.dishIngredients)
          .where(eq(s.dishIngredients.dishId, input.dishId));
        const currentBySku = new Map(current.map((r) => [r.skuId, r]));
        const incomingBySku = new Map(input.ingredients.map((i) => [i.skuId, i]));
        // Delete rows whose SKU isn't in the new payload.
        const toDelete = current
          .map((r) => r.skuId)
          .filter((skuId) => !incomingBySku.has(skuId));
        if (toDelete.length > 0) {
          await tx
            .delete(s.dishIngredients)
            .where(
              and(
                eq(s.dishIngredients.dishId, input.dishId),
                inArray(s.dishIngredients.skuId, toDelete),
              ),
            );
        }
        // Upsert each incoming row. Skip the update if qty + note
        // matches; preserves created_at on no-op edits.
        for (const inc of input.ingredients) {
          const existing = currentBySku.get(inc.skuId);
          const incomingQty = inc.qtyPerServing;
          const incomingNote = inc.note ?? null;
          if (existing) {
            if (
              existing.qtyPerServing === incomingQty &&
              (existing.note ?? null) === incomingNote
            ) {
              continue; // identical, no write
            }
            await tx
              .update(s.dishIngredients)
              .set({
                qtyPerServing: incomingQty,
                note: incomingNote,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(s.dishIngredients.dishId, input.dishId),
                  eq(s.dishIngredients.skuId, inc.skuId),
                ),
              );
          } else {
            await tx.insert(s.dishIngredients).values({
              dishId: input.dishId,
              skuId: inc.skuId,
              qtyPerServing: incomingQty,
              note: incomingNote,
            });
          }
        }
        return { ok: true as const };
      });
    }),

  archive: authedProcedure
    .input(z.object({ dishId: UuidSchema }))
    .mutation(async ({ ctx, input }) => {
      requireDishesManage(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const r = await tx
          .update(s.dishes)
          .set({ isArchived: true, updatedAt: new Date() })
          .where(and(eq(s.dishes.id, input.dishId), eq(s.dishes.orgId, orgId)))
          .returning({ id: s.dishes.id });
        if (r.length === 0) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'dishes.errors.notFound' });
        }
        return { ok: true as const };
      });
    }),

  unarchive: authedProcedure
    .input(z.object({ dishId: UuidSchema }))
    .mutation(async ({ ctx, input }) => {
      requireDishesManage(ctx.session!.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const r = await tx
          .update(s.dishes)
          .set({ isArchived: false, updatedAt: new Date() })
          .where(and(eq(s.dishes.id, input.dishId), eq(s.dishes.orgId, orgId)))
          .returning({ id: s.dishes.id });
        if (r.length === 0) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'dishes.errors.notFound' });
        }
        return { ok: true as const };
      });
    }),
});
