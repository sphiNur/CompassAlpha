/**
 * DX-CAT-2 (2026-11-01): what an activity-feed event is about, in words.
 *
 * The feed showed the event name, "seq N", who and when — never which
 * product, store or order. This reads the few things a person needs to
 * recognise an event from the read models and the catalog: the order's
 * store and date, the run's date and number, and the product, store and
 * quantity the payload names. One query per kind, not per row.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { schema as s, type DB } from '@compass/db';

export interface RecentEventContext {
  /** The store the event is about: the order's, or the payload's storeId. */
  storeName: string | null;
  /** An order stream's order date (YYYY-MM-DD). */
  orderDate: string | null;
  /** A run stream's date and 0-based index ("#1" is index 0). */
  runDate: string | null;
  runIndex: number | null;
  /** The product a payload names (skuId), as its names per language. */
  skuNames: Record<string, string> | null;
  /** A payload quantity, as stored. */
  qty: string | null;
}

interface EventRow {
  id: string;
  streamId: string;
  streamType: string;
  payload: unknown;
}

function payloadString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const v = (payload as Record<string, unknown>)[key];
  return typeof v === 'string' && v !== '' ? v : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function recentEventContext(
  tx: DB,
  orgId: string,
  rows: ReadonlyArray<EventRow>,
): Promise<Map<string, RecentEventContext>> {
  const orderIds = [...new Set(rows.filter((r) => r.streamType === 'order').map((r) => r.streamId))];
  const runIds = [...new Set(rows.filter((r) => r.streamType === 'run').map((r) => r.streamId))];
  const skuIds = new Set<string>();
  const storeIds = new Set<string>();
  for (const r of rows) {
    const sku = payloadString(r.payload, 'skuId');
    if (sku && UUID.test(sku)) skuIds.add(sku);
    const store = payloadString(r.payload, 'storeId');
    if (store && UUID.test(store)) storeIds.add(store);
  }

  const orders = orderIds.length
    ? await tx
        .select({
          id: s.orderSessionsV.id,
          storeId: s.orderSessionsV.storeId,
          orderDate: s.orderSessionsV.orderDate,
        })
        .from(s.orderSessionsV)
        .where(and(eq(s.orderSessionsV.orgId, orgId), inArray(s.orderSessionsV.id, orderIds)))
    : [];
  for (const o of orders) storeIds.add(o.storeId);
  const runs = runIds.length
    ? await tx
        .select({
          id: s.marketRunsV.id,
          runDate: s.marketRunsV.runDate,
          runIndex: s.marketRunsV.runIndex,
        })
        .from(s.marketRunsV)
        .where(and(eq(s.marketRunsV.orgId, orgId), inArray(s.marketRunsV.id, runIds)))
    : [];
  const stores = storeIds.size
    ? await tx
        .select({ id: s.stores.id, name: s.stores.name })
        .from(s.stores)
        .where(and(eq(s.stores.orgId, orgId), inArray(s.stores.id, [...storeIds])))
    : [];
  const skus = skuIds.size
    ? await tx
        .select({ id: s.skus.id, names: s.skus.names })
        .from(s.skus)
        .where(and(eq(s.skus.orgId, orgId), inArray(s.skus.id, [...skuIds])))
    : [];

  const orderById = new Map(orders.map((o) => [o.id, o]));
  const runById = new Map(runs.map((r) => [r.id, r]));
  const storeName = new Map(stores.map((st) => [st.id, st.name]));
  const skuNames = new Map(skus.map((k) => [k.id, k.names as Record<string, string>]));

  const out = new Map<string, RecentEventContext>();
  for (const r of rows) {
    const order = r.streamType === 'order' ? orderById.get(r.streamId) : undefined;
    const run = r.streamType === 'run' ? runById.get(r.streamId) : undefined;
    const payloadStore = payloadString(r.payload, 'storeId');
    const sku = payloadString(r.payload, 'skuId');
    out.set(r.id, {
      storeName:
        (payloadStore ? storeName.get(payloadStore) : undefined) ??
        (order ? storeName.get(order.storeId) : undefined) ??
        null,
      orderDate: order?.orderDate ?? null,
      runDate: run?.runDate ?? null,
      runIndex: run ? run.runIndex : null,
      skuNames: sku ? (skuNames.get(sku) ?? null) : null,
      qty: payloadString(r.payload, 'qty'),
    });
  }
  return out;
}
