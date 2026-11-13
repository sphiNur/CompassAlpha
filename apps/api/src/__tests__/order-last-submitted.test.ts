/**
 * UX-02 (2026-11-13): order.lastSubmitted, the lines the Order page's
 * "Repeat last order" copies into an empty draft.
 *
 * - Nothing sent (no order, or only a draft): no lines.
 * - The latest sent order, summed per product, with each product's unit;
 *   archived products are left out, and an order of only archived ones is
 *   passed over for the one before it.
 * - Whose: the caller's own; a store's approver reads anyone's there
 *   (ORD-05's rule). Another store, or one the caller is not assigned
 *   to, is refused.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/order-last-submitted.test.ts
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { getDb, schema as s } from '@compass/db';
import { appRouter } from '../trpc/router';
import { SHOULD_RUN } from './helpers/pg';
import { callerFor } from './helpers/ctx';
import { seedRoles, seedMember, sessionOf } from './helpers/fixtures';
import { cleanUpAfterAll, noteOrg } from './helpers/cleanup';
import { codeOf } from './helpers/errors';
import { middayZone } from './helpers/zone';

cleanUpAfterAll();

/** The calls send no date, so the server takes the org's today; where it is
 *  midday that does not change while the file runs (review TEST1-09). */
const TZ = middayZone(new Date());

type Caller = ReturnType<typeof appRouter.createCaller>;
interface Fixture {
  storeId: string;
  otherStoreId: string;
  rice: string;
  oil: string;
  salt: string;
  staff: Caller;
  colleague: Caller;
  manager: Caller;
}
let fix: Fixture | null = null;

const NOTHING = { sessionId: null, orderDate: null, submittedAt: null, lines: [] };

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug: `lastsub-${suffix}`, name: 'Last order', localeDefault: 'en', timezone: TZ })
    .returning();
  noteOrg(org!.id);
  const orgId = org!.id;
  const roleIds = await seedRoles(db, orgId, ['manager', 'staff']);
  const [store, otherStore] = await db
    .insert(s.stores)
    .values([
      { orgId, name: 'Store', code: `L-${suffix.slice(-6)}` },
      { orgId, name: 'Other store', code: `LO-${suffix.slice(-6)}` },
    ])
    .returning();
  const [rice, oil, salt] = await db
    .insert(s.skus)
    .values([
      {
        orgId,
        code: `LR-${suffix.slice(-8)}`,
        names: { en: 'Rice' },
        unit: 'kg',
        step: '0.5',
        sortIndex: 2,
      },
      {
        orgId,
        code: `LL-${suffix.slice(-8)}`,
        names: { en: 'Oil' },
        unit: 'L',
        step: '1',
        sortIndex: 1,
      },
      {
        orgId,
        code: `LS-${suffix.slice(-8)}`,
        names: { en: 'Salt' },
        unit: 'pack',
        step: '1',
        sortIndex: 3,
      },
    ])
    .returning();
  let n = 0;
  const member = async (slug: string) => {
    n += 1;
    const who = await seedMember(db, orgId, {
      name: `Last order ${n}`,
      stores: [store!.id],
      roles: [{ roleId: roleIds[slug]!, storeId: store!.id }],
    });
    return callerFor(await sessionOf(orgId, who));
  };
  fix = {
    storeId: store!.id,
    otherStoreId: otherStore!.id,
    rice: rice!.id,
    oil: oil!.id,
    salt: salt!.id,
    staff: await member('staff'),
    colleague: await member('staff'),
    manager: await member('manager'),
  };
});

describe.skipIf(!SHOULD_RUN)('order.lastSubmitted (PG-gated)', () => {
  test('nothing sent yet, or only a draft: no lines', async () => {
    const { staff, storeId, rice } = fix!;
    expect(await staff.order.lastSubmitted({ storeId })).toEqual(NOTHING);
    await staff.order.adjustItem({ storeId, skuId: rice, qty: '1' });
    expect(await staff.order.lastSubmitted({ storeId })).toEqual(NOTHING);
  });

  test('the latest sent order, in catalog order with units; archived products left out', async () => {
    const { staff, colleague, manager, storeId, rice, oil, salt } = fix!;
    // The open draft from the test above becomes this batch.
    await staff.order.adjustItem({ storeId, skuId: rice, qty: '2.5' });
    const first = await staff.order.adjustItem({ storeId, skuId: oil, qty: '3' });
    await staff.order.submit({ sessionId: first.sessionId });

    const last = await staff.order.lastSubmitted({ storeId });
    expect(last.sessionId).toBe(first.sessionId);
    expect(last.submittedAt).not.toBeNull();
    expect(last.lines).toEqual([
      { skuId: oil, qty: '3', unit: 'L' },
      { skuId: rice, qty: '2.5', unit: 'kg' },
    ]);

    // ORD-05: a colleague with no order of their own gets nothing; the
    // store's approver reads the store's last order.
    expect(await colleague.order.lastSubmitted({ storeId })).toEqual(NOTHING);
    expect((await manager.order.lastSubmitted({ storeId })).sessionId).toBe(first.sessionId);

    // A second batch of salt only, then salt is archived: that batch has
    // nothing left to copy and the one before it is offered, without salt.
    const second = await staff.order.adjustItem({ storeId, skuId: salt, qty: '4' });
    await staff.order.submit({ sessionId: second.sessionId });
    expect((await staff.order.lastSubmitted({ storeId })).lines).toEqual([
      { skuId: salt, qty: '4', unit: 'pack' },
    ]);
    const db = getDb(undefined, { system: 'maintenance' });
    await db.update(s.skus).set({ isArchived: true }).where(eq(s.skus.id, salt));
    const fallback = await staff.order.lastSubmitted({ storeId });
    expect(fallback.sessionId).toBe(first.sessionId);
    expect(fallback.lines.map((line) => line.skuId)).toEqual([oil, rice]);

    // Approved (and later) orders count as sent.
    await manager.order.claim({ sessionId: first.sessionId });
    await manager.order.approve({ sessionId: first.sessionId });
    expect((await staff.order.lastSubmitted({ storeId })).sessionId).toBe(first.sessionId);
  });

  test('another store, or one in no organisation of the caller, is refused', async () => {
    const { staff, otherStoreId } = fix!;
    expect(await codeOf(() => staff.order.lastSubmitted({ storeId: otherStoreId }))).toBe(
      'FORBIDDEN',
    );
    expect(await codeOf(() => staff.order.lastSubmitted({ storeId: randomUUID() }))).toBe(
      'FORBIDDEN',
    );
  });
});
