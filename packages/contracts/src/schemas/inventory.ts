import { z } from 'zod';
import {
  INVENTORY_NOTE_MAX,
  STOCKTAKE_BATCH_MAX,
  STOCKTAKE_COUNT_MESSAGE,
  WASTAGE_QTY_MESSAGE,
  stocktakeCountProblem,
  wastageQtyProblem,
} from '../limits';
import { UuidSchema } from './common';

/**
 * The inventory router's inputs. Review CONF-10 (2026-11-11): they were
 * written in the router; the rules are in limits.ts, where the stocktake
 * and wastage sheets read them too.
 */

/** inventory.levels: one store's on-hand. */
export const InventoryStoreInputSchema = z.object({ storeId: UuidSchema });

/** inventory.recentMovements: one product's movements in one store. */
export const InventoryMovementsInputSchema = z.object({
  storeId: UuidSchema,
  skuId: UuidSchema,
});

/** Target on-hand qty after a stocktake. Must be ≥ 0. */
// CLS-19 (2026-10-30): at most 8 integer digits; 99999999999 was a 500.
// DX-INV-1 (2026-11-01): one message per reason — empty, negative,
// letters and four decimals all used to say "quantity too large".
const StocktakeTargetSchema = z.string().superRefine((value, ctx) => {
  const problem = stocktakeCountProblem(value);
  if (problem) ctx.addIssue({ code: 'custom', message: STOCKTAKE_COUNT_MESSAGE[problem] });
});

export const StocktakeInputSchema = z.object({
  storeId: UuidSchema,
  skuId: UuidSchema,
  target: StocktakeTargetSchema,
  note: z.string().max(INVENTORY_NOTE_MAX).optional(),
});

/**
 * inventory.stocktakeBatch (D1, 2026-11-13): the count mode's one save.
 * Each entry is what `inventory.stocktake` takes for one product, applied
 * the same way, all in one transaction. A product appears at most once.
 */
export const StocktakeBatchInputSchema = z.object({
  storeId: UuidSchema,
  counts: z
    .array(z.object({ skuId: UuidSchema, target: StocktakeTargetSchema }))
    .min(1)
    .max(STOCKTAKE_BATCH_MAX)
    .superRefine((counts, ctx) => {
      if (new Set(counts.map((c) => c.skuId)).size !== counts.length) {
        ctx.addIssue({ code: 'custom', message: 'common.errors.validation' });
      }
    }),
  note: z.string().max(INVENTORY_NOTE_MAX).optional(),
});

export const WastageInputSchema = z.object({
  storeId: UuidSchema,
  skuId: UuidSchema,
  qty: z.string().superRefine((value, ctx) => {
    const problem = wastageQtyProblem(value);
    if (problem) ctx.addIssue({ code: 'custom', message: WASTAGE_QTY_MESSAGE[problem] });
  }),
  /** Mandatory reason — wastage rows without context are useless. */
  // CLS-19: a note of only spaces is no note.
  note: z.string().trim().min(1).max(INVENTORY_NOTE_MAX),
});
