import { z } from 'zod';
import { DateStringSchema, PositiveDecimalStringSchema, UuidSchema } from './common';
import {
  BACKDATE_LIMIT_DAYS,
  SALE_QTY_MESSAGE,
  SALE_VOID_REASON_MAX,
  saleQtyProblem,
} from '../limits';

/**
 * The sales router's inputs. Review CONF-10 (2026-11-11): they were
 * written in the router, so the web could only copy the rules; the rules
 * are in limits.ts now and the web reads them there.
 */

/** A sale's servings: see `saleQtyProblem`. */
export const SaleQtySchema = PositiveDecimalStringSchema.refine(
  (value) => saleQtyProblem(value) !== 'tooLarge',
  { message: SALE_QTY_MESSAGE.tooLarge },
).refine((value) => saleQtyProblem(value) !== 'precision', {
  message: SALE_QTY_MESSAGE.precision,
});

export const SaleRecordInputSchema = z.object({
  storeId: UuidSchema,
  dishId: UuidSchema,
  qty: SaleQtySchema,
  /** Optional ISO timestamp; defaults to NOW(). Lets shift leads
   *  back-fill the day's sales at close-out. Not in the future (CLS-19;
   *  a few minutes of clock skew allowed). */
  occurredAt: z
    .string()
    .datetime()
    .refine((v) => Date.parse(v) <= Date.now() + 10 * 60_000, {
      message: 'sales.errors.occurredInFuture',
    })
    // CLS-19 (2026-10-30, user decision): back-fill at most 90 days.
    .refine((v) => Date.parse(v) >= Date.now() - BACKDATE_LIMIT_DAYS * 86_400_000, {
      message: 'sales.errors.occurredTooOld',
    })
    .optional(),
});

export const SaleVoidInputSchema = z.object({
  saleId: UuidSchema,
  /** Why the sale is being voided — kept on the row for the audit trail. */
  reason: z.string().trim().min(1).max(SALE_VOID_REASON_MAX),
});

/** sales.list and sales.summary: one store's sales over business days. */
export const SalesRangeInputSchema = z.object({
  storeId: UuidSchema,
  /** Inclusive start, a business date in the store's timezone (falling
   *  back to the org timezone). Defaults to that timezone's today. */
  fromDate: DateStringSchema.optional(),
  /** Inclusive end business date, same timezone. Defaults to today. */
  toDate: DateStringSchema.optional(),
});
export type SalesRangeInput = z.infer<typeof SalesRangeInputSchema>;
