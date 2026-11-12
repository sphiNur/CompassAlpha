/**
 * Review RUNAPI-22 (2026-11-12): history search matched a product's
 * names and aliases as JSON text, so a word like "en", "ru" or "zh" (the
 * language keys) found every run. It now matches the names and aliases
 * themselves, in any language.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/history-search.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb, schema as s } from '@compass/db';
import { appRouter } from '../trpc/router';
import { SHOULD_RUN } from './helpers/pg';
import { callerFor } from './helpers/ctx';
import { seedRoles, seedMember, sessionOf } from './helpers/fixtures';
import { cleanUpAfterAll, noteOrg } from './helpers/cleanup';

cleanUpAfterAll();

const DAY = '2026-06-02';
let owner: ReturnType<typeof appRouter.createCaller> | null = null;

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({
      slug: `hsearch-${suffix}`,
      name: 'History search',
      localeDefault: 'en',
      timezone: 'UTC',
    })
    .returning();
  noteOrg(org!.id);
  const orgId = org!.id;
  const roleId = (await seedRoles(db, orgId, ['super_admin'])).super_admin!;
  const [store] = await db
    .insert(s.stores)
    .values({ orgId, name: 'Kitchen', code: `HS-${suffix.slice(-6)}` })
    .returning();
  const [sku] = await db
    .insert(s.skus)
    .values({
      orgId,
      code: `P-${suffix.slice(-8)}`,
      names: { en: 'Rice', ru: 'Рис' },
      aliases: { zh: ['大米'] },
      unit: 'kg',
      step: '1',
    })
    .returning();
  const runId = randomUUID();
  await db.insert(s.marketRunsV).values({ id: runId, orgId, runDate: DAY, status: 'finished' });
  await db.insert(s.runItemsV).values({
    runId,
    skuId: sku!.id,
    plannedQty: '1',
    purchasedQty: '1',
    unitPrice: '100',
    status: 'purchased',
  });
  await db.insert(s.runItemStoresV).values({ runId, skuId: sku!.id, storeId: store!.id, qty: '1' });
  const who = await seedMember(db, orgId, {
    name: 'History search',
    stores: [store!.id],
    roles: [{ roleId }],
  });
  owner = callerFor(await sessionOf(orgId, who));
});

describe.skipIf(!SHOULD_RUN)('history search (PG-gated)', () => {
  const found = async (search: string) =>
    (await owner!.run.history({ dateFrom: DAY, dateTo: DAY, search })).rows.length;

  test('a language key is not a match', async () => {
    for (const key of ['en', 'ru', 'zh'])
      expect({ key, rows: await found(key) }).toEqual({ key, rows: 0 });
  });

  test('a name or an alias in any language is', async () => {
    expect(await found('rice')).toBe(1);
    expect(await found('рис')).toBe(1);
    expect(await found('大米')).toBe(1);
  });
});
