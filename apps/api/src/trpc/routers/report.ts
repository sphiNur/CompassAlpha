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
 *   - SCOPE (M3.7, 2026-05-15): TWO modes mirroring run.previewCreatable.
 *     `org.admin` holders (super_admin, admin, future org_chef) see
 *     ALL stores' purchase lines. Store-tier users with `users.manage`
 *     (e.g. manager-of-A) get filtered by their bound stores —
 *     getActorStoreIds returns only the stores they admin and the
 *     query intersects with that list. Earlier this gate was just
 *     "has users.manage" → any user with that perm saw the entire
 *     org's finance, including stores they had no authority over.
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
import { FINANCE_KEYS, financeStoreIds } from '../../services/storeScope';
import { moneyText, runMoneyLinesSql, uuidListSql } from '../../services/runMoney';
import { priceStoreIds, pricesVisibleFor } from '../../services/priceRedaction';

/**
 * 2026-10-21 CA-11: the runs a finance window covers. 'amending' keeps a
 * run in the books while a super-admin corrects it.
 *
 * D5 (2026-10-31): finished and amending only — the same runs History
 * lists. Runs still being bought or delivered used to count here, so the
 * two pages showed different totals for the same day.
 */
function financeRunsSql(orgId: string, startDate: string, endDate: string) {
  return sql`(
    SELECT mr.id
    FROM read_model.market_runs_v mr
    WHERE mr.org_id = ${orgId}
      AND mr.run_date >= ${startDate}::date
      AND mr.run_date <= ${endDate}::date
      AND mr.status IN ('finished', 'amending')
  )`;
}

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

/**
 * RE-HIS-4 (2026-10-31): a reversed range answered 200 with zeros, where
 * run.history refuses it. Same rule here, with the catalog key the web
 * already shows for it.
 */
function rangeInOrder(value: { startDate: string; endDate: string }, ctx: z.RefinementCtx) {
  if (value.startDate > value.endDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endDate'],
      message: 'finance.range.invalid',
    });
  }
}


function requireFinanceRead(permissions: ReadonlySet<string> | undefined): void {
  if (!FINANCE_KEYS.some((key) => permissions?.has(key))) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'admin.errors.financeRequiresManage' });
  }
}

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
   *
   * 2026-10-21 CA-11: off-catalog expenses appear as `kind: 'expense'`
   * lines (one per expense store split, skuId null, label set), so
   * by-day / by-store views carry them; they have no supplier.
   */
  purchaseLines: authedProcedure
    .input(PurchaseLinesInputSchema.superRefine(rangeInOrder))
    .query(async ({ ctx, input }) => {
      requireFinanceRead(ctx.session?.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        // M3.7: store-scope filter. Skip for org.admin holders (they
        // can see the entire chain's finance). For store-tier users
        // with `users.manage` (manager-of-A etc.), compute their
        // bound stores and intersect with the query. If the user
        // explicitly passed input.storeId AND it's outside their set,
        // throw notAssignedToStore so they get a clear error
        // (consistent with sales.list M3.1 behaviour).
        // HIS-1 (2026-10-30): the stores where finance is actually
        // readable, not every store the person is assigned to.
        const allowedStoreIds = await financeStoreIds(tx, ctx.session!);
        if (allowedStoreIds !== null && input.storeId !== undefined) {
          if (!allowedStoreIds.includes(input.storeId)) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'auth.errors.notAssignedToStore',
            });
          }
        }
        // 2026-10-21 CA-11: one row per money line from the shared
        // definition (services/runMoney.ts) — SKU splits priced at
        // COALESCE(per-store override, item price) and paid by the
        // resolved method, PLUS off-catalog expense splits as their own
        // `kind: 'expense'` lines. Before this the report ignored
        // per-store price/payment overrides and every expense, so its
        // total never matched History or the finish sheet.
        const storeIds = input.storeId ? [input.storeId] : allowedStoreIds;
        const rows = (await tx.execute(sql`
          WITH money_lines AS (
            ${runMoneyLinesSql({
              runsSql: financeRunsSql(orgId, input.startDate, input.endDate),
              storeIdsSql: uuidListSql(storeIds),
            })}
          )
          SELECT
            mr.id::text           AS run_id,
            mr.run_date::text     AS run_date,
            mr.run_index          AS run_index,
            ml.kind               AS kind,
            ml.sku_id::text       AS sku_id,
            ml.expense_id::text   AS expense_id,
            ml.label              AS label,
            ml.payment_method     AS payment_method,
            ml.supplier_id::text  AS supplier_id,
            ml.unit_price::text   AS unit_price,
            ml.store_id::text     AS store_id,
            ml.qty::text          AS qty,
            ml.amount::text       AS amount
          FROM money_lines ml
          INNER JOIN read_model.market_runs_v mr ON mr.id = ml.run_id
          WHERE TRUE
            ${input.paymentMethod ? sql`AND ml.payment_method = ${input.paymentMethod}` : sql``}
          ORDER BY mr.run_date DESC, mr.run_index DESC, ml.kind DESC, ml.sku_id, ml.label
        `)) as unknown as Array<{
          run_id: string;
          run_date: string;
          run_index: number;
          kind: 'item' | 'expense';
          sku_id: string | null;
          expense_id: string | null;
          label: string | null;
          payment_method: string;
          supplier_id: string | null;
          unit_price: string;
          store_id: string;
          qty: string;
          amount: string;
        }>;

        // D6 (2026-10-31): unit price and amount only on lines of stores
        // where prices.view holds; what was bought and how much stays.
        const priceStores = await priceStoreIds(tx, ctx.session!);
        return rows.map((r) => {
          const priced = pricesVisibleFor(priceStores, [r.store_id]);
          return {
          runId: r.run_id,
          runDate: r.run_date,
          runIndex: r.run_index,
          /** 'item' = SKU split; 'expense' = off-catalog expense split. */
          kind: r.kind,
          /** Null on expense lines. */
          skuId: r.sku_id,
          /** Expense lines only. */
          expenseId: r.expense_id,
          label: r.label,
          paymentMethod: r.payment_method as 'cash' | 'transfer',
          supplierId: r.supplier_id,
          /** Effective price: the per-store override when one exists.
           *  Null without prices.view for this line's store (D6). */
          unitPrice: priced ? r.unit_price : null,
          storeId: r.store_id,
          qty: r.qty,
          // Pre-compute lineTotal so the FE doesn't need to BigDecimal-
          // multiply for the common "sum these" reduction. D1: rounded
          // half-up to cents in SQL (runMoneyLinesSql), passed as is.
          lineTotal: priced ? moneyText(r.amount) : null,
          };
        });
      });
    }),

  /**
   * Roll-up totals for a date range. Returns the same numbers the FE
   * would compute by summing `purchaseLines`, but keeps the payload
   * tiny (one row) for dashboards / scorecards that only want headline
   * figures without rendering individual lines.
   */
  totals: authedProcedure
    .input(PurchaseLinesInputSchema.omit({ paymentMethod: true }).superRefine(rangeInOrder))
    .query(async ({ ctx, input }) => {
      requireFinanceRead(ctx.session?.permissions);
      return ctx.withOrg(async (tx) => {
        const orgId = ctx.session!.orgId;
        // M3.7: same store-scope split as purchaseLines (above).
        // HIS-1 (2026-10-30): the stores where finance is actually
        // readable, not every store the person is assigned to.
        const allowedStoreIds = await financeStoreIds(tx, ctx.session!);
        if (allowedStoreIds !== null && input.storeId !== undefined) {
          if (!allowedStoreIds.includes(input.storeId)) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'auth.errors.notAssignedToStore',
            });
          }
        }
        // 2026-10-21 CA-11: the same money lines purchaseLines returns,
        // so headline figures equal the sum of the lines and equal the
        // run.history totals for the same runs. items / expenses / total
        // are reported separately.
        const storeIds = input.storeId ? [input.storeId] : allowedStoreIds;
        const rows = (await tx.execute(sql`
          WITH money_lines AS (
            ${runMoneyLinesSql({
              runsSql: financeRunsSql(orgId, input.startDate, input.endDate),
              storeIdsSql: uuidListSql(storeIds),
            })}
          )
          SELECT
            COALESCE(SUM(amount), 0)::text AS total,
            COALESCE(SUM(amount) FILTER (WHERE kind = 'item'), 0)::text AS items_total,
            COALESCE(SUM(amount) FILTER (WHERE kind = 'expense'), 0)::text AS expenses_total,
            COALESCE(SUM(amount) FILTER (WHERE payment_method = 'cash'), 0)::text AS cash_total,
            COALESCE(SUM(amount) FILTER (WHERE payment_method = 'transfer'), 0)::text
              AS transfer_total,
            (COUNT(*) FILTER (WHERE payment_method = 'cash'))::int AS cash_lines,
            (COUNT(*) FILTER (WHERE payment_method = 'transfer'))::int AS transfer_lines,
            -- COUNT(DISTINCT) across both methods (D-04: max() of the
            -- per-method counts under-counted mixed runs).
            COUNT(DISTINCT run_id)::int AS run_count
          FROM money_lines
        `)) as unknown as Array<{
          total: string;
          items_total: string;
          expenses_total: string;
          cash_total: string;
          transfer_total: string;
          cash_lines: number;
          transfer_lines: number;
          run_count: number;
        }>;
        const row = rows[0];
        // D6 (2026-10-31): the money figures need prices.view in every
        // store they add up (a sum over two stores gives each away);
        // the counts stay.
        const priceStores = await priceStoreIds(tx, ctx.session!);
        const scopeStoreIds =
          storeIds ??
          (priceStores === null
            ? []
            : (
                await tx.query.stores.findMany({
                  where: (st, { eq: eq2 }) => eq2(st.orgId, orgId),
                  columns: { id: true },
                })
              ).map((st) => st.id));
        const priced = pricesVisibleFor(priceStores, scopeStoreIds);
        // D1: the lines are already in cents; exact text, no floats.
        const money = (v: string | null | undefined) => (priced ? moneyText(v) : null);
        return {
          totalCash: money(row?.cash_total),
          totalTransfer: money(row?.transfer_total),
          /** items + expenses. */
          total: money(row?.total),
          itemsTotal: money(row?.items_total),
          expensesTotal: money(row?.expenses_total),
          cashLines: row?.cash_lines ?? 0,
          transferLines: row?.transfer_lines ?? 0,
          runCount: row?.run_count ?? 0,
        };
      });
    }),
});
