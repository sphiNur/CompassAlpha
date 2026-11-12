/**
 * Review RUNAPI-28 (2026-11-12): run.setSkuPreferredSupplier changes the
 * organisation's preferred supplier for a product, and told no one, so
 * every other screen showing it kept the old one. It now pushes a catalog
 * change for products, after the write commits.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/preferred-supplier-push.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { getDb, schema as s } from '@compass/db';
import { hub } from '../realtime/hub';
import { appRouter } from '../trpc/router';
import { SHOULD_RUN } from './helpers/pg';
import { callerFor } from './helpers/ctx';
import { seedRoles, seedMember, sessionOf } from './helpers/fixtures';
import { cleanUpAfterAll, noteOrg } from './helpers/cleanup';

cleanUpAfterAll();

let fix: {
  orgId: string;
  skuId: string;
  supplierId: string;
  buyer: ReturnType<typeof appRouter.createCaller>;
} | null = null;

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug: `pref-${suffix}`, name: 'Preferred', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  noteOrg(org!.id);
  const orgId = org!.id;
  const roleId = (await seedRoles(db, orgId, ['super_admin'])).super_admin!;
  const [store] = await db
    .insert(s.stores)
    .values({ orgId, name: 'Store', code: `PF-${suffix.slice(-6)}` })
    .returning();
  const [sku] = await db
    .insert(s.skus)
    .values({ orgId, code: `PF-${suffix.slice(-8)}`, names: { en: 'Rice' }, unit: 'kg', step: '1' })
    .returning();
  const [supplier] = await db.insert(s.suppliers).values({ orgId, name: 'Stall 7' }).returning();
  const who = await seedMember(db, orgId, {
    name: 'Preferred buyer',
    stores: [store!.id],
    roles: [{ roleId }],
  });
  fix = {
    orgId,
    skuId: sku!.id,
    supplierId: supplier!.id,
    buyer: callerFor(await sessionOf(orgId, who)),
  };
});

describe.skipIf(!SHOULD_RUN)('preferred supplier (PG-gated)', () => {
  test('setting it pushes a product change to the organisation', async () => {
    const { orgId, skuId, supplierId, buyer } = fix!;
    const received: unknown[] = [];
    const unsubscribe = hub.subscribe(orgId, (data) => received.push(JSON.parse(data)));
    try {
      await buyer.run.setSkuPreferredSupplier({ skuId, supplierId });
      await buyer.run.setSkuPreferredSupplier({ skuId, supplierId: null });
    } finally {
      unsubscribe();
    }
    const push = { type: 'catalog.changed', orgId, entity: 'sku' };
    expect(received).toEqual([push, push]);
  });
});
