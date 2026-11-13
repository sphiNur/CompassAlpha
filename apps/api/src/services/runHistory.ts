/**
 * What run.history and run.historyDetail read (review RUNAPI-13,
 * 2026-11-12): the queries moved here from routers/run/history.ts; the
 * router keeps the input, the prices.view scope and the shape of the
 * answer.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema as s, type DB } from '@compass/db';
import type { RunHistoryInput } from '@compass/contracts';
import { runMoneyLinesSql, uuidListSql, type RunMoneyLine } from './runMoney';
import { executeRows } from './sqlRows';

/** Whether `storeId` is one of the organisation's stores. */
export async function orgHasStore(tx: DB, orgId: string, storeId: string): Promise<boolean> {
  const store = await tx.query.stores.findFirst({
    where: (st, { and: and2, eq: eq2 }) => and2(eq2(st.id, storeId), eq2(st.orgId, orgId)),
    columns: { id: true },
  });
  return !!store;
}

/** One run of a history page: its money over the stores the reader may see. */
export interface HistoryPageRow {
  /** 0-based position of the run in the whole filtered list. */
  pos: number;
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
}

/** The whole filtered list: how many runs, their money, how many pages. */
export interface HistorySummaryRow {
  total_count: number;
  total: string;
  items_total: string;
  expenses_total: string;
  cash: string;
  transfer: string;
  pages: number;
}

/** One store's money in one run of the page. */
export interface HistoryStoreTotalRow {
  run_id: string;
  store_id: string;
  total: string;
  items_total: string;
  expenses_total: string;
  cash: string;
  transfer: string;
  item_count: number;
}

/**
 * A page of finished runs (and runs under amendment), with the summary of
 * the whole filtered list and each page run's money per store.
 *
 * `scopedStoreIds` (null: every store) are the stores whose money the
 * reader may see. Visibility, search and money filters all run before
 * the page is cut, and every amount is recomputed from those stores'
 * money lines.
 */
export async function historyPage(
  tx: DB,
  orgId: string,
  query: RunHistoryInput,
  scopedStoreIds: readonly string[] | null,
): Promise<{
  summary: HistorySummaryRow | undefined;
  pageRows: HistoryPageRow[];
  storeTotalRows: HistoryStoreTotalRow[];
}> {
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
  const dateFromSql = query.dateFrom ? sql`AND mr.run_date >= ${query.dateFrom}::date` : sql``;
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
            -- RUNAPI-22: the names and aliases themselves, not their
            -- JSON text ("en" or "ru" matched every product).
            OR EXISTS (
              SELECT 1 FROM jsonb_path_query(sku.names, 'lax $.*') AS name(value)
              WHERE name.value #>> '{}' ILIKE ${pattern}
            )
            OR EXISTS (
              SELECT 1 FROM jsonb_path_query(sku.aliases, 'lax $.*[*]') AS alias(value)
              WHERE alias.value #>> '{}' ILIKE ${pattern}
            )
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
  // The totals and the page count in one pass over the runs (review
  // RUNAPI-21: each was a pass of its own, three with the page).
  const summaryRows = executeRows<HistorySummaryRow>(
    await tx.execute(sql`
    ${pagedCte}
    SELECT
      COUNT(*)::int AS total_count,
      COALESCE(SUM(actual_total), 0)::text AS total,
      COALESCE(SUM(items_total), 0)::text AS items_total,
      COALESCE(SUM(expenses_total), 0)::text AS expenses_total,
      COALESCE(SUM(actual_cash_total), 0)::text AS cash,
      COALESCE(SUM(actual_transfer_total), 0)::text AS transfer,
      COALESCE(MAX(page_no), 0)::int AS pages
    FROM paged
  `),
  );
  const pageRows = executeRows<HistoryPageRow>(
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

  const pageRunIds = pageRows.map((row) => row.id);
  let storeTotalRows: HistoryStoreTotalRow[] = [];
  if (pageRunIds.length > 0) {
    const runIdsSql = sql.join(
      pageRunIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    storeTotalRows = executeRows<HistoryStoreTotalRow>(
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
  }
  return { summary: summaryRows[0], pageRows, storeTotalRows };
}

/**
 * DX-HIS-6 (2026-11-01): the names of these suppliers of the organisation.
 * They come with the history detail: catalog.suppliers is not readable by
 * every history reader (a store manager).
 */
export async function supplierNames(
  tx: DB,
  orgId: string,
  supplierIds: readonly string[],
): Promise<Record<string, string>> {
  const supplierNameById: Record<string, string> = {};
  if (supplierIds.length === 0) return supplierNameById;
  const rows = await tx
    .select({ id: s.suppliers.id, name: s.suppliers.name })
    .from(s.suppliers)
    .where(and(eq(s.suppliers.orgId, orgId), inArray(s.suppliers.id, [...supplierIds])));
  for (const row of rows) supplierNameById[row.id] = row.name;
  return supplierNameById;
}

/**
 * Review RUNWEB2-03 (2026-11): one run's money lines, in the stores of
 * `allowedStoreIds` (null: every store): the lines the History list row
 * and report.* add up.
 */
export async function runDetailMoneyLines(
  tx: DB,
  runId: string,
  allowedStoreIds: readonly string[] | null,
): Promise<RunMoneyLine[]> {
  return executeRows<RunMoneyLine>(
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
          runsSql: sql`(SELECT ${runId}::uuid AS id)`,
          storeIdsSql: uuidListSql(allowedStoreIds),
        })}
      ) money_lines
    `),
  );
}
