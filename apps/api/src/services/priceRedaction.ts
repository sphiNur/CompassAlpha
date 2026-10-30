/**
 * Members without `prices.view` see no money (2026-10-30 decision on
 * HIS-4 / ORD-12 / BUY-10). Store staff read runs to confirm deliveries
 * and their own batches to order; neither needs a price, and the
 * endpoints used to hand them every unit price, run total and last paid
 * price in the organisation.
 */

/** Scalar fields that carry an amount of money. */
const PRICE_KEYS = new Set([
  'unitPrice',
  'plannedTotal',
  'actualTotal',
  'actualCashTotal',
  'actualTransferTotal',
  'total',
  'itemsTotal',
  'expensesTotal',
  'cash',
  'transfer',
  'estimatedTotal',
]);

/** Maps from an id to a price (or when it was paid): emptied. */
const PRICE_MAPS = new Set(['lastPriceBySku', 'lastPriceObservedAtBySku']);

/**
 * A copy of `value` with every money field set to null and price maps
 * emptied. Quantities, counts and statuses stay, so screens that only
 * need "what and how much" keep working.
 */
export function withoutPrices<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => withoutPrices(v)) as T;
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (PRICE_MAPS.has(key) && v !== null && typeof v === 'object') out[key] = {};
    else if (PRICE_KEYS.has(key) && (typeof v === 'string' || typeof v === 'number')) out[key] = null;
    else out[key] = withoutPrices(v);
  }
  return out as T;
}

export function canSeePrices(session: { permissions: ReadonlySet<string> } | null | undefined): boolean {
  return !!session?.permissions.has('prices.view');
}
