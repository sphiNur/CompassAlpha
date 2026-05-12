/**
 * Finance reports — reconciliation views over recorded purchases.
 *
 * Added M1.15 (2026-05-08) as the natural follow-up to M1.14's payment-
 * method tracking. M1.14 captured cash vs transfer at every purchase
 * event; M1.15 finally surfaces that data in a way the chain owner can
 * use to reconcile against bank statements and petty-cash drawers.
 *
 * Scope, kept narrow on purpose:
 *
 *   - One procedure (`purchaseLines`) returns a date-bounded flat list
 *     of every recorded purchase line — one row per (run, sku, store
 *     split). Includes payment method, supplier, prices, qty. The FE
 *     does the grouping (by-day-cash / by-supplier / by-store) because
 *     the data set per month is small (< few hundred rows) and the
 *     three view modes share the same input.
 *
 *   - Permission gate is `users.manage` for now (same fence as Admin).
 *     A finer-grained `finance.view` permission is a follow-up if/when
 *     the finance team gets separate Telegram accounts.
 *
 * Why server-side, not client-side aggregation:
 *
 *   The raw rows live behind RLS — we MUST go through the API so the
 *   per-org scope holds. The aggregation could happen here too, but
 *   keeping it client-side means new report views don't need backend
 *   changes. Tradeoff accepted: a year of data is still cheap to ship
 *   (< 5000 rows × ~200 bytes = 1 MB). When that bites, paginate.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { DateStringSchema, UuidSchema } from '@compass/contracts';
import { authedProcedure, router } from '../trpc';
import { TRPCError } from '@trpc/server';

const PurchaseLinesInputSchema = z.object({
  /** Inclusive start date (YYYY-MM-DD), matched against market_runs_v.runDate. */
  startDate: DateStringSchema,
  /** Inclusive end date (YYYY-MM-DD). */
  endDate: DateStringSchema,
  /** Filter to a single destination store. Omit to return all stores. */
  storeId: UuidSchema.optional(),
  /** Filter to one payment method. Omit to return both. */
  paymentMethod: z.enum(['cash', 'transfer']).optional(),
});

export const reportRouter = router({
  /**
   * Flat list of every purchase line in the date range. One row per
   * (run, sku, destination-store) — i.e. if Apple was bought 3kg total
   * and split 2/1 across two stores, you get TWO rows here, each with
   * the store's slice of the qty.
   *
   * Line value = `qty × unitPrice` (the per-store share, not the run-
   * level total). This matches how a finance person reads it: "store A
   * spent ₸2,000 on Apple on 2026-05-08, paid cash" — store-attributable
   * spend, not run-attributable.
   */
  purchaseLines: authedProcedure
    .input(PurchaseLinesInputSchema)
    .query(async ({ ctx, input }) => {
      if (!ctx.session?.permissions.has('users.manage')) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'admin.errors.financeRequiresManage',
        });
      }
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        // Pull every per-store split for purchased rows in the date
        // window. We join through run → run_item → run_item_stores so
        // each output row already has the store-scoped qty (the only
        // thing finance reconciles against).
        const rows = (await tx.execute(sql`
          SELECT
            mr.id::text          AS run_id,
            mr.run_date::text    AS run_date,
            mr.run_index         AS run_index,
            ri.sku_id::text      AS sku_id,
            ri.payment_method    AS payment_method,
            ri.supplier_id::text AS supplier_id,
            ri.unit_price::text  AS unit_price,
            ris.store_id::text   AS store_id,
            ris.qty::text        AS qty
          FROM read_model.market_runs_v mr
          INNER JOIN read_model.run_items_v ri
            ON ri.run_id = mr.id
          INNER JOIN read_model.run_item_stores_v ris
            ON ris.run_id = ri.run_id AND ris.sku_id = ri.sku_id
          WHERE mr.org_id = ${orgId}
            AND mr.run_date >= ${input.startDate}::date
            AND mr.run_date <= ${input.endDate}::date
            AND ri.status = 'purchased'
            AND mr.status IN ('purchasing', 'delivering', 'finished')
            ${input.storeId ? sql`AND ris.store_id = ${input.storeId}` : sql``}
            ${input.paymentMethod ? sql`AND ri.payment_method = ${input.paymentMethod}` : sql``}
          ORDER BY mr.run_date DESC, mr.run_index DESC, ri.sku_id
        `)) as unknown as Array<{
          run_id: string;
          run_date: string;
          run_index: number;
          sku_id: string;
          payment_method: string;
          supplier_id: string | null;
          unit_price: string;
          store_id: string;
          qty: string;
        }>;

        return rows.map((r) => ({
          runId: r.run_id,
          runDate: r.run_date,
          runIndex: r.run_index,
          skuId: r.sku_id,
          paymentMethod: r.payment_method as 'cash' | 'transfer',
          supplierId: r.supplier_id,
          unitPrice: r.unit_price,
          storeId: r.store_id,
          qty: r.qty,
          // Pre-compute lineTotal so the FE doesn't need to BigDecimal-
          // multiply for the common "sum these" reduction. Floating-
          // point is fine for display (we round in the UI); the source
          // of truth for accountancy stays the unit_price × qty pair.
          lineTotal: (Number(r.unit_price) * Number(r.qty)).toFixed(2),
        }));
      });
    }),

  /**
   * Roll-up totals for a date range. Returns the same numbers the FE
   * would compute by summing `purchaseLines`, but keeps the payload
   * tiny (one row) for dashboards / scorecards that only want headline
   * figures without rendering individual lines.
   */
  totals: authedProcedure
    .input(PurchaseLinesInputSchema.omit({ paymentMethod: true }))
    .query(async ({ ctx, input }) => {
      if (!ctx.session?.permissions.has('users.manage')) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'admin.errors.financeRequiresManage',
        });
      }
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        const rows = (await tx.execute(sql`
          SELECT
            ri.payment_method AS payment_method,
            COALESCE(SUM(ri.unit_price * ris.qty), 0)::text AS total,
            COUNT(DISTINCT mr.id)::int AS run_count,
            COUNT(*)::int AS line_count
          FROM read_model.market_runs_v mr
          INNER JOIN read_model.run_items_v ri
            ON ri.run_id = mr.id
          INNER JOIN read_model.run_item_stores_v ris
            ON ris.run_id = ri.run_id AND ris.sku_id = ri.sku_id
          WHERE mr.org_id = ${orgId}
            AND mr.run_date >= ${input.startDate}::date
            AND mr.run_date <= ${input.endDate}::date
            AND ri.status = 'purchased'
            AND mr.status IN ('purchasing', 'delivering', 'finished')
            ${input.storeId ? sql`AND ris.store_id = ${input.storeId}` : sql``}
          GROUP BY ri.payment_method
        `)) as unknown as Array<{
          payment_method: string;
          total: string;
          run_count: number;
          line_count: number;
        }>;

        const cash = rows.find((r) => r.payment_method === 'cash');
        const transfer = rows.find((r) => r.payment_method === 'transfer');
        const cashTotal = cash ? Number(cash.total) : 0;
        const transferTotal = transfer ? Number(transfer.total) : 0;
        return {
          totalCash: cashTotal.toFixed(2),
          totalTransfer: transferTotal.toFixed(2),
          total: (cashTotal + transferTotal).toFixed(2),
          cashLines: cash?.line_count ?? 0,
          transferLines: transfer?.line_count ?? 0,
          runCount: Math.max(cash?.run_count ?? 0, transfer?.run_count ?? 0),
        };
      });
    }),
});

