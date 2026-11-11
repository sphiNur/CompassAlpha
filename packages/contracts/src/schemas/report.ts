import { z } from 'zod';
import { DateStringSchema, UuidSchema } from './common';

/**
 * The finance report's inputs. Review CONF-10 (2026-11-11): they were
 * written in the router.
 */

/**
 * RE-HIS-4 (2026-10-31): a reversed range answered 200 with zeros, where
 * run.history refuses it. Same rule here, with the catalog key the web
 * already shows for it. Applied by the router after `omit`, which a
 * refined schema no longer has.
 */
export function dateRangeInOrder(
  value: { startDate: string; endDate: string },
  ctx: z.RefinementCtx,
): void {
  if (value.startDate > value.endDate) {
    ctx.addIssue({ code: 'custom', path: ['endDate'], message: 'finance.range.invalid' });
  }
}

/** report.purchaseLines; report.totals takes it without `paymentMethod`. */
export const PurchaseLinesInputSchema = z.object({
  /** Inclusive start date (YYYY-MM-DD), matched against market_runs_v.runDate. */
  startDate: DateStringSchema,
  /** Inclusive end date (YYYY-MM-DD). */
  endDate: DateStringSchema,
  /** Filter to a single destination store. Omit to return all stores. */
  storeId: UuidSchema.optional(),
  /** Filter to one payment method. Omit to return both. */
  paymentMethod: z.enum(['cash', 'transfer']).optional(),
});
