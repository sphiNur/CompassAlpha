/**
 * DX-ORD-6 (2026-11-01): catalog.skus returns products in the order the
 * admin set (sortIndex, then code). Rows used to come back in whatever
 * order Postgres found them, so the Order page listed them by accident.
 * PG-gated like the other router tests.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { getDb, schema as s } from '@compass/db';
import { appRouter } from '../trpc/router';
import type { RequestContext } from '../trpc/context';
import { SHOULD_RUN } from './helpers/pg';
import { freshTgId } from './helpers/telegram';
import { testContext } from './helpers/ctx';

let ctx: RequestContext | null = null;
let codes: string[] = [];

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const slug = `skuorder-${Date.now()}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug, name: 'SKU order test', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  const [user] = await db
    .insert(s.users)
    .values({ displayName: 'Reader', tgUserId: freshTgId() })
    .returning();
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
    expect(list.map((r) => r.code)).toEqual(codes);
  });
});
