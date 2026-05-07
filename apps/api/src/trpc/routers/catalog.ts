import { eq, and, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { schema as s } from '@compass/db';
import { SkuListInputSchema } from '@compass/contracts';
import { authedProcedure, router } from '../trpc';

export const catalogRouter = router({
  categories: authedProcedure.query(async ({ ctx }) => {
    return ctx.withOrg(async (tx) => {
      return tx.query.categories.findMany({
        where: (c, { eq: eq2, and: and2 }) =>
          and2(eq2(c.orgId, ctx.session!.orgId), eq2(c.isArchived, false)),
        orderBy: (c, { asc }) => asc(c.sortIndex),
      });
    });
  }),

  skus: authedProcedure.input(SkuListInputSchema).query(async ({ ctx, input }) => {
    return ctx.withOrg(async (tx) => {
      const rows = await tx
        .select()
        .from(s.skus)
        .where(
          input.categoryId
            ? and(
                eq(s.skus.orgId, ctx.session!.orgId),
                eq(s.skus.isArchived, input.includeArchived ? s.skus.isArchived : false),
                eq(s.skus.categoryId, input.categoryId),
              )
            : and(
                eq(s.skus.orgId, ctx.session!.orgId),
                eq(s.skus.isArchived, input.includeArchived ? s.skus.isArchived : false),
              ),
        );
      return rows.map((r) => ({
        id: r.id,
        categoryId: r.categoryId,
        code: r.code,
        names: r.names as Record<string, string>,
        unit: r.unit,
        step: r.step,
        imageUrl: r.imageUrl,
        suggestedQty: r.suggestedQty,
        sortIndex: r.sortIndex,
        isArchived: r.isArchived,
      }));
    });
  }),

  stores: authedProcedure.query(async ({ ctx }) => {
    return ctx.withOrg(async (tx) => {
      return tx.query.stores.findMany({
        where: (st, { eq: eq2 }) => eq2(st.orgId, ctx.session!.orgId),
        orderBy: (st, { asc }) => asc(st.sortIndex),
      });
    });
  }),

  suppliers: authedProcedure.query(async ({ ctx }) => {
    return ctx.withOrg(async (tx) => {
      return tx.query.suppliers.findMany({
        where: (sup, { eq: eq2 }) => eq2(sup.orgId, ctx.session!.orgId),
        orderBy: (sup, { asc }) => asc(sup.name),
      });
    });
  }),

  /**
   * Per-SKU price statistics from `inventory.price_history` (added 2026-05-05).
   *
   * Powers two surfaces:
   *   1. OrderPage review sheet — staff sees an estimated total before
   *      submitting. Uses `avg7d` so a freak-sale day a week ago doesn't
   *      skew tomorrow's expected cost.
   *   2. ApprovalPage cards — manager sees the same estimate alongside
   *      the qty count, so they're not blind-approving budget impact.
   *   3. Admin Operations Price report — per-SKU table with trend.
   *
   * Pure read; aggregates the last 30 days into 3 numbers per SKU:
   *   - lastPrice / lastObservedAt — most-recent price seen
   *   - avg7d — mean of price observations from last 7 days (null if
   *             no observations yet)
   *   - avg30d — mean over 30 days
   *
   * Optional `skuIds` filter — if present, returns ONLY those SKUs (to
   * keep the OrderPage review-sheet payload small). Omitted = all SKUs
   * with at least one observation in 30 days.
   */
  skuPriceStats: authedProcedure
    .input(
      z
        .object({
          skuIds: z.array(z.string().uuid()).max(500).optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        // Pull the raw observations once and aggregate in JS — keeps
        // the SQL simple (no FILTER/ROLLUP) and lets us run a single
        // round-trip even with the optional skuIds filter applied.
        const obs = await tx
          .select({
            skuId: s.priceHistory.skuId,
            unitPrice: s.priceHistory.unitPrice,
            observedAt: s.priceHistory.observedAt,
          })
          .from(s.priceHistory)
          .where(
            and(
              eq(s.priceHistory.orgId, orgId),
              gte(s.priceHistory.observedAt, since30),
              input?.skuIds && input.skuIds.length > 0
                ? sql`${s.priceHistory.skuId} = ANY(${input.skuIds})`
                : undefined,
            ),
          )
          .orderBy(s.priceHistory.skuId, s.priceHistory.observedAt);

        type Acc = {
          last: { price: number; at: Date } | null;
          sum7: number;
          n7: number;
          sum30: number;
          n30: number;
        };
        const bySku = new Map<string, Acc>();
        for (const r of obs) {
          const price = Number(r.unitPrice);
          if (!Number.isFinite(price)) continue;
          let acc = bySku.get(r.skuId);
          if (!acc) {
            acc = { last: null, sum7: 0, n7: 0, sum30: 0, n30: 0 };
            bySku.set(r.skuId, acc);
          }
          acc.sum30 += price;
          acc.n30 += 1;
          if (r.observedAt >= since7) {
            acc.sum7 += price;
            acc.n7 += 1;
          }
          if (!acc.last || r.observedAt > acc.last.at) {
            acc.last = { price, at: r.observedAt };
          }
        }
        return [...bySku.entries()].map(([skuId, a]) => ({
          skuId,
          lastPrice: a.last ? a.last.price.toFixed(2) : null,
          lastObservedAt: a.last ? a.last.at.toISOString() : null,
          avg7d: a.n7 > 0 ? (a.sum7 / a.n7).toFixed(2) : null,
          avg30d: a.n30 > 0 ? (a.sum30 / a.n30).toFixed(2) : null,
          observations30d: a.n30,
        }));
      });
    }),
});
