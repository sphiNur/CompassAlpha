/**
 * Review COREAPI-18 (2026-11-09): the run-finished notification wrote its
 * amounts with toFixed(2), so every language read "1234567.50", unlike
 * the app's "1,234,567.50"; and for events from before itemsTotal and
 * expensesTotal it added the expenses in floats. The amounts are now
 * added in cents by the money rule and written as the app shows them.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/run-finished-notify.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb, schema as s, withOrgContext } from '@compass/db';
import { emptyRunState, type RunEvent, type RunExpense } from '@compass/domain/run';
import { dispatchRunEventNotifications } from '../services/notifyForEvent';

const SHOULD_RUN = !!process.env.DATABASE_URL && process.env.SKIP_PG_TESTS !== '1';

/** An expense line; only qty and price count here. */
function expense(qty: string, unitPrice: string): RunExpense {
  return {
    id: randomUUID(),
    label: 'Taxi',
    unitHint: null,
    qty,
    unitPrice,
    storeSplits: [],
    paymentMethod: 'cash',
    receiptPhotoUrl: null,
    reason: '',
    addedByMemberId: randomUUID(),
    addedAt: new Date(),
  };
}

/** The in-app notification the purchaser gets when someone else finishes the run. */
async function finishRun(
  locale: string,
  payload: { totalActual: string; itemsTotal?: string; expensesTotal?: string },
  expenses: RunExpense[] = [],
) {
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug: `finished-${suffix}`, name: 'Finished', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  const orgId = org!.id;
  const [user] = await db
    .insert(s.users)
    .values({ displayName: 'Purchaser', tgUserId: BigInt(`${suffix}2`.slice(-12)), locale })
    .returning();
  const [member] = await db
    .insert(s.members)
    .values({ orgId, userId: user!.id, status: 'active' })
    .returning();

  const runId = randomUUID();
  const state = { ...emptyRunState(runId), purchaserMemberId: member!.id, expenses };
  const event = {
    streamId: runId,
    seq: 9,
    occurredAt: new Date(),
    actorUserId: null,
    actorMemberId: null,
    type: 'RunFinished',
    payload,
  } as unknown as RunEvent;
  await withOrgContext(db, orgId, (tx) =>
    dispatchRunEventNotifications(tx, orgId, randomUUID(), state, [event]),
  );
  const [row] = await db
    .select({ body: s.notifications.body, payload: s.notifications.payload })
    .from(s.notifications)
    .where(
      and(
        eq(s.notifications.orgId, orgId),
        eq(s.notifications.template, 'run.finished'),
        eq(s.notifications.channel, 'inapp'),
      ),
    );
  return row;
}

describe.skipIf(!SHOULD_RUN)('run-finished notification amounts (PG-gated)', () => {
  test('the amounts read as the app shows them, in the recipient’s language', async () => {
    const row = await finishRun('ru', {
      totalActual: '1234567.5',
      itemsTotal: '1234567.5',
      expensesTotal: '12.3',
    });
    expect(row?.body).toBe(
      'Закупка завершена · товары 1,234,567.50 · расходы 12.30 · итого 1,234,579.80.',
    );
    // The payload keeps plain decimals for code that reads it.
    expect(row?.payload).toMatchObject({
      itemsTotal: '1234567.50',
      expensesTotal: '12.30',
      total: '1234579.80',
    });
  });

  test('a whole amount has no decimals', async () => {
    const row = await finishRun('zh', {
      totalActual: '1000',
      itemsTotal: '1000',
      expensesTotal: '0',
    });
    expect(row?.body).toBe('采购完成 · 商品 1,000 · 开销 0 · 合计 1,000。');
  });

  test('an old event’s expenses are added line by line in cents', async () => {
    // Before itemsTotal and expensesTotal, the expenses come from the run.
    // Each 0.005 × 1 line rounds to 0.01 on its own, as everywhere else;
    // adding the floats first made 0.01.
    const row = await finishRun('en', { totalActual: '100.00' }, [
      expense('0.005', '1.00'),
      expense('0.005', '1.00'),
    ]);
    expect(row?.body).toBe('Run complete · items 100 · expenses 0.02 · total 100.02.');
  });
});
