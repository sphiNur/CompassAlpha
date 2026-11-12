/**
 * Review ADM2-36 (2026-11-12): the catalog, expense template, store and
 * purge procedures find the row they act on with one helper (orgRowOr404)
 * instead of ten hand-written lookups. Each still refuses an id of
 * another organisation, or no row at all, with its own NOT_FOUND message,
 * and finds and edits its own organisation's rows.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/admin-org-rows.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb, schema as s } from '@compass/db';
import type { CatalogKey } from '@compass/i18n';
import { appRouter } from '../trpc/router';
import { SHOULD_RUN } from './helpers/pg';
import { callerFor } from './helpers/ctx';
import { seedRoles, seedMember, sessionOf } from './helpers/fixtures';
import { cleanUpAfterAll, noteOrg } from './helpers/cleanup';

cleanUpAfterAll();

let fix: {
  db: ReturnType<typeof getDb>;
  owner: ReturnType<typeof appRouter.createCaller>;
  ownCategory: string;
  otherCategory: string;
} | null = null;

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [own, other] = await db
    .insert(s.organizations)
    .values([
      { slug: `orgrows-a-${suffix}`, name: 'Org rows A', localeDefault: 'en', timezone: 'UTC' },
      { slug: `orgrows-b-${suffix}`, name: 'Org rows B', localeDefault: 'en', timezone: 'UTC' },
    ])
    .returning();
  noteOrg(own!.id);
  noteOrg(other!.id);
  const roleIds = await seedRoles(db, own!.id, ['super_admin']);
  const owner = await seedMember(db, own!.id, {
    name: 'Org rows owner',
    stores: [],
    roles: [{ roleId: roleIds.super_admin!, storeId: null }],
  });
  const [ownCategory, otherCategory] = await db
    .insert(s.categories)
    .values([
      { orgId: own!.id, slug: `own-${suffix}`, names: { en: 'Own' }, sortIndex: 3 },
      { orgId: other!.id, slug: `other-${suffix}`, names: { en: 'Other' }, sortIndex: 3 },
    ])
    .returning();
  fix = {
    db,
    owner: callerFor(await sessionOf(own!.id, owner)),
    ownCategory: ownCategory!.id,
    otherCategory: otherCategory!.id,
  };
});

describe.skipIf(!SHOULD_RUN)('the row an admin edit acts on (ADM2-36, PG-gated)', () => {
  test('another organisation’s row, or none, is NOT_FOUND with the table’s message', async () => {
    const { owner, otherCategory } = fix!;
    const none = randomUUID();
    const calls: Array<[() => Promise<unknown>, CatalogKey]> = [
      [
        () => owner.admin.categoryUpdate({ categoryId: otherCategory, sortIndex: 1 }),
        'admin.errors.categoryNotFound',
      ],
      [
        () => owner.admin.categoryDelete({ categoryId: otherCategory }),
        'admin.errors.categoryNotFound',
      ],
      [
        () =>
          owner.admin.skuCreate({ categoryId: otherCategory, names: { en: 'Leak' }, unit: 'kg' }),
        'admin.errors.categoryNotFound',
      ],
      [() => owner.admin.skuUpdate({ skuId: none, sortIndex: 1 }), 'admin.errors.skuNotFound'],
      [() => owner.admin.skuDelete({ skuId: none }), 'admin.errors.skuNotFound'],
      [
        () => owner.admin.supplierUpdate({ supplierId: none, name: 'Smoke Supplier' }),
        'admin.errors.supplierNotFound',
      ],
      [() => owner.admin.supplierDelete({ supplierId: none }), 'admin.errors.supplierNotFound'],
      [
        () => owner.admin.expenseTemplateUpdate({ templateId: none, label: 'Porter' }),
        'admin.errors.expenseTemplateNotFound',
      ],
      [
        () => owner.admin.expenseTemplateDelete({ templateId: none }),
        'admin.errors.expenseTemplateNotFound',
      ],
      [
        () => owner.admin.storeUpdate({ storeId: none, name: 'Smoke Store' }),
        'admin.errors.storeNotFound',
      ],
      [() => owner.admin.storeDelete({ storeId: none }), 'admin.errors.storeNotFound'],
      [
        () => owner.admin.purgeSession({ sessionId: none, dryRun: true }),
        'admin.errors.sessionNotFound',
      ],
      [() => owner.admin.purgeRun({ runId: none, dryRun: true }), 'admin.errors.runNotFound'],
    ];
    for (const [call, message] of calls) {
      await expect(call()).rejects.toMatchObject({ code: 'NOT_FOUND', message });
    }
  });

  test('its own row is found and edited', async () => {
    const { db, owner, ownCategory } = fix!;
    await owner.admin.categoryUpdate({ categoryId: ownCategory, sortIndex: -5 });
    const [row] = await db
      .select({ sortIndex: s.categories.sortIndex })
      .from(s.categories)
      .where(eq(s.categories.id, ownCategory));
    expect(row?.sortIndex).toBe(-5);
  });
});
