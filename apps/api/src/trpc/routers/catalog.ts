import { eq, and, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { schema as s } from '@compass/db';
import { SkuListInputSchema } from '@compass/contracts';
import { authedProcedure, router } from '../trpc';
import { loadSkuPriceStats } from '../../services/priceStats';
import { getActorStoreIds, getActorStoreIdsForPermission } from '../../services/storeScope';

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

  stores: authedProcedure
    .input(
      z
        .object({
          permission: z
            .enum(['prices.view', 'run.purchase', 'users.manage', 'settlement.record'])
            .optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      return ctx.withOrg(async (tx) => {
        // Store names are themselves tenant data. Resolve scope for the
        // concrete consumer instead of exposing every org store to any signed-
        // in employee (especially important for the financial History page).
        let allowedStoreIds = input?.permission
          ? await getActorStoreIdsForPermission(
              tx,
              ctx.session!.memberId,
              input.permission,
              ctx.session!.permissions,
            )
          : await getActorStoreIds(tx, ctx.session!.memberId, ctx.session!.permissions);
        // Settlement routes require BOTH an effective permission and store
        // assignment (except the persisted org-admin bypass). Keep this
        // picker query identical to that write boundary: a custom global
        // settlement grant must not make unassigned stores appear selectable.
        if (input?.permission === 'settlement.record') {
          const assignedStoreIds = await getActorStoreIds(
            tx,
            ctx.session!.memberId,
            ctx.session!.permissions,
          );
          if (assignedStoreIds !== null) {
            const assigned = new Set(assignedStoreIds);
            allowedStoreIds =
              allowedStoreIds === null
                ? assignedStoreIds
                : allowedStoreIds.filter((storeId) => assigned.has(storeId));
          }
        }
        if (allowedStoreIds !== null && allowedStoreIds.length === 0) return [];
        return tx.query.stores.findMany({
          where: (st) =>
            and(
              eq(st.orgId, ctx.session!.orgId),
              ...(allowedStoreIds === null ? [] : [inArray(st.id, allowedStoreIds)]),
              ...(input?.permission === 'settlement.record'
                ? [eq(st.isActive, true), isNull(st.deletedAt)]
                : []),
            ),
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
        // 2026-07-30: the 30-line last/avg7d/avg30d accumulator that used
        // to live inline moved to services/priceStats.ts so
        // order.pendingList can put the SAME figure on approval cards.
        // Two copies of this arithmetic would drift.
        const stats = await loadSkuPriceStats(tx, ctx.session!.orgId, input?.skuIds);
        return [...stats.values()].map((a) => ({
          skuId: a.skuId,
          lastPrice: a.lastPrice != null ? a.lastPrice.toFixed(2) : null,
          lastObservedAt: a.lastObservedAt ? a.lastObservedAt.toISOString() : null,
          avg7d: a.avg7d != null ? a.avg7d.toFixed(2) : null,
          avg30d: a.avg30d != null ? a.avg30d.toFixed(2) : null,
          observations30d: a.observations30d,
        }));
      });
    }),
});
