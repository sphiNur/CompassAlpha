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
 *   save({ dishId?, ...fields, ingredients[] })
 *                                — 2026-10-21 (CA-55): create-or-update
 *                                  the dish fields AND replace its recipe
 *                                  in ONE transaction. The editor used to
 *                                  call update then setIngredients, so a
 *                                  failed second call left new fields
 *                                  with the old recipe. update and
 *                                  setIngredients stay for older clients.
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
import { schema as s, type DB } from '@compass/db';
import { UuidSchema } from '@compass/contracts';
import { authedProcedure, router } from '../trpc';
import { isUniqueViolation } from '../../services/pgErrors';
import {
  priceStoreIds,
  pricesVisibleAnywhere,
  pricesVisibleFor,
} from '../../services/priceRedaction';

/**
 * CLS-12 (2026-10-30): a dish code already used in the org tripped
 * dishes_org_code_unique and came back as a bare 500 / 「出错了」.
 */
async function codeChecked<T>(op: PromiseLike<T>): Promise<T> {
  try {
    return await op;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new TRPCError({ code: 'CONFLICT', message: 'dishes.errors.codeTaken', cause: err });
    }
    throw err;
  }
}

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
    .regex(/^\d{1,8}(\.\d{1,4})?$/, 'dishes.errors.qtyTooLarge')
    .refine((s2) => Number(s2) > 0, { message: 'dishes.errors.ingredientQtyMustBePositive' }),
  note: z.string().max(500).optional().nullable(),
});

const CreateInputSchema = z.object({
  code: z.string().max(32).optional().nullable(),
  names: NamesSchema,
  description: z.record(z.string(), z.string().max(2000)).optional(),
  unitPrice: z
    .string()
    .regex(/^\d{1,12}(\.\d{1,2})?$/, 'dishes.errors.priceTooLarge')
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
    .regex(/^\d{1,12}(\.\d{1,2})?$/, 'dishes.errors.priceTooLarge')
    .optional()
    .nullable(),
  sortIndex: z.number().int().optional(),
});

const SetIngredientsInputSchema = z.object({
  dishId: UuidSchema,
  ingredients: z.array(IngredientSchema).max(100),
});

const SaveInputSchema = CreateInputSchema.extend({
  /** Absent → create a new dish; present → update that dish. */
  dishId: UuidSchema.optional(),
  /**
   * CLS-25 (2026-10-30): the dish's `updatedAt` when the editor opened it.
   * When given and the dish has changed since, the save is refused instead
   * of silently overwriting the other person's edit. Optional so clients
   * that don't send it keep working.
   */
  expectedUpdatedAt: z.string().datetime().optional(),
});

type IngredientInput = z.infer<typeof IngredientSchema>;

/**
 * 2026-10-21 (CA-55): skuIds that appear more than once in a recipe.
 * (dish_id, sku_id) is the PK, so duplicates used to surface as a 500
 * (create) or a half-applied diff (setIngredients). Exported for tests.
 */
export function duplicateIngredientSkuIds(
  ingredients: ReadonlyArray<{ skuId: string }>,
): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const i of ingredients) {
    if (seen.has(i.skuId)) dupes.add(i.skuId);
    seen.add(i.skuId);
  }
  return [...dupes];
}

/** Reject duplicate and foreign SKUs before any write. */
async function assertIngredientsValid(
  tx: DB,
  orgId: string,
  ingredients: ReadonlyArray<IngredientInput>,
): Promise<void> {
  if (duplicateIngredientSkuIds(ingredients).length > 0) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'dishes.errors.duplicateIngredient' });
  }
  if (ingredients.length === 0) return;
  const skuIds = ingredients.map((i) => i.skuId);
  const owned = await tx
    .select({ id: s.skus.id, isArchived: s.skus.isArchived })
    .from(s.skus)
    .where(and(eq(s.skus.orgId, orgId), inArray(s.skus.id, skuIds)));
  if (owned.length !== skuIds.length) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'dishes.errors.ingredientSkuNotFound',
    });
  }
  // DX-DSH-1 (2026-11-01): a product taken off the catalog can't stay in
  // a recipe. The editor showed such a row as "pick an ingredient" and
  // the save kept the archived product without a word, so every sale
  // went on deducting stock nobody buys any more. The editor now marks
  // the row and asks for a replacement; this refuses the rest.
  if (owned.some((k) => k.isArchived)) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'dishes.errors.archivedIngredient',
    });
  }
}

/**
 * Replace-all recipe write shared by setIngredients and save. Diffs
 * against current rows: identical (skuId, qty, note) is left alone
 * (preserves created_at); changed rows are updated; removed rows are
 * deleted. Caller has validated the ingredients and the dish's org.
 */
async function replaceIngredients(
  tx: DB,
  dishId: string,
  ingredients: ReadonlyArray<IngredientInput>,
): Promise<void> {
  const current = await tx
    .select()
    .from(s.dishIngredients)
    .where(eq(s.dishIngredients.dishId, dishId));
  const currentBySku = new Map(current.map((r) => [r.skuId, r]));
  const incomingBySku = new Map(ingredients.map((i) => [i.skuId, i]));
  // Delete rows whose SKU isn't in the new payload.
  const toDelete = current.map((r) => r.skuId).filter((skuId) => !incomingBySku.has(skuId));
  if (toDelete.length > 0) {
    await tx
      .delete(s.dishIngredients)
      .where(
        and(eq(s.dishIngredients.dishId, dishId), inArray(s.dishIngredients.skuId, toDelete)),
      );
  }
  // Upsert each incoming row. Skip the update if qty + note matches;
  // preserves created_at on no-op edits.
  for (const inc of ingredients) {
    const existing = currentBySku.get(inc.skuId);
    const incomingQty = inc.qtyPerServing;
    const incomingNote = inc.note ?? null;
    if (existing) {
      if (existing.qtyPerServing === incomingQty && (existing.note ?? null) === incomingNote) {
        continue; // identical, no write
      }
      await tx
        .update(s.dishIngredients)
        .set({ qtyPerServing: incomingQty, note: incomingNote, updatedAt: new Date() })
        .where(and(eq(s.dishIngredients.dishId, dishId), eq(s.dishIngredients.skuId, inc.skuId)));
    } else {
      await tx.insert(s.dishIngredients).values({
        dishId,
        skuId: inc.skuId,
        qtyPerServing: incomingQty,
        note: incomingNote,
      });
    }
  }
}

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
        .object({
          includeArchived: z.boolean().optional(),
          /** D6: the store the list is shown for (sales panel); decides
           *  whether selling prices are included. */
          storeId: UuidSchema.optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const includeArchived = input?.includeArchived ?? false;
        // D6 (2026-10-31): selling prices are money. Shown to whoever sets
        // them (dishes.manage) and to members with prices.view — in the
        // given store, or anywhere when the caller names none.
        const priceStores = await priceStoreIds(tx, ctx.session!);
        const showPrices =
          ctx.session!.permissions.has('dishes.manage') ||
          (input?.storeId
            ? pricesVisibleFor(priceStores, [input.storeId])
            : pricesVisibleAnywhere(priceStores));
        const rawDishes = await tx.query.dishes.findMany({
          where: includeArchived
            ? (d, { eq: eq2 }) => eq2(d.orgId, orgId)
            : (d, { eq: eq2, and: and2 }) =>
                and2(eq2(d.orgId, orgId), eq2(d.isArchived, false)),
          orderBy: (d, { asc: asc2 }) => [asc2(d.sortIndex), asc2(d.id)],
        });
        const dishes = showPrices
          ? rawDishes
          : rawDishes.map((dish) => ({ ...dish, unitPrice: null }));
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
        // 2026-10-21 CA-55: also rejects duplicate skuIds (was a PK 500).
        await assertIngredientsValid(tx, orgId, input.ingredients);
        // Highest sort_index + 1 so new dishes append at the bottom.
        const last = await tx
          .select({ max: sql<number>`coalesce(max(${s.dishes.sortIndex}), 0)::int` })
          .from(s.dishes)
          .where(eq(s.dishes.orgId, orgId));
        const nextSort = (last[0]?.max ?? 0) + 1;
        const [inserted] = await codeChecked(
          tx
          .insert(s.dishes)
          .values({
            orgId,
            code: input.code ?? null,
            names: input.names as unknown as Record<string, unknown>,
            description: (input.description ?? {}) as unknown as Record<string, unknown>,
            unitPrice: input.unitPrice ?? null,
            sortIndex: nextSort,
          })
          .returning({ id: s.dishes.id }),
        );
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
        const r = await codeChecked(
          tx
            .update(s.dishes)
            .set(patch)
            .where(and(eq(s.dishes.id, input.dishId), eq(s.dishes.orgId, orgId)))
            .returning({ id: s.dishes.id }),
        );
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
        // 2026-10-21 CA-55: shared validation (now also rejects
        // duplicate skuIds) + the replace-all diff, also used by save.
        await assertIngredientsValid(tx, orgId, input.ingredients);
        await replaceIngredients(tx, input.dishId, input.ingredients);
        return { ok: true as const };
      });
    }),

  /**
   * 2026-10-21 (CA-55): atomic dish editor save. Creates the dish (no
   * dishId) or updates every field of it (dishId), then replaces the
   * recipe — all in one withOrg transaction, so either the whole edit
   * lands or nothing does.
   */
  save: authedProcedure.input(SaveInputSchema).mutation(async ({ ctx, input }) => {
    requireDishesManage(ctx.session!.permissions);
    return ctx.withOrg(async (tx) => {
      const orgId = ctx.session!.orgId;
      await assertIngredientsValid(tx, orgId, input.ingredients);
      const fields = {
        code: input.code ?? null,
        names: input.names as unknown as Record<string, unknown>,
        description: (input.description ?? {}) as unknown as Record<string, unknown>,
        unitPrice: input.unitPrice ?? null,
      };
      let dishId: string;
      if (input.dishId) {
        const r = await codeChecked(
          tx
            .update(s.dishes)
            .set({ ...fields, updatedAt: new Date() })
            .where(
              and(
                eq(s.dishes.id, input.dishId),
                eq(s.dishes.orgId, orgId),
                input.expectedUpdatedAt
                  ? sql`date_trunc('milliseconds', ${s.dishes.updatedAt}) = ${input.expectedUpdatedAt}::timestamptz`
                  : undefined,
              ),
            )
            .returning({ id: s.dishes.id }),
        );
        if (r.length === 0) {
          if (input.expectedUpdatedAt) {
            const still = await tx.query.dishes.findFirst({
              where: (d, { eq: eq2, and: and2 }) =>
                and2(eq2(d.id, input.dishId!), eq2(d.orgId, orgId)),
              columns: { id: true },
            });
            if (still) {
              throw new TRPCError({ code: 'CONFLICT', message: 'dishes.errors.changedElsewhere' });
            }
          }
          throw new TRPCError({ code: 'NOT_FOUND', message: 'dishes.errors.notFound' });
        }
        dishId = input.dishId;
      } else {
        const last = await tx
          .select({ max: sql<number>`coalesce(max(${s.dishes.sortIndex}), 0)::int` })
          .from(s.dishes)
          .where(eq(s.dishes.orgId, orgId));
        const [inserted] = await codeChecked(
          tx
            .insert(s.dishes)
            .values({ orgId, ...fields, sortIndex: (last[0]?.max ?? 0) + 1 })
            .returning({ id: s.dishes.id }),
        );
        dishId = inserted!.id;
      }
      await replaceIngredients(tx, dishId, input.ingredients);
      return { dishId, created: !input.dishId };
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
