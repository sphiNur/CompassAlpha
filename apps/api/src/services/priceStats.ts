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
import { and, eq, gte, inArray } from 'drizzle-orm';
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
export function estimateLines(
  lines: Array<{ skuId: string; qty: number }>,
  stats: Map<string, SkuPriceStat>,
): { total: number; known: number; unknown: number } {
  let total = 0;
  let known = 0;
  let unknown = 0;
  for (const line of lines) {
    if (!(line.qty > 0)) continue;
    const stat = stats.get(line.skuId);
    const price = stat?.avg7d ?? stat?.lastPrice ?? null;
    if (price != null) {
      total += price * line.qty;
      known += 1;
    } else {
      unknown += 1;
    }
  }
  return { total, known, unknown };
}
