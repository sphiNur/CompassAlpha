/**
 * Input checks (2026-10-30 operation atlas, low findings): impossible
 * dates answered 500 (BUY-15, HIS-11), blank names were stored (ADM-11),
 * expense templates took a 0 quantity and over-long prices (CAT-11), "%"
 * in history search matched everything (HIS-14), and an upload's key took
 * its extension from the client's file name (AUTH-24).
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/input-checks.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { getDb, schema as s } from '@compass/db';
import { appRouter } from '../trpc/router';
import { loadSession } from '../trpc/context';
import { randomUUID } from 'node:crypto';
import { pickExtension } from '../trpc/routers/upload';
import { SHOULD_RUN } from './helpers/pg';
import { freshTgId } from './helpers/telegram';
import { callerFor } from './helpers/ctx';
import { seedRoles } from './helpers/fixtures';
import { codeOf, errorOf } from './helpers/errors';

type Caller = ReturnType<typeof appRouter.createCaller>;
let owner: Caller | null = null;
let runId = '';

/** The catalog key a refused input came back with (first zod issue). */
async function keyOf(fn: () => Promise<unknown>): Promise<string | null> {
  const err = await errorOf(fn);
  if (!err) return null;
  try {
    return (JSON.parse(err.message) as Array<{ message: string }>)[0]?.message ?? err.message;
  } catch {
    return err.message;
  }
}

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug: `checks-${suffix}`, name: 'Input checks', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  const roleId = (await seedRoles(db, org!.id, ['super_admin'])).super_admin!;
  const [u] = await db
    .insert(s.users)
    .values({ displayName: 'Checks', tgUserId: freshTgId() })
    .returning();
  const [m] = await db.insert(s.members).values({ orgId: org!.id, userId: u!.id, status: 'active' }).returning();
  await db
    .insert(s.memberRoleBindings)
    .values({ memberId: m!.id, roleId: roleId, scopeType: 'global', scopeId: null });
  runId = randomUUID();
  await db.insert(s.marketRunsV).values({ id: runId, orgId: org!.id, runDate: '2026-06-01', status: 'finished' });
  const session = await loadSession(db, u!.id, org!.id, m!.id);
  if (!session) throw new Error('session failed to load');
  owner = callerFor(session);
});

describe.skipIf(!SHOULD_RUN)('input checks (PG-gated)', () => {
  test('impossible dates are refused as input, not a 500', async () => {
    expect(await codeOf(() => owner!.run.changeDate({ runId, runDate: '2026-02-31' }))).toBe('BAD_REQUEST');
    expect(await codeOf(() => owner!.admin.purgeByDate({ date: '2026-13-01', dryRun: true }))).toBe('BAD_REQUEST');
  });

  test('B11 / BUY-15: year 0000 is a 400, not a 500 from Postgres', async () => {
    expect(
      await codeOf(() => owner!.report.totals({ startDate: '0000-01-01', endDate: '2026-01-01' })),
    ).toBe('BAD_REQUEST');
    expect(await codeOf(() => owner!.run.previewCreatable({ date: '0000-01-01' }))).toBe('BAD_REQUEST');
    expect(await codeOf(() => owner!.run.changeDate({ runId, runDate: '0000-01-01' }))).toBe('BAD_REQUEST');
    expect(await keyOf(() => owner!.run.changeDate({ runId, runDate: '0000-01-01' }))).toBe(
      'common.errors.invalidDate',
    );
  });

  test('admin form refusals carry catalog keys, not English sentences', async () => {
    const finance = { currency: 'UZS', pricesIncludeTax: false };
    expect(await keyOf(() => owner!.admin.orgFinanceUpdate({ ...finance, taxRatePct: '-1' }))).toBe(
      'admin.errors.taxRateFormat',
    );
    expect(await keyOf(() => owner!.admin.orgFinanceUpdate({ ...finance, taxRatePct: '7.125' }))).toBe(
      'admin.errors.taxRateFormat',
    );
    // ADM1-14: the range comes from the same rule the finance sheet asks.
    expect(
      await keyOf(() => owner!.admin.orgFinanceUpdate({ ...finance, taxRatePct: '50.01' })),
    ).toBe('admin.errors.taxRateOutOfRange');
    expect(await keyOf(() => owner!.admin.storeCreate({ name: 'Mars', timezone: 'Mars/Base' }))).toBe(
      'admin.errors.timeZoneUnknown',
    );
    expect(
      await keyOf(() => owner!.admin.categoryCreate({ slug: 'veg', names: { en: 'Veg' }, sortIndex: 1.5 })),
    ).toBe('admin.errors.sortIndexInteger');
    expect(
      await keyOf(() => owner!.admin.categoryCreate({ slug: 'veg', names: { en: 'Veg' }, sortIndex: 1e12 })),
    ).toBe('admin.errors.sortIndexInteger');
    const order = { storeId: randomUUID(), skuId: randomUUID() };
    expect(await keyOf(() => owner!.order.adjustItem({ ...order, qty: '1000000' }))).toBe(
      'order.errors.qtyTooLarge',
    );
    expect(await keyOf(() => owner!.order.adjustItem({ ...order, qty: '0.0004' }))).toBe(
      'common.errors.invalidDecimal',
    );
  });

  test('a blank store name is refused; an empty code means none', async () => {
    expect(await codeOf(() => owner!.admin.storeCreate({ name: '   ' }))).toBe('BAD_REQUEST');
    expect(await codeOf(() => owner!.admin.storeCreate({ name: '  Kitchen  ', code: '' }))).toBeNull();
  });

  test('expense templates need a positive quantity and a price that fits', async () => {
    const base = { label: 'Porter', defaultUnitPrice: '20000' };
    expect(await codeOf(() => owner!.admin.expenseTemplateCreate({ ...base, defaultQty: '0' }))).toBe('BAD_REQUEST');
    expect(
      await codeOf(() => owner!.admin.expenseTemplateCreate({ ...base, defaultUnitPrice: '999999999999999' })),
    ).toBe('BAD_REQUEST');
    expect(await codeOf(() => owner!.admin.expenseTemplateCreate({ ...base, defaultQty: '1' }))).toBeNull();
  });

  test('"%" in history search is a literal, not a wildcard', async () => {
    const all = await owner!.run.history({ dateFrom: '2026-06-01', dateTo: '2026-06-01' });
    expect(all.rows.length).toBe(1);
    const percent = await owner!.run.history({ dateFrom: '2026-06-01', dateTo: '2026-06-01', search: '%' });
    expect(percent.rows.length).toBe(0);
  });

  test('an upload key takes its extension from the signed content type only', () => {
    expect(pickExtension('image/png')).toBe('png');
    expect(pickExtension('image/jpeg')).toBe('jpg');
  });
});
