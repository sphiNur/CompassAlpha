/**
 * DX-ORD-6 (2026-11-01): catalog.skus returns products in the order the
 * admin set (sortIndex, then code). Rows used to come back in whatever
 * order Postgres found them, so the Order page listed them by accident.
 * Review ADM2-17 (2026-11-12): the admin's own category and product lists
 * break ties the same way (slug or code, then id).
 * PG-gated like the other router tests.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { getDb, schema as s } from '@compass/db';
import { appRouter } from '../trpc/router';
import type { RequestContext } from '../trpc/context';
import { SHOULD_RUN } from './helpers/pg';
import { freshTgId } from './helpers/telegram';
import { testContext } from './helpers/ctx';
import { cleanUpAfterAll, noteOrg, noteUser } from './helpers/cleanup';

cleanUpAfterAll();

let ctx: RequestContext | null = null;
let adminCtx: RequestContext | null = null;
let codes: string[] = [];
let uncodedIds: string[] = [];
let slugs: string[] = [];

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const slug = `skuorder-${Date.now()}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug, name: 'SKU order test', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  noteOrg(org!.id);
  const [user] = await db
    .insert(s.users)
    .values({ displayName: 'Reader', tgUserId: freshTgId() })
    .returning();
  noteUser(user!.id);
  const [member] = await db
    .insert(s.members)
    .values({ orgId: org!.id, userId: user!.id })
    .returning();
  const suffix = slug.slice(-6);
  // Inserted out of order on purpose; two share a sortIndex (code breaks the tie).
  const rows = [
    { code: `C-${suffix}`, sortIndex: 20 },
    { code: `A-${suffix}`, sortIndex: 30 },
    { code: `Z-${suffix}`, sortIndex: 0 },
    { code: `B-${suffix}`, sortIndex: 20 },
  ];
  await db.insert(s.skus).values(
    rows.map((r) => ({
      orgId: org!.id,
      code: r.code,
      names: { en: r.code },
      unit: 'kg',
      step: '1',
      sortIndex: r.sortIndex,
    })),
  );
  codes = [`Z-${suffix}`, `B-${suffix}`, `C-${suffix}`, `A-${suffix}`];
  // ADM2-17: two products without a code at the same sortIndex as B and C.
  const uncoded = await db
    .insert(s.skus)
    .values(
      ['first', 'second'].map((name) => ({
        orgId: org!.id,
        names: { en: `${name}-${suffix}` },
        unit: 'kg',
        step: '1',
        sortIndex: 20,
      })),
    )
    .returning({ id: s.skus.id });
  uncodedIds = uncoded.map((r) => r.id).sort();
  // Inserted out of order; two share a sortIndex (the slug breaks the tie).
  await db.insert(s.categories).values(
    [
      { slug: `c-${suffix}`, sortIndex: 5 },
      { slug: `a-${suffix}`, sortIndex: 5 },
      { slug: `b-${suffix}`, sortIndex: 1 },
    ].map((c) => ({ orgId: org!.id, slug: c.slug, names: { en: c.slug }, sortIndex: c.sortIndex })),
  );
  slugs = [`b-${suffix}`, `a-${suffix}`, `c-${suffix}`];
  adminCtx = testContext({
    userId: user!.id,
    memberId: member!.id,
    orgId: org!.id,
    orgTimezone: 'UTC',
    permissions: new Set(['users.manage']),
    roleSlugs: new Set(['manager']),
  });
  ctx = testContext({
    userId: user!.id,
    memberId: member!.id,
    orgId: org!.id,
    orgTimezone: 'UTC',
    permissions: new Set(),
    roleSlugs: new Set(['staff']),
  });
});

describe.skipIf(!SHOULD_RUN)('catalog.skus order (PG-gated)', () => {
  test('sorted by sortIndex, then code', async () => {
    if (!ctx) throw new Error('fixture missing');
    const caller = appRouter.createCaller(ctx);
    const list = await caller.catalog.skus({ includeArchived: true });
    expect(list.filter((r) => r.code !== null).map((r) => r.code)).toEqual(codes);
  });
});

describe.skipIf(!SHOULD_RUN)('admin catalog lists order (ADM2-17, PG-gated)', () => {
  test('admin.categoryList: by sortIndex, then slug', async () => {
    if (!adminCtx) throw new Error('fixture missing');
    const list = await appRouter.createCaller(adminCtx).admin.categoryList();
    expect(list.map((c) => c.slug)).toEqual(slugs);
  });

  test('admin.skuList: by sortIndex, then code, then id', async () => {
    if (!adminCtx) throw new Error('fixture missing');
    const list = await appRouter.createCaller(adminCtx).admin.skuList({ includeArchived: true });
    // Products without a code come after the coded ones of their sortIndex.
    expect(list.map((r) => r.code ?? r.id)).toEqual([
      ...codes.slice(0, 3),
      ...uncodedIds,
      ...codes.slice(3),
    ]);
  });
});
