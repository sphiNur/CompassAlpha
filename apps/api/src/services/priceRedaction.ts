import type { DB } from '@compass/db';
import { getActorStoreIdsForPermission } from './storeScope';

/**
 * Members without `prices.view` see no money (2026-10-30 decision on
 * HIS-4 / ORD-12 / BUY-10). Store staff read runs to confirm deliveries
 * and their own batches to order; neither needs a price, and the
 * endpoints used to hand them every unit price, run total and last paid
 * price in the organisation.
 */

/**
 * Scalar fields that carry an amount of money, wherever they sit in an
 * answer. Review ORD-33 (2026-11): money-fields.test.ts fails when an
 * order, approval or price answer gains a field nobody classified, so a
 * new money field lands here (and is redacted) rather than slipping past.
 */
export const MONEY_FIELDS = [
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
  // D6 (2026-10-31): estimates and catalog price hints are money too.
  'estimatedCash',
  'estimatedTransfer',
  'estimatedUnitPrice',
  'defaultPrice',
  'lastSeenPrice',
  'defaultUnitPrice',
  'lineTotal',
  // Review ADM2-01 (2026-11-12): the RunFinished / RunRefinalized totals,
  // which the admin event feed returned as stored.
  'totalActual',
  'totalCash',
  'totalTransfer',
  // Review ORD-33 (2026-11): catalog.skuPriceStats' figures. That answer
  // is emptied whole for a reader without prices; named here so they are
  // money wherever else they appear.
  'lastPrice',
  'avg7d',
  'avg30d',
] as const;
export type MoneyField = (typeof MONEY_FIELDS)[number];
const PRICE_KEYS: ReadonlySet<string> = new Set(MONEY_FIELDS);

/** Maps from an id to a price (or when it was paid): emptied. */
export const PRICE_MAP_FIELDS = [
  'lastPriceBySku',
  'lastPriceObservedAtBySku',
  'lastPurchasePriceBySku',
] as const;
const PRICE_MAPS: ReadonlySet<string> = new Set(PRICE_MAP_FIELDS);

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

/**
 * Review ORD-33 (2026-11): the one way an answer's money is hidden from a
 * reader. `value` belongs to `storeIds`; unless prices.view is effective
 * for the reader in every one of them (`pricesVisibleFor` over
 * `priceStoreIds`), each money field is nulled and each price map emptied
 * (`withoutPrices`). Quantities, counts and statuses stay. It replaces
 * the order router's per-field checks and the run reads' hand-written
 * pair; new endpoints that return money pass their answer through here.
 */
export function redactMoneyFor<T>(
  priceStores: readonly string[] | null,
  storeIds: Iterable<string>,
  value: T,
): T {
  return pricesVisibleFor(priceStores, storeIds) ? value : withoutPrices(value);
}

/**
 * Whether prices.view is in the session's flat permission union, i.e.
 * held in SOME store. Review ORD-33 (2026-11): a first, coarse check only
 * (held nowhere: no money to work out at all). Whether a store's money
 * may be shown is `pricesVisibleFor(priceStoreIds(…), storeIds)` below.
 */
export function canSeePrices(session: { permissions: ReadonlySet<string> } | null | undefined): boolean {
  return !!session?.permissions.has('prices.view');
}

/**
 * D6 (2026-10-31): the stores where `prices.view` is effective for this
 * member, honouring store-scoped roles and allow / deny overrides; null
 * when it holds everywhere. `canSeePrices` above reads the flat session
 * union, which made a manager at store B see money at store A where they
 * are only staff (RE-SHL-3).
 */
export function priceStoreIds(
  db: DB,
  session: { memberId: string; permissions: ReadonlySet<string> },
): Promise<string[] | null> {
  return getActorStoreIdsForPermission(db, session.memberId, 'prices.view', session.permissions);
}

/**
 * Money that belongs to `storeIds` may be shown only when prices.view is
 * effective in every one of them. A total over two stores would otherwise
 * give away the store the reader may not price. Money tied to no store
 * yet (a run with nothing allocated) follows `pricesVisibleAnywhere`.
 */
export function pricesVisibleFor(
  priceStores: readonly string[] | null,
  storeIds: Iterable<string>,
): boolean {
  if (priceStores === null) return true;
  const allowed = new Set(priceStores);
  let any = false;
  for (const id of storeIds) {
    if (!allowed.has(id)) return false;
    any = true;
  }
  return any || allowed.size > 0;
}

/** Org-wide figures (dish prices, price stats): prices.view somewhere. */
export function pricesVisibleAnywhere(priceStores: readonly string[] | null): boolean {
  return priceStores === null || priceStores.length > 0;
}
