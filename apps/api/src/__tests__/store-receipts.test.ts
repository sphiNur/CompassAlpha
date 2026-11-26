/**
 * Owner 2026-11-23: run.storeReceipts, a store's receiving record for
 * whoever receives there. Store staff (no prices.view) see what their
 * store received in the last 14 days, the verdicts and whether the
 * purchase was revised after they confirmed, and never any money or
 * another store's lines.
 *
 * PG-gated.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb, schema as s } from '@compass/db';
import type { ActorCtx } from '@compass/domain/run';
import { loadSession } from '../trpc/context';
import { SHOULD_RUN } from './helpers/pg';
import { callerFor } from './helpers/ctx';
import { seedMember, seedOwnedOrg, seedRoles } from './helpers/fixtures';
import { runStream } from './helpers/streams';
import { errorOf } from './helpers/errors';
import { cleanUpAfterAll } from './helpers/cleanup';

cleanUpAfterAll();

type Caller = ReturnType<typeof callerFor>;

let fx: {
  orgId: string;
  storeA: string;
  storeB: string;
  apple: string;
  pear: string;
  runId: string;
  staffA: Caller;
  outsider: Caller;
};

describe.skipIf(!SHOULD_RUN)('run.storeReceipts (PG)', () => {
  beforeAll(async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    const { orgId, slug, session } = await seedOwnedOrg(db, 'Store Receipts');
    const actor: ActorCtx = {
      userId: session.userId,
      memberId: session.memberId,
      permissions: session.permissions,
    };
    const [storeA, storeB] = await db
      .insert(s.stores)
      .values([
        { orgId, name: 'A', code: `A-${slug.slice(-6)}` },
        { orgId, name: 'B', code: `B-${slug.slice(-6)}` },
      ])
      .returning();
    const [apple, pear] = await db
      .insert(s.skus)
      .values([
        { orgId, code: `APL-${slug.slice(-6)}`, names: { en: 'Apple' }, unit: 'kg', step: '0.5' },
        { orgId, code: `PER-${slug.slice(-6)}`, names: { en: 'Pear' }, unit: 'kg', step: '0.5' },
      ])
      .returning();
    if (!storeA || !storeB || !apple || !pear) throw new Error('fixture insert failed');

    // seedOwnedOrg creates the built-in roles; staff is one of them.
    const staffRole = await db.query.roles.findFirst({
      where: (r, { and, eq }) => and(eq(r.orgId, orgId), eq(r.slug, 'staff')),
      columns: { id: true },
    });
    const staffRoleId = staffRole?.id ?? (await seedRoles(db, orgId, ['staff'])).staff!;
    const member = async (name: string, storeId: string) => {
      const who = await seedMember(db, orgId, {
        name,
        stores: [storeId],
        roles: [{ roleId: staffRoleId, storeId }],
      });
      const loaded = await loadSession(db, who.userId, orgId, who.memberId);
      if (!loaded) throw new Error('session failed to load');
      return callerFor(loaded);
    };

    const runId = randomUUID();
    const run = runStream(orgId, runId);
    await run.exec({
      type: 'PlanRun',
      orgId,
      runDate: '2026-11-20',
      today: '2026-11-20',
      runIndex: 0,
      sessionIds: [randomUUID()],
      plannedItems: [
        { skuId: apple.id, qty: '4' },
        { skuId: pear.id, qty: '2' },
      ],
      actor,
    });
    await run.exec({ type: 'StartPurchase', actor });
    await run.exec({
      type: 'PurchaseItem',
      skuId: apple.id,
      supplierId: null,
      unitPrice: '12000',
      actualQty: '4',
      receiptPhotoUrl: null,
      storeSplits: [
        { storeId: storeA.id, qty: '2' },
        { storeId: storeB.id, qty: '2' },
      ],
      paymentMethod: 'cash',
      actor,
    });
    await run.exec({
      type: 'PurchaseItem',
      skuId: pear.id,
      supplierId: null,
      unitPrice: '9000',
      actualQty: '2',
      receiptPhotoUrl: null,
      storeSplits: [{ storeId: storeA.id, qty: '2' }],
      paymentMethod: 'cash',
      actor,
    });
    await run.exec({ type: 'StartDelivery', actor });
    for (const storeId of [storeA.id, storeB.id]) {
      await run.exec({ type: 'DeliverToStore', storeId, actor });
    }
    await run.exec({
      type: 'ConfirmStoreItem',
      storeId: storeA.id,
      skuId: apple.id,
      status: 'short',
      note: 'half a kilo missing',
      photoUrl: null,
      receivedQty: '1.5',
      actor,
    });
    await run.exec({
      type: 'ConfirmStoreItem',
      storeId: storeA.id,
      skuId: pear.id,
      status: 'ok',
      note: null,
      photoUrl: null,
      actor,
    });
    await run.exec({ type: 'ConfirmStore', storeId: storeA.id, actor });
    // Store B confirms too, so the run can finish; then the receipt of B's
    // line is taken back (below) to stand for a store that has not confirmed.
    await run.exec({
      type: 'ConfirmStoreItem',
      storeId: storeB.id,
      skuId: apple.id,
      status: 'ok',
      note: null,
      photoUrl: null,
      actor,
    });
    await run.exec({ type: 'ConfirmStore', storeId: storeB.id, actor });
    await run.exec({ type: 'FinishRun', actor });
    // A correction: the pears are revised for A after A confirmed them.
    await run.exec({ type: 'ReopenRun', reason: 'scale', actor });
    await run.exec({
      type: 'RevisePurchase',
      skuId: pear.id,
      supplierId: null,
      unitPrice: '9500',
      actualQty: '2.5',
      receiptPhotoUrl: null,
      storeSplits: [{ storeId: storeA.id, qty: '2.5' }],
      reason: 'the scale was off; price 9500',
      paymentMethod: 'cash',
      actor,
    });
    await run.exec({ type: 'RefinalizeRun', actor });
    await db.execute(sql`
      UPDATE read_model.run_item_stores_v SET confirmed_at = NULL
      WHERE run_id = ${runId} AND store_id = ${storeB.id}`);

    fx = {
      orgId,
      storeA: storeA.id,
      storeB: storeB.id,
      apple: apple.id,
      pear: pear.id,
      runId,
      staffA: await member('Receiver A', storeA.id),
      outsider: await member('Receiver B', storeB.id),
    };
  });

  test('a receiver without prices.view sees what the store received, and its verdicts', async () => {
    const receipts = await fx.staffA.run.storeReceipts({ storeId: fx.storeA });
    expect(receipts).toHaveLength(1);
    const [receipt] = receipts;
    expect(receipt!.runId).toBe(fx.runId);
    expect(receipt!.runDate).toBe('2026-11-20');
    // Who confirmed it: the organisation's owner did, in this fixture.
    expect(receipt!.confirmedBy).toBeTruthy();
    const apple = receipt!.lines.find((l) => l.skuId === fx.apple);
    expect(apple).toMatchObject({
      qty: '2.000',
      verdict: 'short',
      receivedQty: '1.500',
      note: 'half a kilo missing',
      revisedAt: null,
    });
    // The revision after A confirmed is marked; the quantity is the revised one.
    const pear = receipt!.lines.find((l) => l.skuId === fx.pear);
    expect(pear?.verdict).toBe('ok');
    expect(pear?.qty).toBe('2.500');
    expect(pear?.revisedAt).not.toBeNull();
  });

  test('no money, and not the revision reason, is in the answer', async () => {
    const text = JSON.stringify(await fx.staffA.run.storeReceipts({ storeId: fx.storeA }));
    for (const word of ['12000', '9000', '9500', 'price', 'cash', 'Price', 'total', 'scale']) {
      expect(text).not.toContain(word);
    }
  });

  test("another store's receiver is refused, and a store that has not confirmed has no receipts", async () => {
    const refused = await errorOf(() => fx.outsider.run.storeReceipts({ storeId: fx.storeA }));
    expect(refused?.message).toBe('auth.errors.missingPermission');
    expect(await fx.outsider.run.storeReceipts({ storeId: fx.storeB })).toEqual([]);
  });

  test('receipts confirmed more than 14 days ago are left out', async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    await db.execute(sql`
      UPDATE read_model.run_item_stores_v
      SET confirmed_at = now() - interval '15 days'
      WHERE run_id = ${fx.runId} AND store_id = ${fx.storeA} AND sku_id = ${fx.apple}`);
    const [receipt] = await fx.staffA.run.storeReceipts({ storeId: fx.storeA });
    expect(receipt?.lines.map((l) => l.skuId)).toEqual([fx.pear]);
  });
});
