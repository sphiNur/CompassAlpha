/**
 * What run.list and run.get read (review RUNAPI-13, 2026-11-12): the
 * queries moved here from routers/run/read.ts; the router keeps the
 * input, who may read what, and the shape of the answer (store and price
 * redaction). History's detail reads a run's lines and expenses here too.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { schema as s, type DB } from '@compass/db';
import { toCents } from '@compass/contracts';
import { replayRun } from '@compass/domain/run';
import { readRunEvents } from './runStream';
import { runMoneyLinesSql, uuidListSql } from './runMoney';
import { inUuids } from './sqlIn';
import { executeRows } from './sqlRows';

/** Runs not finished or cancelled: run.list keeps them whatever their age (RUNAPI-06). */
const OPEN_RUN_STATUSES = ['planned', 'purchasing', 'delivering', 'amending'];

/**
 * The runs run.list shows a reader of `allowedStoreIds` (null: every
 * store): the newest 50, and every run still open, newest first.
 *
 * Review RUNAPI-06 (2026-11-09): the store scope is applied in SQL,
 * before the limit, as run.history does; and a run still open is listed
 * however old it is. The org's newest 50 were taken first and filtered
 * after, so a store reader could get far fewer than 50, and a run waiting
 * for a store's receipt fell off the receiving page once 50 newer runs
 * existed: that store could never confirm it, and the run could never
 * finish.
 */
export async function listedRuns(tx: DB, orgId: string, allowedStoreIds: readonly string[] | null) {
  const visibleToReader =
    allowedStoreIds === null
      ? undefined
      : sql`EXISTS (
          SELECT 1 FROM read_model.order_sessions_v os
          WHERE os.org_id = ${orgId}
            AND os.store_id IN (${uuidListSql(allowedStoreIds)})
            AND os.id IN (
              SELECT (jsonb_array_elements_text(${s.marketRunsV.sessionIdsJson}))::uuid
            )
        )`;
  const orgRuns = and(eq(s.marketRunsV.orgId, orgId), visibleToReader);
  const newestFirst = [desc(s.marketRunsV.runDate), desc(s.marketRunsV.runIndex)] as const;
  const open = await tx
    .select()
    .from(s.marketRunsV)
    .where(and(orgRuns, inArray(s.marketRunsV.status, OPEN_RUN_STATUSES)))
    .orderBy(...newestFirst);
  const recent = await tx
    .select()
    .from(s.marketRunsV)
    .where(orgRuns)
    .orderBy(...newestFirst)
    .limit(50);
  const recentIds = new Set(recent.map((r) => r.id));
  return [...recent, ...open.filter((r) => !recentIds.has(r.id))].sort(
    (a, b) => b.runDate.localeCompare(a.runDate) || b.runIndex - a.runIndex,
  );
}

/** The store of each of these order sessions. */
export async function sessionStores(
  tx: DB,
  sessionIds: readonly string[],
): Promise<Map<string, string>> {
  const storeBySession = new Map<string, string>();
  if (sessionIds.length === 0) return storeBySession;
  const rows = await tx.query.orderSessionsV.findMany({
    where: (sess, { inArray: inArray2 }) => inArray2(sess.id, [...sessionIds]),
    columns: { id: true, storeId: true },
  });
  for (const row of rows) storeBySession.set(row.id, row.storeId);
  return storeBySession;
}

/** One store's money in a run, in cents (run.list). */
export interface RunStoreTotal {
  storeId: string;
  total: bigint;
  itemsTotal: bigint;
  expensesTotal: bigint;
  cash: bigint;
  transfer: bigint;
  /** Items-only cash/transfer — partitions the frozen actual_total. */
  itemsCash: bigint;
  itemsTransfer: bigint;
  itemCount: number;
}

/**
 * Each run's money per store, over `allowedStoreIds` (null: every store),
 * by run then store.
 *
 * 2026-10-21 CA-11: from the shared money-line SQL (services/runMoney.ts)
 * — items at COALESCE(split override, item price) PLUS active expenses —
 * so run.list agrees with run.history and report.*. Before, this was
 * items-only JS float math and silently dropped expenses. D1 (2026-10-31):
 * integer cents — the lines are rounded to cents in SQL, and adding them
 * as floats could drift.
 */
export async function runStoreTotals(
  tx: DB,
  runIds: readonly string[],
  allowedStoreIds: readonly string[] | null,
): Promise<Map<string, Map<string, RunStoreTotal>>> {
  const totalsByRun = new Map<string, Map<string, RunStoreTotal>>();
  const moneyRows = executeRows<{
    run_id: string;
    store_id: string;
    total: string;
    items_total: string;
    expenses_total: string;
    cash: string;
    transfer: string;
    items_cash: string;
    items_transfer: string;
    item_count: number;
  }>(
    await tx.execute(sql`
      WITH money_lines AS (
        ${runMoneyLinesSql({
          runsSql: sql`(SELECT unnest(ARRAY[${uuidListSql(runIds)}]::uuid[]) AS id)`,
          storeIdsSql: uuidListSql(allowedStoreIds),
        })}
      )
      SELECT
        run_id::text AS run_id,
        store_id::text AS store_id,
        COALESCE(SUM(amount), 0)::text AS total,
        COALESCE(SUM(amount) FILTER (WHERE kind = 'item'), 0)::text AS items_total,
        COALESCE(SUM(amount) FILTER (WHERE kind = 'expense'), 0)::text AS expenses_total,
        COALESCE(SUM(amount) FILTER (WHERE payment_method = 'transfer'), 0)::text AS transfer,
        COALESCE(SUM(amount) FILTER (WHERE payment_method = 'cash'), 0)::text AS cash,
        COALESCE(SUM(amount) FILTER (WHERE kind = 'item' AND payment_method = 'transfer'), 0)::text
          AS items_transfer,
        COALESCE(SUM(amount) FILTER (WHERE kind = 'item' AND payment_method = 'cash'), 0)::text
          AS items_cash,
        (COUNT(DISTINCT sku_id) FILTER (WHERE sku_id IS NOT NULL))::int AS item_count
      FROM money_lines
      GROUP BY run_id, store_id
    `),
  );
  for (const row of moneyRows) {
    let runTotals = totalsByRun.get(row.run_id);
    if (!runTotals) {
      runTotals = new Map<string, RunStoreTotal>();
      totalsByRun.set(row.run_id, runTotals);
    }
    runTotals.set(row.store_id, {
      storeId: row.store_id,
      total: toCents(row.total),
      itemsTotal: toCents(row.items_total),
      expensesTotal: toCents(row.expenses_total),
      cash: toCents(row.cash),
      transfer: toCents(row.transfer),
      itemsCash: toCents(row.items_cash),
      itemsTransfer: toCents(row.items_transfer),
      itemCount: row.item_count,
    });
  }
  return totalsByRun;
}

/**
 * A run's items and their store splits (run.get, run.historyDetail).
 *
 * 2026-07-26: both queries were unordered. Postgres returns heap order,
 * and every UPDATE (i.e. every recorded purchase) writes a new tuple at
 * the heap tail — so a row the purchaser just saved jumped to the bottom
 * of the list. Combined with the RunPage's 6s poll, the whole list could
 * reshuffle under the user's thumb mid-market. Ordering by the read
 * model's PK columns is stable, free (both are index scans on (run_id,
 * sku_id[, store_id])), and gives the client a deterministic base to
 * re-sort on top of.
 */
export async function runLines(tx: DB, runId: string) {
  const items = await tx.query.runItemsV.findMany({
    where: (i, { eq: eq2 }) => eq2(i.runId, runId),
    orderBy: (i, { asc }) => asc(i.skuId),
  });
  const splits = await tx.query.runItemStoresV.findMany({
    where: (i, { eq: eq2 }) => eq2(i.runId, runId),
    orderBy: (i, { asc }) => [asc(i.skuId), asc(i.storeId)],
  });
  return { items, splits };
}

/**
 * What only a run's stream says (a run stream is a few dozen events):
 *   - BUY-5 (2026-10-30): each product's "still need X", demand that
 *     joined after it was decided (no read-model column);
 *   - DX-DLV-13 (2026-11-01): the stores whose delivery was recalled and
 *     not made again, in the order the stream first names them. Their
 *     receiving page said "nothing to receive", as if the goods had never
 *     been on the way.
 */
export async function runStreamFacts(
  tx: DB,
  runId: string,
): Promise<{ topUpQtyBySku: Map<string, string | null>; recalledStoreIds: string[] }> {
  const events = await readRunEvents(tx, runId);
  const state = replayRun(runId, events);
  const topUpQtyBySku = new Map<string, string | null>();
  for (const [skuId, item] of state.items) topUpQtyBySku.set(skuId, item.topUpQty ?? null);
  const lastDeliveryEvent = new Map<string, string>();
  for (const e of events) {
    if (e.type === 'StoreDelivered' || e.type === 'StoreDeliveryUndone') {
      lastDeliveryEvent.set(e.payload.storeId, e.type);
    }
  }
  const recalledStoreIds: string[] = [];
  for (const [storeId, type] of lastDeliveryEvent) {
    if (type === 'StoreDeliveryUndone') recalledStoreIds.push(storeId);
  }
  return { topUpQtyBySku, recalledStoreIds };
}

/** A supplier and how to reach it. */
export interface SupplierContact {
  id: string;
  name: string;
  contactPhone: string | null;
  contactTg: string | null;
}

/**
 * M3.27 (2026-05-18): each product's preferred supplier (null: none), for
 * the active run's "by vendor" view. Mirrors previewCreatable's logic
 * (preview/active should always agree on which stall an item is routed
 * to). Only one DISTINCT ON query for all products.
 */
export async function preferredSuppliers(
  tx: DB,
  skuIds: readonly string[],
): Promise<Record<string, SupplierContact | null>> {
  const supplierBySku: Record<string, SupplierContact | null> = {};
  if (skuIds.length === 0) return supplierBySku;
  const rows = await tx.execute<{
    sku_id: string;
    supplier_id: string;
    name: string;
    contact_phone: string | null;
    contact_tg: string | null;
  }>(sql`
    SELECT DISTINCT ON (sl.sku_id)
      sl.sku_id, sl.supplier_id,
      sup.name, sup.contact_phone, sup.contact_tg
    FROM inventory.sku_supplier_links sl
    INNER JOIN inventory.suppliers sup ON sup.id = sl.supplier_id
    WHERE sl.sku_id IN ${skuIds}
      AND sup.is_archived = false
      AND sl.is_preferred = true
    ORDER BY sl.sku_id,
             sl.last_seen_at DESC NULLS LAST
  `);
  for (const r of executeRows<(typeof rows)[number]>(rows)) {
    supplierBySku[r.sku_id] = {
      id: r.supplier_id,
      name: r.name,
      contactPhone: r.contact_phone,
      contactTg: r.contact_tg,
    };
  }
  for (const sid of skuIds) {
    if (!(sid in supplierBySku)) supplierBySku[sid] = null;
  }
  return supplierBySku;
}

/**
 * The most recent price paid for each product on an earlier trip, and
 * when it was observed: the inline price prefill ("如果今天市场上价格还是一样
 * 就不用再受定改了") and how far to trust it (2026-07-26). One DISTINCT ON
 * pull, one row per product.
 *
 * `visibleStoreIds` (null: every store) are the stores a store-scoped
 * reader is shown. An ordinary purchase (no per-store price) records ONE
 * price_history row with no store_id; only split overrides record a row
 * per store. Filtering on store_id alone therefore hid every past price
 * from a store-scoped purchaser (the built-in purchaser role): no
 * carried-over price, no one-tap buy, no 5x check. A store-less row
 * counts when that purchase was split to one of the reader's stores.
 */
export async function lastPricesBefore(
  tx: DB,
  orgId: string,
  runId: string,
  skuIds: readonly string[],
  visibleStoreIds: readonly string[] | null,
): Promise<{
  lastPriceBySku: Record<string, string>;
  lastPriceObservedAtBySku: Record<string, string>;
}> {
  const lastPriceBySku: Record<string, string> = {};
  const lastPriceObservedAtBySku: Record<string, string> = {};
  if (skuIds.length === 0) return { lastPriceBySku, lastPriceObservedAtBySku };
  let priceStoreScope = sql``;
  if (visibleStoreIds !== null) {
    const visibleStoreList = sql.join(
      visibleStoreIds.map((storeId) => sql`${storeId}::uuid`),
      sql`, `,
    );
    priceStoreScope = sql`AND (
      store_id IN (${visibleStoreList})
      OR (
        store_id IS NULL
        AND EXISTS (
          SELECT 1 FROM read_model.run_item_stores_v ris
          WHERE ris.run_id = price_history.run_id
            AND ris.sku_id = price_history.sku_id
            AND ris.store_id IN (${visibleStoreList})
        )
      )
    )`;
  }
  const rows = (await tx.execute(
    sql`SELECT DISTINCT ON (sku_id) sku_id::text AS sku_id,
               unit_price::text AS unit_price,
               observed_at
        FROM inventory.price_history
        WHERE org_id = ${orgId}
          AND superseded_at IS NULL
          ${priceStoreScope}
          AND sku_id IN ${inUuids(skuIds)}
          -- 2026-07-27: exclude THIS run's own observations.
          --
          -- Every ItemPurchased inserts a price_history row
          -- (runProjection.ts). Without this filter the "last observed
          -- price" for an item the purchaser just saved IS the price they
          -- just saved — so the reference chases the entry and can never
          -- disagree with it.
          --
          -- Two things broke on that, both proven empirically:
          --   * the finish sheet's "N priced the same as last
          --     time" counted EVERY purchased row, including one
          --     retyped from 70,000 to 105,000, because by then
          --     both sides of the comparison read 105,000;
          --   * observed_at became today for every saved row, so
          --     isStalePrice was permanently false and the
          --     stale-reference warning could never fire once.
          --
          -- That counter is the whole safety argument for hiding
          -- the price editor behind a tap (Q7b), so it has to
          -- compare against the PREVIOUS trip, not this one.
          --
          -- IS DISTINCT FROM, not <>: run_id is nullable, and
          -- NULL <> $1 evaluates to NULL, which would silently
          -- drop every historical observation that predates run
          -- tracking.
          AND run_id IS DISTINCT FROM ${runId}
        ORDER BY sku_id, observed_at DESC`,
  )) as unknown as Array<{
    sku_id: string;
    unit_price: string;
    observed_at: Date | string;
  }>;
  for (const r of rows) {
    lastPriceBySku[r.sku_id] = r.unit_price;
    lastPriceObservedAtBySku[r.sku_id] =
      r.observed_at instanceof Date ? r.observed_at.toISOString() : String(r.observed_at);
  }
  return { lastPriceBySku, lastPriceObservedAtBySku };
}

/** Members' display names, in one IN query (C.2: the claim banner). */
export async function memberDisplayNames(
  tx: DB,
  memberIds: readonly string[],
): Promise<Map<string, string>> {
  if (memberIds.length === 0) return new Map();
  const rows = await tx
    .select({
      memberId: s.members.id,
      displayName: s.users.displayName,
    })
    .from(s.members)
    .innerJoin(s.users, eq(s.users.id, s.members.userId))
    .where(inArray(s.members.id, [...memberIds]));
  return new Map(rows.map((r) => [r.memberId, r.displayName]));
}

/**
 * M3.44 (2026-05-22): a run's active expenses, oldest first. Only the
 * non-removed ones — the `removed_at IS NULL` filter is partial-indexed
 * (rev_active_idx) so this is a cheap lookup. Admin reports pull the full
 * table (including removed rows) via a separate query.
 */
export async function activeRunExpenses(tx: DB, runId: string) {
  return tx.query.runExpensesV.findMany({
    where: (e, { eq: eq2, and: and2, isNull }) => and2(eq2(e.runId, runId), isNull(e.removedAt)),
    orderBy: (e, { asc }) => asc(e.addedAt),
  });
}

/** Each (product, store) the orders of these sessions ask a quantity of (BUY-6). */
export async function demandStorePairs(
  tx: DB,
  sessionIds: readonly string[],
): Promise<Array<{ skuId: string; storeId: string }>> {
  if (sessionIds.length === 0) return [];
  return tx
    .selectDistinct({
      skuId: s.orderItemsV.skuId,
      storeId: s.orderSessionsV.storeId,
    })
    .from(s.orderItemsV)
    .innerJoin(s.orderSessionsV, eq(s.orderSessionsV.id, s.orderItemsV.sessionId))
    .where(and(inArray(s.orderItemsV.sessionId, [...sessionIds]), sql`${s.orderItemsV.qty} > 0`));
}
