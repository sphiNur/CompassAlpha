/**
 * Review ORD-26 (2026-11): each product's last price paid is read from
 * its newest instant (price_hist_sku_idx) instead of a window over its
 * whole purchase history, and an empty list of products asks for none
 * (it used to mean every product). The prices must not change: a
 * purchase split between stores at one instant is weighed by quantity, a
 * superseded row is not a price, every product of the organisation is
 * priced when none is named, and nothing of another organisation is.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/price-last-paid.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { getDb, schema as s, withOrgContext, type DB } from '@compass/db';
import { appRouter } from '../trpc/router';
import { loadSkuLastPrices, loadSkuPriceStats } from '../services/priceStats';
import { SHOULD_RUN } from './helpers/pg';
import { callerFor } from './helpers/ctx';
import { seedMember, seedRoles, sessionOf } from './helpers/fixtures';
import { cleanUpAfterAll, noteOrg } from './helpers/cleanup';

cleanUpAfterAll();

type Caller = ReturnType<typeof appRouter.createCaller>;
let fix: {
  orgId: string;
  apple: string;
  beef: string;
  salt: string;
  /** A product of another organisation, with a price. */
  foreign: string;
  owner: Caller;
} | null = null;

const DAY1 = new Date('2026-10-01T06:00:00Z');
const DAY2 = new Date('2026-10-02T06:00:00Z');

describe('an empty list of products asks for none (no database)', () => {
  test('nothing is read', async () => {
    const untouchable = new Proxy({} as DB, {
      get() {
        throw new Error('the database was read for an empty list');
      },
    });
    expect((await loadSkuPriceStats(untouchable, 'org', [])).size).toBe(0);
    expect((await loadSkuLastPrices(untouchable, 'org', [])).size).toBe(0);
  });
});

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const org = async (name: string) => {
    const [row] = await db
      .insert(s.organizations)
      .values({ slug: `${name}-${suffix}`, name, localeDefault: 'en', timezone: 'UTC' })
      .returning();
    noteOrg(row!.id);
    return row!.id;
  };
  const orgId = await org('last-paid');
  const otherOrgId = await org('last-paid-other');
  const store = async (owner: string, name: string) =>
    (
      await db
        .insert(s.stores)
        .values({ orgId: owner, name, code: `${name}-${suffix.slice(-6)}` })
        .returning()
    )[0]!.id;
  const storeA = await store(orgId, 'A');
  const storeB = await store(orgId, 'B');
  const sku = async (owner: string, code: string) =>
    (
      await db
        .insert(s.skus)
        .values({
          orgId: owner,
          code: `${code}-${suffix.slice(-8)}`,
          names: { en: code },
          unit: 'kg',
          step: '1',
        })
        .returning()
    )[0]!.id;
  const apple = await sku(orgId, 'apple');
  const beef = await sku(orgId, 'beef');
  const salt = await sku(orgId, 'salt');
  const foreign = await sku(otherOrgId, 'foreign');

  const price = (
    owner: string,
    skuId: string,
    unitPrice: string,
    qty: string,
    observedAt: Date,
    extra: { storeId?: string; supersededAt?: Date } = {},
  ) => ({ orgId: owner, skuId, unitPrice, qty, observedAt, ...extra });
  await db.insert(s.priceHistory).values([
    price(orgId, apple, '1000', '1', DAY1),
    // The last trip split apple between the stores at different prices:
    // (1200 × 1 + 1500 × 3) / 4 = 1425.
    price(orgId, apple, '1200', '1', DAY2, { storeId: storeA }),
    price(orgId, apple, '1500', '3', DAY2, { storeId: storeB }),
    price(orgId, beef, '9000', '2', DAY1),
    // Corrected afterwards: never the price.
    price(orgId, beef, '90000', '2', DAY2, { supersededAt: DAY2 }),
    price(otherOrgId, foreign, '777', '1', DAY2),
  ]);

  const roleIds = await seedRoles(db, orgId, ['super_admin']);
  const owner = await seedMember(db, orgId, {
    name: 'Last paid owner',
    roles: [{ roleId: roleIds.super_admin! }],
  });
  fix = {
    orgId,
    apple,
    beef,
    salt,
    foreign,
    owner: callerFor(await sessionOf(orgId, owner)),
  };
});

describe.skipIf(!SHOULD_RUN)('the last price paid (PG-gated)', () => {
  const inOrg = <T>(fn: (tx: DB) => Promise<T>) => withOrgContext(getDb(), fix!.orgId, fn);

  test("the newest instant's rows, weighed by quantity; superseded rows skipped", async () => {
    const { orgId, apple, beef, salt } = fix!;
    // apple twice: a repeated id is asked for once.
    const last = await inOrg((tx) => loadSkuLastPrices(tx, orgId, [apple, beef, salt, apple]));
    expect([...last.keys()].sort()).toEqual([apple, beef].sort());
    expect(last.get(apple)).toEqual({ skuId: apple, lastPrice: '1425.00', lastObservedAt: DAY2 });
    expect(last.get(beef)).toEqual({ skuId: beef, lastPrice: '9000.00', lastObservedAt: DAY1 });
  });

  test("every product of the organisation when none is named, and none of another's", async () => {
    const { orgId, apple, beef, foreign } = fix!;
    const all = await inOrg((tx) => loadSkuPriceStats(tx, orgId));
    expect(all.has(foreign)).toBe(false);
    expect(all.get(apple)?.lastPrice).toBe('1425.00');
    expect(all.get(beef)?.lastPrice).toBe('9000.00');
    const named = await inOrg((tx) => loadSkuPriceStats(tx, orgId, [apple, beef]));
    expect(named.get(apple)?.lastPrice).toBe('1425.00');
    expect(named.get(beef)?.lastObservedAt).toEqual(DAY1);
  });

  test('catalog.skuPriceStats: an empty list gets an empty answer, no list every product', async () => {
    const { owner, apple, beef } = fix!;
    expect(await owner.catalog.skuPriceStats({ skuIds: [] })).toEqual([]);
    const every = await owner.catalog.skuPriceStats();
    expect(every.map((r) => r.skuId).sort()).toEqual([apple, beef].sort());
  });
});
