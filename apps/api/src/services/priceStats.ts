/**
 * Shared price-history aggregation.
 *
 * Extracted 2026-07-30 from `catalog.skuPriceStats`, which was the only
 * caller until `order.pendingList` needed the same 7-day mean to put an
 * estimated value on each approval card. Duplicating the 30-line
 * accumulator in a second router is how the two figures would eventually
 * disagree, so both now read from here.
 *
 * Why aggregate in JS rather than SQL: the window logic (last / 7d mean /
 * 30d mean, all from one scan) stays legible, one round-trip covers every
 * SKU asked for, and the optional id filter composes without a second
 * query shape. Volume is bounded by 30 days of observations for the SKUs
 * on screen.
 */
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import type { DB } from '@compass/db';
import { schema as s } from '@compass/db';

export interface SkuPriceStat {
  skuId: string;
  lastPrice: number | null;
  lastObservedAt: Date | null;
  avg7d: number | null;
  avg30d: number | null;
  observations30d: number;
}

/**
 * Aggregate price observations for `skuIds` (or every SKU in the org when
 * omitted / empty). Returns a Map keyed by skuId; SKUs with no
 * observations in the last 30 days are simply absent.
 *
 * `now` is injectable so callers under test can pin the window instead of
 * racing the wall clock.
 */
export async function loadSkuPriceStats(
  db: DB,
  orgId: string,
  skuIds?: string[],
  now: Date = new Date(),
): Promise<Map<string, SkuPriceStat>> {
  const since30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const since7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const obs = await db
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
        // inArray (not `= ANY(...)`): Drizzle's tagged template binds a JS
        // array as ONE parameter and PG then rejects it with "op ANY/ALL
        // (array) requires array on right side". See M3.23-fix.
        skuIds && skuIds.length > 0 ? inArray(s.priceHistory.skuId, skuIds) : undefined,
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

  const out = new Map<string, SkuPriceStat>();
  for (const [skuId, a] of bySku) {
    out.set(skuId, {
      skuId,
      lastPrice: a.last ? a.last.price : null,
      lastObservedAt: a.last ? a.last.at : null,
      avg7d: a.n7 > 0 ? a.sum7 / a.n7 : null,
      avg30d: a.n30 > 0 ? a.sum30 / a.n30 : null,
      observations30d: a.n30,
    });
  }

  // 2026-10-11: the last price is what a budget is made of (see
  // estimateLines), so it must not stop existing after 30 days, and it
  // must be the price of the last PURCHASE rather than of one row: a
  // purchase split between stores at different prices writes a row per
  // store at the same instant, and those are weighed by quantity. A
  // corrected price is a later row, so it replaces the mistake here even
  // though the mistake stays in the averages above.
  const latest = (await db.execute(sql`
    SELECT
      t.sku_id::text AS sku_id,
      t.observed_at  AS observed_at,
      COALESCE(
        SUM(t.unit_price * t.qty) / NULLIF(SUM(t.qty), 0),
        AVG(t.unit_price)
      )::text AS unit_price
    FROM (
      SELECT
        ph.sku_id, ph.unit_price, ph.qty, ph.observed_at,
        MAX(ph.observed_at) OVER (PARTITION BY ph.sku_id) AS newest
      FROM inventory.price_history ph
      WHERE ph.org_id = ${orgId}
        ${
          skuIds && skuIds.length > 0
            ? sql`AND ph.sku_id IN (${sql.join(
                skuIds.map((id) => sql`${id}::uuid`),
                sql`, `,
              )})`
            : sql``
        }
    ) t
    WHERE t.observed_at = t.newest
    GROUP BY t.sku_id, t.observed_at
  `)) as unknown as Array<{ sku_id: string; observed_at: Date | string; unit_price: string }>;
  for (const r of latest) {
    const price = Number(r.unit_price);
    if (!Number.isFinite(price)) continue;
    const at = r.observed_at instanceof Date ? r.observed_at : new Date(r.observed_at);
    const stat = out.get(r.sku_id);
    if (stat) {
      stat.lastPrice = price;
      stat.lastObservedAt = at;
    } else {
      out.set(r.sku_id, {
        skuId: r.sku_id,
        lastPrice: price,
        lastObservedAt: at,
        avg7d: null,
        avg30d: null,
        observations30d: 0,
      });
    }
  }
  return out;
}

/**
 * The single "what do we expect this to cost" rule, shared by every
 * surface that shows a `~` estimate (order review sheet, approval card,
 * approval detail). Prefers the 7-day mean so one freak-sale day doesn't
 * skew tomorrow's expectation, falling back to the last observed price.
 *
 * Returns the total plus how many lines it could and could NOT price, so
 * callers can be honest about the estimate's coverage instead of
 * presenting a partial sum as complete.
 */
export type PaymentMethod = 'cash' | 'transfer';

/** How each product was paid for the last time it was bought. */
export interface SkuUsualPayment {
  /** `${storeId}:${skuId}` → that store's own last purchase of it. */
  byStoreSku: Map<string, PaymentMethod>;
  /** skuId → the last purchase of it for any store. */
  bySku: Map<string, PaymentMethod>;
}

/**
 * Nothing says how an order WILL be paid: the purchaser picks cash or
 * transfer per line at the market. What can be said before that is how
 * each product was paid the last time, which is what a budget needs.
 */
export async function loadSkuUsualPayment(
  db: DB,
  orgId: string,
  skuIds: string[],
): Promise<SkuUsualPayment> {
  const out: SkuUsualPayment = { byStoreSku: new Map(), bySku: new Map() };
  if (skuIds.length === 0) return out;
  // Newest first within each (store, product); the first row of a product
  // overall is therefore its newest for any store.
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (ris.store_id, ri.sku_id)
      ris.store_id::text AS store_id,
      ri.sku_id::text    AS sku_id,
      COALESCE(ris.payment_method, ri.payment_method, 'cash') AS payment_method,
      mr.run_date::text  AS run_date,
      mr.run_index       AS run_index
    FROM read_model.market_runs_v mr
    INNER JOIN read_model.run_items_v ri
      ON ri.run_id = mr.id
    INNER JOIN read_model.run_item_stores_v ris
      ON ris.run_id = ri.run_id AND ris.sku_id = ri.sku_id
    WHERE mr.org_id = ${orgId}
      AND ri.status = 'purchased'
      AND mr.status IN ('purchasing', 'delivering', 'finished', 'amending')
      AND ri.sku_id IN (${sql.join(
        skuIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
    ORDER BY ris.store_id, ri.sku_id, mr.run_date DESC, mr.run_index DESC
  `)) as unknown as Array<{
    store_id: string;
    sku_id: string;
    payment_method: string;
    run_date: string;
    run_index: number;
  }>;
  const newest = new Map<string, { runDate: string; runIndex: number }>();
  for (const r of rows) {
    const method: PaymentMethod = r.payment_method === 'transfer' ? 'transfer' : 'cash';
    out.byStoreSku.set(`${r.store_id}:${r.sku_id}`, method);
    const seen = newest.get(r.sku_id);
    if (
      !seen ||
      r.run_date > seen.runDate ||
      (r.run_date === seen.runDate && r.run_index > seen.runIndex)
    ) {
      newest.set(r.sku_id, { runDate: r.run_date, runIndex: r.run_index });
      out.bySku.set(r.sku_id, method);
    }
  }
  return out;
}

/**
 * `cash` and `transfer` split `total` by how each product was last paid:
 * the ordering store's own last purchase, else anyone's, else cash, which
 * is what a purchase is recorded as unless the purchaser says otherwise.
 */
export function estimateLines(
  lines: Array<{ skuId: string; qty: number }>,
  stats: Map<string, SkuPriceStat>,
  paid?: { usual: SkuUsualPayment; storeId: string },
): { total: number; known: number; unknown: number; cash: number; transfer: number } {
  let total = 0;
  let known = 0;
  let unknown = 0;
  let cash = 0;
  let transfer = 0;
  for (const line of lines) {
    if (!(line.qty > 0)) continue;
    const stat = stats.get(line.skuId);
    // What it cost the last time it was bought. Market prices move by
    // the day, so an average of the week is a price nobody paid, and it
    // keeps a mistyped price for a week after the mistake is corrected.
    // It is also the price the purchasing plan already goes by.
    const price = stat?.lastPrice ?? null;
    if (price != null) {
      total += price * line.qty;
      known += 1;
      const method =
        paid?.usual.byStoreSku.get(`${paid.storeId}:${line.skuId}`) ??
        paid?.usual.bySku.get(line.skuId) ??
        'cash';
      if (method === 'transfer') transfer += price * line.qty;
      else cash += price * line.qty;
    } else {
      unknown += 1;
    }
  }
  return { total, known, unknown, cash, transfer };
}
