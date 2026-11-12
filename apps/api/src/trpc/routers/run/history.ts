/**
 * Finished runs: the history by day, and one run's detail.
 */
import { TRPCError } from '@trpc/server';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema as s } from '@compass/db';
import { RunHistoryInputSchema, SimpleRunCommandSchema } from '@compass/contracts';
import { getActorStoreIdsForPermission } from '../../../services/storeScope';
import { authedProcedure } from '../../trpc';
import { runCorrections } from '../../../services/runCorrections';
import { readRunEvents } from '@compass/streams';
import {
  expensesForReader,
  itemsForStoreReader,
  splitsForReader,
} from '../../../services/runReaderView';
import { loadRunSessions, runSessionsView } from '../../../services/runSessionsView';
import {
  moneyText,
  runDetailMoney,
  runMoneyLinesSql,
  uuidListSql,
  type RunMoneyLine,
} from '../../../services/runMoney';
import { executeRows } from '../../../services/sqlRows';
import { loadRun } from './command';
import { canAmendRun } from './scope';

export const historyProcedures = {
  /**
   * Complete finished-run history for the purchaser-facing history page.
   *
   * This is deliberately a server-side page, not `LIMIT 100` followed by
   * client filtering. Visibility, search and money filters all run before
   * LIMIT/OFFSET, and every monetary field is recomputed from the stores
   * where `prices.view` is actually effective. That matters for mixed-role
   * members (manager in A, staff in B): the flat session permission set is
   * suitable for showing the History tab, but must never authorize B's
   * financial rows or leak B's contribution through the run-level total.
   */
  history: authedProcedure.input(RunHistoryInputSchema.optional()).query(async ({ ctx, input }) =>
    ctx.withOrg(
      async (tx) => {
        const query = input ?? RunHistoryInputSchema.parse({});
        const orgId = ctx.session!.orgId;
        const permissionStoreIds = await getActorStoreIdsForPermission(
          tx,
          ctx.session!.memberId,
          'prices.view',
          ctx.session!.permissions,
        );
        if (permissionStoreIds !== null && permissionStoreIds.length === 0) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'auth.errors.missingPermission',
            cause: { missingPermission: 'prices.view' },
          });
        }

        let scopedStoreIds = permissionStoreIds;
        if (query.storeId) {
          if (permissionStoreIds !== null && !permissionStoreIds.includes(query.storeId)) {
            throw new TRPCError({
              code: 'FORBIDDEN',
              message: 'auth.errors.notAssignedToStore',
            });
          }
          const store = await tx.query.stores.findFirst({
            where: (st, { and: and2, eq: eq2 }) =>
              and2(eq2(st.id, query.storeId!), eq2(st.orgId, orgId)),
            columns: { id: true },
          });
          if (!store) {
            throw new TRPCError({ code: 'NOT_FOUND', message: 'admin.errors.storeNotFound' });
          }
          scopedStoreIds = [query.storeId];
        }

        const storeIdsSql =
          scopedStoreIds === null
            ? null
            : sql.join(
                scopedStoreIds.map((id) => sql`${id}::uuid`),
                sql`, `,
              );
        const splitScopeSql = storeIdsSql ? sql`AND ris.store_id IN (${storeIdsSql})` : sql``;
        const sessionScopeSql = storeIdsSql ? sql`AND os.store_id IN (${storeIdsSql})` : sql``;
        const expenseScopeSql = storeIdsSql
          ? sql`AND (expense_split.value->>'storeId')::uuid IN (${storeIdsSql})`
          : sql``;
        const visibilitySql = storeIdsSql
          ? sql`AND EXISTS (
              SELECT 1
              FROM read_model.order_sessions_v os
              WHERE os.run_id = mr.id
                AND os.org_id = ${orgId}
                ${sessionScopeSql}
            )`
          : sql``;
        const dateFromSql = query.dateFrom
          ? sql`AND mr.run_date >= ${query.dateFrom}::date`
          : sql``;
        const dateToSql = query.dateTo ? sql`AND mr.run_date <= ${query.dateTo}::date` : sql``;

        // Each token must match somewhere, while fields within a token
        // are ORed. Item/vendor and expense matches are joined to the
        // same visible store scope, preventing search-result side channels.
        const searchTokens = (query.search ?? '').trim().split(/\s+/u).filter(Boolean).slice(0, 8);
        const tokenPredicates = searchTokens.map((token) => {
          // HIS-14 (2026-10-30): "%" or "_" typed in search matched every run.
          const pattern = `%${token.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
          return sql`(
            mr.run_date::text ILIKE ${pattern}
            OR ('#' || (mr.run_index + 1)::text) ILIKE ${pattern}
            OR EXISTS (
              SELECT 1
              FROM read_model.order_sessions_v os
              INNER JOIN inventory.stores st ON st.id = os.store_id
              WHERE os.run_id = mr.id
                AND os.org_id = ${orgId}
                ${sessionScopeSql}
                AND (st.name ILIKE ${pattern} OR COALESCE(st.code, '') ILIKE ${pattern})
            )
            OR EXISTS (
              SELECT 1
              FROM read_model.run_items_v ri_search
              INNER JOIN read_model.run_item_stores_v ris
                ON ris.run_id = ri_search.run_id AND ris.sku_id = ri_search.sku_id
              INNER JOIN inventory.skus sku ON sku.id = ri_search.sku_id
              LEFT JOIN inventory.suppliers supplier ON supplier.id = ri_search.supplier_id
              WHERE ri_search.run_id = mr.id
                AND ri_search.status = 'purchased'
                ${splitScopeSql}
                AND (
                  COALESCE(sku.code, '') ILIKE ${pattern}
                  OR sku.names::text ILIKE ${pattern}
                  OR sku.aliases::text ILIKE ${pattern}
                  OR COALESCE(supplier.name, '') ILIKE ${pattern}
                )
            )
            OR EXISTS (
              SELECT 1
              FROM read_model.run_expenses_v expense_search
              CROSS JOIN LATERAL jsonb_array_elements(expense_search.store_splits_json)
                AS expense_split(value)
              WHERE expense_search.run_id = mr.id
                AND expense_search.removed_at IS NULL
                ${expenseScopeSql}
                AND expense_search.label ILIKE ${pattern}
            )
          )`;
        });
        const searchSql =
          tokenPredicates.length > 0 ? sql`AND ${sql.join(tokenPredicates, sql` AND `)}` : sql``;
        const paymentSql =
          query.payment === 'cash'
            ? sql`AND COALESCE(vt.cash_total, 0) > 0
                  AND COALESCE(vt.transfer_total, 0) = 0`
            : query.payment === 'transfer'
              ? sql`AND COALESCE(vt.transfer_total, 0) > 0
                    AND COALESCE(vt.cash_total, 0) = 0`
              : query.payment === 'mixed'
                ? sql`AND COALESCE(vt.cash_total, 0) > 0
                      AND COALESCE(vt.transfer_total, 0) > 0`
                : sql``;

        const historyCte = sql`
          WITH candidate_runs AS (
            SELECT mr.*
            FROM read_model.market_runs_v mr
            WHERE mr.org_id = ${orgId}
              -- D5 (2026-10-31): the same runs finance counts; an
              -- amending run is listed with its status (修改中).
              AND mr.status IN ('finished', 'amending')
              ${dateFromSql}
              ${dateToSql}
              ${visibilitySql}
              ${searchSql}
          ),
          -- 2026-10-21 CA-11: the shared money-line definition
          -- (services/runMoney.ts) — the same rows report.* sums.
          money_lines AS (
            ${runMoneyLinesSql({ runsSql: sql`candidate_runs`, storeIdsSql })}
          ),
          visible_totals AS (
            SELECT
              run_id,
              COALESCE(SUM(amount), 0) AS total,
              COALESCE(SUM(amount) FILTER (WHERE kind = 'item'), 0) AS items_total,
              COALESCE(SUM(amount) FILTER (WHERE kind = 'expense'), 0) AS expenses_total,
              COALESCE(SUM(amount) FILTER (WHERE payment_method = 'cash'), 0) AS cash_total,
              COALESCE(SUM(amount) FILTER (WHERE payment_method = 'transfer'), 0) AS transfer_total,
              (COUNT(DISTINCT sku_id) FILTER (WHERE sku_id IS NOT NULL))::int AS item_count
            FROM money_lines
            GROUP BY run_id
          ),
          visible_store_counts AS (
            SELECT os.run_id, COUNT(DISTINCT os.store_id)::int AS store_count
            FROM read_model.order_sessions_v os
            INNER JOIN candidate_runs cr ON cr.id = os.run_id
            WHERE os.org_id = ${orgId} ${sessionScopeSql}
            GROUP BY os.run_id
          ),
          filtered AS (
            SELECT
              cr.id,
              cr.run_date,
              cr.run_index,
              cr.status,
              cr.finished_at,
              COALESCE(vt.total, 0) AS actual_total,
              COALESCE(vt.items_total, 0) AS items_total,
              COALESCE(vt.expenses_total, 0) AS expenses_total,
              COALESCE(vt.cash_total, 0) AS actual_cash_total,
              COALESCE(vt.transfer_total, 0) AS actual_transfer_total,
              COALESCE(vt.item_count, 0)::int AS item_count,
              COALESCE(vsc.store_count, 0)::int AS store_count
            FROM candidate_runs cr
            LEFT JOIN visible_totals vt ON vt.run_id = cr.id
            LEFT JOIN visible_store_counts vsc ON vsc.run_id = cr.id
            WHERE TRUE ${paymentSql}
          )
        `;

        type SummaryDbRow = {
          total_count: number;
          total: string;
          items_total: string;
          expenses_total: string;
          cash: string;
          transfer: string;
        };
        const summaryRows = executeRows<SummaryDbRow>(
          await tx.execute(sql`
          ${historyCte}
          SELECT
            COUNT(*)::int AS total_count,
            COALESCE(SUM(actual_total), 0)::text AS total,
            COALESCE(SUM(items_total), 0)::text AS items_total,
            COALESCE(SUM(expenses_total), 0)::text AS expenses_total,
            COALESCE(SUM(actual_cash_total), 0)::text AS cash,
            COALESCE(SUM(actual_transfer_total), 0)::text AS transfer
          FROM filtered
        `),
        );
        const summary = summaryRows[0] ?? {
          total_count: 0,
          total: '0',
          items_total: '0',
          expenses_total: '0',
          cash: '0',
          transfer: '0',
        };

        type PageDbRow = {
          id: string;
          run_date: string;
          run_index: number;
          status: string;
          finished_at: Date | string | null;
          actual_total: string;
          items_total: string;
          expenses_total: string;
          actual_cash_total: string;
          actual_transfer_total: string;
          item_count: number;
          store_count: number;
        };
        const directionSql =
          query.sort === 'oldest'
            ? sql`run_date ASC, run_index ASC, id ASC`
            : sql`run_date DESC, run_index DESC, id DESC`;
        // DX-HIS-5 (2026-11-01): the list shows one row per day, so a page
        // never splits a day. A day belongs to the page where its first
        // run falls (pages of `pageSize` runs); a page holding no day start
        // (one day longer than a page) is skipped, so pages stay dense.
        // Before, the second trip of a day could open the next page with
        // half the day's total on each.
        const pagedCte = sql`
          ${historyCte},
          ordered AS (
            SELECT f.*, (ROW_NUMBER() OVER (ORDER BY ${directionSql}) - 1)::int AS pos
            FROM filtered f
          ),
          day_started AS (
            SELECT o.*, MIN(o.pos) OVER (PARTITION BY o.run_date)::int AS day_pos
            FROM ordered o
          ),
          paged AS (
            SELECT d.*, DENSE_RANK() OVER (ORDER BY d.day_pos / ${query.pageSize}::int)::int AS page_no
            FROM day_started d
          )
        `;
        const pageCountRows = executeRows<{ pages: number }>(
          await tx.execute(sql`
          ${pagedCte}
          SELECT COALESCE(MAX(page_no), 0)::int AS pages FROM paged
        `),
        );
        const totalPages = Number(pageCountRows[0]?.pages ?? 0);
        const pageRows = executeRows<PageDbRow & { pos: number }>(
          await tx.execute(sql`
          ${pagedCte}
          SELECT
            pos,
            id::text AS id,
            run_date::text AS run_date,
            run_index,
            status,
            finished_at,
            actual_total::text AS actual_total,
            items_total::text AS items_total,
            expenses_total::text AS expenses_total,
            actual_cash_total::text AS actual_cash_total,
            actual_transfer_total::text AS actual_transfer_total,
            item_count,
            store_count
          FROM paged
          WHERE page_no = ${query.page}
          ORDER BY pos
        `),
        );

        type StoreTotalDbRow = {
          run_id: string;
          store_id: string;
          total: string;
          items_total: string;
          expenses_total: string;
          cash: string;
          transfer: string;
          item_count: number;
        };
        const storeTotalsByRun = new Map<
          string,
          Array<{
            storeId: string;
            total: string;
            itemsTotal: string;
            expensesTotal: string;
            cash: string;
            transfer: string;
            itemCount: number;
          }>
        >();
        const pageRunIds = pageRows.map((row) => row.id);
        if (pageRunIds.length > 0) {
          const runIdsSql = sql.join(
            pageRunIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          );
          const storeTotalRows = executeRows<StoreTotalDbRow>(
            await tx.execute(sql`
            WITH money_lines AS (
              ${runMoneyLinesSql({
                runsSql: sql`(SELECT unnest(ARRAY[${runIdsSql}]::uuid[]) AS id)`,
                storeIdsSql,
              })}
            )
            SELECT
              run_id::text AS run_id,
              store_id::text AS store_id,
              COALESCE(SUM(amount), 0)::text AS total,
              COALESCE(SUM(amount) FILTER (WHERE kind = 'item'), 0)::text AS items_total,
              COALESCE(SUM(amount) FILTER (WHERE kind = 'expense'), 0)::text AS expenses_total,
              COALESCE(SUM(amount) FILTER (WHERE payment_method = 'cash'), 0)::text AS cash,
              COALESCE(SUM(amount) FILTER (WHERE payment_method = 'transfer'), 0)::text AS transfer,
              (COUNT(DISTINCT sku_id) FILTER (WHERE sku_id IS NOT NULL))::int AS item_count
            FROM money_lines
            GROUP BY run_id, store_id
            ORDER BY run_id, SUM(amount) DESC, store_id
          `),
          );
          for (const row of storeTotalRows) {
            const totals = storeTotalsByRun.get(row.run_id) ?? [];
            totals.push({
              storeId: row.store_id,
              total: moneyText(row.total),
              itemsTotal: moneyText(row.items_total),
              expensesTotal: moneyText(row.expenses_total),
              cash: moneyText(row.cash),
              transfer: moneyText(row.transfer),
              itemCount: row.item_count,
            });
            storeTotalsByRun.set(row.run_id, totals);
          }
        }

        const totalCount = Number(summary.total_count ?? 0);
        return {
          rows: pageRows.map((row) => ({
            id: row.id,
            runDate: row.run_date,
            runIndex: row.run_index,
            status: row.status,
            // 2026-10-21 CA-11: actualTotal = itemsTotal + expensesTotal
            // over the reader's visible stores (unchanged meaning here —
            // history always included expenses).
            actualTotal: moneyText(row.actual_total),
            itemsTotal: moneyText(row.items_total),
            expensesTotal: moneyText(row.expenses_total),
            actualCashTotal: moneyText(row.actual_cash_total),
            actualTransferTotal: moneyText(row.actual_transfer_total),
            finishedAt: row.finished_at,
            itemCount: row.item_count,
            storeCount: row.store_count,
            storeTotals: storeTotalsByRun.get(row.id) ?? [],
          })),
          pageInfo: {
            page: query.page,
            pageSize: query.pageSize,
            totalCount,
            totalPages,
            hasPrevious: query.page > 1,
            hasNext: query.page < totalPages,
            /** 1-based positions of this page's first and last run (a page
             *  holds whole days, so it is not always `pageSize` runs). */
            firstRun: pageRows.length > 0 ? pageRows[0]!.pos + 1 : 0,
            lastRun: pageRows.length > 0 ? pageRows[pageRows.length - 1]!.pos + 1 : 0,
          },
          summary: {
            total: moneyText(summary.total),
            itemsTotal: moneyText(summary.items_total),
            expensesTotal: moneyText(summary.expenses_total),
            cash: moneyText(summary.cash),
            transfer: moneyText(summary.transfer),
          },
        };
      },
      {
        isolationLevel: 'repeatable read',
        accessMode: 'read only',
      },
    ),
  ),

  /**
   * Read-only detail payload for History. Unlike `run.get` (the live
   * purchaser workspace), this endpoint requires financial visibility and
   * physically removes every store branch outside that permission scope.
   */
  historyDetail: authedProcedure
    .input(SimpleRunCommandSchema.pick({ runId: true }))
    .query(async ({ ctx, input }) =>
      ctx.withOrg(async (tx) => {
        const allowedStoreIds = await getActorStoreIdsForPermission(
          tx,
          ctx.session!.memberId,
          'prices.view',
          ctx.session!.permissions,
        );
        if (allowedStoreIds !== null && allowedStoreIds.length === 0) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'auth.errors.missingPermission',
            cause: { missingPermission: 'prices.view' },
          });
        }

        const run = await loadRun(tx, ctx.session!.orgId, input.runId);
        // D5 (2026-10-31): a run reopened for amending stays in History
        // (labelled 修改中) — finance counts it too.
        if (run.status !== 'finished' && run.status !== 'amending') {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'run.errors.notVisible' });
        }
        // Already reopened: nothing more to reopen from here.
        const canAmend = run.status === 'finished' && (await canAmendRun(tx, ctx, run));
        const allowedStoreSet = allowedStoreIds === null ? null : new Set(allowedStoreIds);
        const { sessions: visibleSessions, items: sessionItems } = await loadRunSessions(
          tx,
          run.sessionIdsJson,
          allowedStoreSet,
        );
        if (allowedStoreSet && visibleSessions.length === 0) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'run.errors.notVisible' });
        }
        const allItems = await tx.query.runItemsV.findMany({
          where: (item, { eq: eq2 }) => eq2(item.runId, run.id),
          orderBy: (item, { asc }) => asc(item.skuId),
        });
        const allSplits = await tx.query.runItemStoresV.findMany({
          where: (split, { eq: eq2 }) => eq2(split.runId, run.id),
          orderBy: (split, { asc }) => [asc(split.skuId), asc(split.storeId)],
        });
        const { splits, hiddenSkuIds } = splitsForReader(allItems, allSplits, allowedStoreSet);
        const { sessions, perStoreDemand, sessionNotesByStore, sessionExtrasByStore } =
          await runSessionsView(tx, visibleSessions, sessionItems);
        // Never the organisation's quantities, prices or receipts for a
        // store-scoped history reader.
        const items =
          allowedStoreSet === null
            ? allItems
            : itemsForStoreReader(allItems, splits, perStoreDemand, hiddenSkuIds);

        const rawExpenses = await tx.query.runExpensesV.findMany({
          where: (expense, { and: and2, eq: eq2, isNull }) =>
            and2(eq2(expense.runId, run.id), isNull(expense.removedAt)),
          orderBy: (expense, { asc }) => asc(expense.addedAt),
        });
        const expenses = expensesForReader(rawExpenses, allowedStoreSet);

        // DX-HIS-6 (2026-11-01): the detail names each line's supplier.
        // Names come with the payload: catalog.suppliers is not readable
        // by every history reader (a store manager).
        const supplierIds = [
          ...new Set(items.map((item) => item.supplierId).filter((id): id is string => !!id)),
        ];
        const supplierNameById: Record<string, string> = {};
        if (supplierIds.length > 0) {
          const rows = await tx
            .select({ id: s.suppliers.id, name: s.suppliers.name })
            .from(s.suppliers)
            .where(
              and(eq(s.suppliers.orgId, ctx.session!.orgId), inArray(s.suppliers.id, supplierIds)),
            );
          for (const row of rows) supplierNameById[row.id] = row.name;
        }

        // Review RUNWEB2-03 (2026-11): the money, from the lines the History
        // list row and report.* add up, in the stores this reader may see
        // prices in. The page recomputed it with its own copy of the rule.
        const moneyLines = executeRows<RunMoneyLine>(
          await tx.execute(sql`
            SELECT
              store_id::text AS "storeId",
              kind,
              sku_id::text AS "skuId",
              expense_id::text AS "expenseId",
              amount::text AS amount,
              payment_method AS "paymentMethod"
            FROM (
              ${runMoneyLinesSql({
                runsSql: sql`(SELECT ${run.id}::uuid AS id)`,
                storeIdsSql: uuidListSql(allowedStoreIds),
              })}
            ) money_lines
          `),
        );
        const { byStore, bySku, bySplit, byExpense, ...runTotals } = runDetailMoney(moneyLines);

        return {
          id: run.id,
          runDate: run.runDate,
          runIndex: run.runIndex,
          status: run.status,
          finishedAt: run.finishedAt,
          items: items.map((item) => {
            const money = bySku.get(item.skuId);
            return {
              ...item,
              /** What it cost in the visible stores; null when nothing was bought. */
              amount: money?.total ?? null,
              cashAmount: money?.cash ?? null,
              transferAmount: money?.transfer ?? null,
            };
          }),
          splits: splits.map((split) => ({
            ...split,
            amount: bySplit.get(`${split.skuId}|${split.storeId}`)?.total ?? null,
          })),
          perStoreDemand,
          sessionNotesByStore,
          sessionExtrasByStore,
          sessions,
          expenses: expenses.map((expense) => ({
            ...expense,
            /** Its share in the visible stores. */
            amount: byExpense.get(expense.id)?.total ?? null,
          })),
          money: { ...runTotals, byStore },
          supplierNameById,
          canAmend,
          // D3 / D4 (2026-10-31): quantity added in a correction and price
          // changes after receipt, for the history labels.
          corrections: runCorrections(await readRunEvents(tx, run.id), allowedStoreSet),
        };
      }),
    ),
};
