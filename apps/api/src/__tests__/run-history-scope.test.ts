/**
 * Store scope in the purchaser's runs and in run history: which stores'
 * demand a purchaser may plan and change, and whose purchases and prices
 * the history shows. With admin-scope.test.ts and store-scope-reads.test.ts,
 * split out of store-scoped-admin.test.ts (review TEST2-04, 2026-11).
 *
 * Skipped when DATABASE_URL is unset or SKIP_PG_TESTS=1.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb, schema as s, withOrgContext } from '@compass/db';
import { appRouter } from '../trpc/router';
import { getActorStoreIdsForPermission } from '../services/storeScope';
import { SHOULD_RUN } from './helpers/pg';
import { testContext, callerFor } from './helpers/ctx';
import { errorOf } from './helpers/errors';
import { scopeOrgSuite } from './helpers/scopeOrg';

const {
  fixture,
  makeStore,
  makeUser,
  makeMember,
  bindRole,
  sessionFor,
} = scopeOrgSuite('Run History Scope Tests');

// ---------- M3.2: per-store purchaser does not see foreign demand ----------
//
// `run.previewCreatable` used to be org-wide regardless of the actor's
// store binding — a purchaser bound to Store A would see Store B's
// approved demand and could include it in their run plan. M3.2 splits
// the perm into `run.create` (store-tier, filtered) and
// `run.create.org` (org-tier, unfiltered).

describe('M3.2 store-tier purchaser is filtered to bound stores', () => {
  test.skipIf(!SHOULD_RUN)(
    'purchaser bound to Store A only does not see Store B sessions in previewCreatable',
    async () => {
      const fx = fixture();
      const db = getDb(undefined, { system: 'maintenance' });
      const storeA = await makeStore(`Run-A-${Math.random()}`);
      const storeB = await makeStore(`Run-B-${Math.random()}`);

      // The built-in purchaser, bound to Store A. It holds run.create,
      // not run.create.org — the whole point is to verify the store-tier
      // path filters correctly.
      const buyer = await makeUser('A-Buyer');
      const buyerMember = await makeMember(buyer.id);
      await bindRole(buyerMember, fx.purchaserRoleId, {
        type: 'store',
        storeId: storeA.id,
      });

      const session = await sessionFor(buyerMember, buyer.id);
      expect(session.permissions.has('run.create.org')).toBe(false);
      const caller = callerFor(session);

      // An approved order in each store, on a day no other test uses: the
      // purchaser's preview has Store A's and not Store B's.
      const date = '2098-12-27';
      const sessionAId = randomUUID();
      const sessionBId = randomUUID();
      await db.insert(s.orderSessionsV).values([
        {
          id: sessionAId,
          orgId: fx.orgId,
          storeId: storeA.id,
          initiatedByMemberId: buyerMember,
          orderDate: date,
          status: 'approved',
        },
        {
          id: sessionBId,
          orgId: fx.orgId,
          storeId: storeB.id,
          initiatedByMemberId: fx.superAdminMemberId,
          orderDate: date,
          status: 'approved',
        },
      ]);
      const preview = await caller.run.previewCreatable({ date });
      expect(preview.sessions.map((row) => row.id)).toEqual([sessionAId]);
      expect(preview.perStoreDemand.some((d) => d.storeId === storeB.id)).toBe(false);
    },
  );

  test.skipIf(!SHOULD_RUN)(
    'purchaser cannot run.create with a sessionId from a foreign store',
    async () => {
      const fx = fixture();
      const db = getDb(undefined, { system: 'maintenance' });
      const storeA = await makeStore(`RunC-A-${Math.random()}`);
      const storeB = await makeStore(`RunC-B-${Math.random()}`);
      const buyer = await makeUser('A-Buyer2');
      const buyerMember = await makeMember(buyer.id);
      await bindRole(buyerMember, fx.purchaserRoleId, {
        type: 'store',
        storeId: storeA.id,
      });

      // Forge a "Store B approved session" by hand-inserting a row
      // into read_model.order_sessions_v. This bypasses the normal
      // approve flow but is fine for testing the run.create gate —
      // we just need a row whose storeId is in B and status is
      // 'approved' on today's date. The id matches stream_id by
      // schema convention but for this test we just need a fresh
      // uuid that the gate will see.
      const todayIso = new Date().toISOString().slice(0, 10);
      const foreignSessionId = randomUUID();
      const [foreignSession] = await db
        .insert(s.orderSessionsV)
        .values({
          id: foreignSessionId,
          orgId: fx.orgId,
          storeId: storeB.id,
          initiatedByMemberId: fx.superAdminMemberId,
          orderDate: todayIso,
          status: 'approved',
        })
        .returning();

      const ctx = testContext(await sessionFor(buyerMember, buyer.id));
      const caller = appRouter.createCaller(ctx);

      // Same precise check as the sales test: must throw the
      // store gate, NOT some downstream domain error.
      await expect(
        caller.run.create({ date: todayIso, sessionIds: [foreignSession!.id] }),
      ).rejects.toThrow('notAssignedToStore');
    },
  );

  test.skipIf(!SHOULD_RUN)(
    'store-scoped run.create.org cannot combine with unrelated store membership',
    async () => {
      const fx = fixture();
      const db = getDb(undefined, { system: 'maintenance' });
      const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
      const storeA = await makeStore(`Run provenance A ${suffix}`);
      const storeB = await makeStore(`Run provenance B ${suffix}`);
      const [scopedRole] = await db
        .insert(s.roles)
        .values({
          orgId: fx.orgId,
          slug: `scoped-run-org-${suffix}`,
          name: 'Scoped run org regression role',
          rank: 45,
          isBuiltIn: false,
        })
        .returning();
      await db.insert(s.rolePermissions).values([
        { roleId: scopedRole!.id, permissionKey: 'run.create' },
        { roleId: scopedRole!.id, permissionKey: 'run.create.org' },
      ]);

      const buyer = await makeUser(`Run provenance buyer ${suffix}`);
      const buyerMember = await makeMember(buyer.id);
      await bindRole(buyerMember, scopedRole!.id, { type: 'store', storeId: storeA.id });
      // Membership in B makes B appear in the actor's generic store set, but
      // the relevant run.create permission is effective only in A.
      await bindRole(buyerMember, fx.staffRoleId, { type: 'store', storeId: storeB.id });
      const date = '2098-12-29';
      const sessionAId = randomUUID();
      const sessionBId = randomUUID();
      await db.insert(s.orderSessionsV).values([
        {
          id: sessionAId,
          orgId: fx.orgId,
          storeId: storeA.id,
          initiatedByMemberId: buyerMember,
          orderDate: date,
          status: 'approved',
        },
        {
          id: sessionBId,
          orgId: fx.orgId,
          storeId: storeB.id,
          initiatedByMemberId: fx.superAdminMemberId,
          orderDate: date,
          status: 'approved',
        },
      ]);

      const session = await sessionFor(buyerMember, buyer.id);
      expect(session.permissions.has('run.create.org')).toBe(true);
      const caller = callerFor(session);
      const preview = await caller.run.previewCreatable({ date });
      expect(preview.sessions.map((row) => row.id)).toEqual([sessionAId]);

      await expect(caller.run.create({ date, sessionIds: [sessionBId] })).rejects.toThrow(
        'notAssignedToStore',
      );
    },
  );

  test.skipIf(!SHOULD_RUN)(
    'whole-run mutations require the command permission in every involved store',
    async () => {
      const fx = fixture();
      const db = getDb(undefined, { system: 'maintenance' });
      const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
      const storeA = await makeStore(`Run mutation A ${suffix}`);
      const storeB = await makeStore(`Run mutation B ${suffix}`);
      const [purchaserRole] = await db
        .insert(s.roles)
        .values({
          orgId: fx.orgId,
          slug: `run-mutation-${suffix}`,
          name: 'Run mutation regression role',
          rank: 45,
          isBuiltIn: false,
        })
        .returning();
      await db.insert(s.rolePermissions).values({
        roleId: purchaserRole!.id,
        permissionKey: 'run.purchase',
      });
      const buyer = await makeUser(`Run mutation buyer ${suffix}`);
      const buyerMember = await makeMember(buyer.id);
      await bindRole(buyerMember, purchaserRole!.id, { type: 'store', storeId: storeA.id });
      await bindRole(buyerMember, fx.staffRoleId, { type: 'store', storeId: storeB.id });

      const runId = randomUUID();
      const sessionBId = randomUUID();
      const runDate = '2098-12-30';
      await db.insert(s.marketRunsV).values({
        id: runId,
        orgId: fx.orgId,
        runDate,
        runIndex: 0,
        // Keep the synthetic read row terminal so it cannot collide with the
        // one-live-run partial index. The event stream below is deliberately
        // planned because that is the command state under test.
        status: 'finished',
        sessionIdsJson: [sessionBId],
      });
      await db.insert(s.orderSessionsV).values({
        id: sessionBId,
        orgId: fx.orgId,
        storeId: storeB.id,
        initiatedByMemberId: fx.superAdminMemberId,
        orderDate: runDate,
        status: 'archived',
        runId,
      });
      await db.insert(s.events).values({
        orgId: fx.orgId,
        streamType: 'run',
        streamId: runId,
        seq: 1,
        type: 'RunPlanned',
        payload: {
          orgId: fx.orgId,
          runDate,
          runIndex: 0,
          sessionIds: [sessionBId],
          plannedItems: [],
          purchaserMemberId: buyerMember,
        },
        actorId: buyer.id,
      });

      const caller = callerFor(await sessionFor(buyerMember, buyer.id));
      expect((await errorOf(() => caller.run.startPurchase({ runId })))?.message).toContain(
        'notVisible',
      );
      const started = await db
        .select({ id: s.events.id })
        .from(s.events)
        .where(and(eq(s.events.streamId, runId), eq(s.events.type, 'PurchaseStarted')));
      expect(started).toHaveLength(0);
    },
  );

  test.skipIf(!SHOULD_RUN)(
    'ejectSession resolves run.eject_session in the target session store',
    async () => {
      const fx = fixture();
      const db = getDb(undefined, { system: 'maintenance' });
      const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
      const storeA = await makeStore(`Run eject A ${suffix}`);
      const storeB = await makeStore(`Run eject B ${suffix}`);
      const [ejectRole] = await db
        .insert(s.roles)
        .values({
          orgId: fx.orgId,
          slug: `run-eject-${suffix}`,
          name: 'Run eject regression role',
          rank: 45,
          isBuiltIn: false,
        })
        .returning();
      await db.insert(s.rolePermissions).values({
        roleId: ejectRole!.id,
        permissionKey: 'run.eject_session',
      });
      const actorUser = await makeUser(`Run eject actor ${suffix}`);
      const actorMember = await makeMember(actorUser.id);
      await bindRole(actorMember, ejectRole!.id, { type: 'store', storeId: storeA.id });
      await bindRole(actorMember, fx.staffRoleId, { type: 'store', storeId: storeB.id });

      const runId = randomUUID();
      const sessionBId = randomUUID();
      const runDate = '2098-12-31';
      await db.insert(s.marketRunsV).values({
        id: runId,
        orgId: fx.orgId,
        runDate,
        runIndex: 0,
        status: 'finished',
        sessionIdsJson: [sessionBId],
      });
      await db.insert(s.orderSessionsV).values({
        id: sessionBId,
        orgId: fx.orgId,
        storeId: storeB.id,
        initiatedByMemberId: fx.superAdminMemberId,
        orderDate: runDate,
        status: 'archived',
        runId,
      });

      const session = await sessionFor(actorMember, actorUser.id);
      expect(session.permissions.has('run.eject_session')).toBe(true);
      const caller = callerFor(session);
      await expect(
        caller.run.ejectSession({ runId, sessionId: sessionBId, reason: 'scope regression' }),
      ).rejects.toThrow('missingPermission');
    },
  );
});

describe('purchase history permission scope', () => {
  test.skipIf(!SHOULD_RUN)(
    'paginates and totals only stores where prices.view is effective',
    async () => {
      const fx = fixture();
      const db = getDb(undefined, { system: 'maintenance' });
      const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
      const storeA = await makeStore(`History-A-${suffix}`);
      const storeB = await makeStore(`History-B-${suffix}`);

      const managerUser = await makeUser(`History manager ${suffix}`);
      const managerMember = await makeMember(managerUser.id);
      await bindRole(managerMember, fx.managerRoleId, { type: 'store', storeId: storeA.id });
      await bindRole(managerMember, fx.staffRoleId, { type: 'store', storeId: storeB.id });
      const [scopedAmendRole] = await db
        .insert(s.roles)
        .values({
          orgId: fx.orgId,
          slug: `scoped-amend-${suffix}`,
          name: 'Scoped amend regression role',
          rank: 55,
          isBuiltIn: false,
        })
        .returning();
      await db.insert(s.rolePermissions).values([
        { roleId: scopedAmendRole!.id, permissionKey: 'run.amend' },
        { roleId: scopedAmendRole!.id, permissionKey: 'run.create' },
      ]);
      await bindRole(managerMember, scopedAmendRole!.id, {
        type: 'store',
        storeId: storeA.id,
      });
      const managerSession = await sessionFor(managerMember, managerUser.id);
      expect(managerSession.permissions.has('run.amend')).toBe(true);
      const visibleStores = await withOrgContext(db, fx.orgId, (tx) =>
        getActorStoreIdsForPermission(tx, managerMember, 'prices.view', managerSession.permissions),
      );
      expect(visibleStores).toEqual([storeA.id]);
      const catalogCaller = callerFor(managerSession);
      const priceStores = await catalogCaller.catalog.stores({ permission: 'prices.view' });
      expect(priceStores.map((store) => store.id)).toEqual([storeA.id]);
      const assignedStores = await catalogCaller.catalog.stores();
      expect(new Set(assignedStores.map((store) => store.id))).toEqual(
        new Set([storeA.id, storeB.id]),
      );

      const [skuA] = await db
        .insert(s.skus)
        .values({
          orgId: fx.orgId,
          code: `H-A-${suffix}`,
          names: { en: `Visible apple ${suffix}` },
          aliases: {},
          description: {},
          unit: 'kg',
          step: '1',
        })
        .returning();
      const [skuB] = await db
        .insert(s.skus)
        .values({
          orgId: fx.orgId,
          code: `H-B-${suffix}`,
          names: { en: `Foreign secret ${suffix}` },
          aliases: {},
          description: {},
          unit: 'kg',
          step: '1',
        })
        .returning();
      const [skuC] = await db
        .insert(s.skus)
        .values({
          orgId: fx.orgId,
          code: `H-C-${suffix}`,
          names: { en: `Visible only pear ${suffix}` },
          aliases: {},
          description: {},
          unit: 'kg',
          step: '1',
        })
        .returning();
      const [hiddenSupplier] = await db
        .insert(s.suppliers)
        .values({
          orgId: fx.orgId,
          name: `Hidden supplier ${suffix}`,
        })
        .returning();
      const [visibleSupplier] = await db
        .insert(s.suppliers)
        .values({
          orgId: fx.orgId,
          name: `Visible supplier ${suffix}`,
        })
        .returning();
      const runId = randomUUID();
      const sessionAId = randomUUID();
      const sessionBId = randomUUID();
      const runDate = '2042-08-05';
      await db.insert(s.marketRunsV).values({
        id: runId,
        orgId: fx.orgId,
        runDate,
        runIndex: 0,
        status: 'finished',
        actualTotal: '780',
        actualCashTotal: '550',
        actualTransferTotal: '230',
        sessionIdsJson: [sessionAId, sessionBId],
        finishedAt: new Date('2042-08-05T12:00:00Z'),
      });
      await db.insert(s.orderSessionsV).values([
        {
          id: sessionAId,
          orgId: fx.orgId,
          storeId: storeA.id,
          orderDate: runDate,
          status: 'archived',
          initiatedByMemberId: managerMember,
          runId,
        },
        {
          id: sessionBId,
          orgId: fx.orgId,
          storeId: storeB.id,
          orderDate: runDate,
          status: 'archived',
          initiatedByMemberId: fx.superAdminMemberId,
          runId,
        },
      ]);
      await db.insert(s.orderItemsV).values([
        {
          sessionId: sessionAId,
          skuId: skuA!.id,
          contributorMemberId: managerMember,
          qty: '1',
        },
        {
          // Regression: Store A requested this SKU, but the actual purchase
          // was allocated only to hidden Store B. Demand visibility must not
          // expose the purchase's price/supplier/payment metadata.
          sessionId: sessionAId,
          skuId: skuB!.id,
          contributorMemberId: managerMember,
          qty: '1',
        },
        {
          sessionId: sessionAId,
          skuId: skuC!.id,
          contributorMemberId: managerMember,
          qty: '1',
        },
        {
          sessionId: sessionBId,
          skuId: skuA!.id,
          contributorMemberId: fx.superAdminMemberId,
          qty: '1',
        },
        {
          sessionId: sessionBId,
          skuId: skuB!.id,
          contributorMemberId: fx.superAdminMemberId,
          qty: '2',
        },
      ]);
      await db.insert(s.runItemsV).values([
        {
          runId,
          skuId: skuA!.id,
          plannedQty: '2',
          purchasedQty: '2',
          supplierId: hiddenSupplier!.id,
          unitPrice: '200',
          status: 'purchased',
          paymentMethod: 'transfer',
          receiptPhotoUrl: `https://hidden.example/${suffix}.jpg`,
        },
        {
          runId,
          skuId: skuB!.id,
          plannedQty: '2',
          purchasedQty: '2',
          unitPrice: '200',
          status: 'purchased',
          paymentMethod: 'cash',
        },
        {
          runId,
          skuId: skuC!.id,
          plannedQty: '1',
          purchasedQty: '1',
          supplierId: visibleSupplier!.id,
          unitPrice: '50',
          status: 'purchased',
          paymentMethod: 'cash',
          receiptPhotoUrl: `https://visible.example/${suffix}.jpg`,
        },
      ]);
      await db.insert(s.runItemStoresV).values([
        {
          runId,
          skuId: skuA!.id,
          storeId: storeA.id,
          qty: '1',
          unitPrice: '100',
          paymentMethod: 'cash',
        },
        // Same SKU, hidden store: null overrides inherit the org-wide
        // run-item values (200/transfer). Store A must never receive those
        // base values in historyDetail JSON.
        { runId, skuId: skuA!.id, storeId: storeB.id, qty: '1' },
        { runId, skuId: skuB!.id, storeId: storeB.id, qty: '2' },
        { runId, skuId: skuC!.id, storeId: storeA.id, qty: '1' },
      ]);
      await db.insert(s.runExpensesV).values({
        id: randomUUID(),
        runId,
        orgId: fx.orgId,
        label: `Taxi ${suffix}`,
        qty: '3',
        unitPrice: '10',
        storeSplitsJson: [
          { storeId: storeA.id, qty: '1' },
          { storeId: storeB.id, qty: '2' },
        ],
        paymentMethod: 'transfer',
        reason: 'history scope fixture',
        addedByMemberId: fx.superAdminMemberId,
        addedAt: new Date('2042-08-05T11:00:00Z'),
      });
      await db.insert(s.events).values([
        {
          orgId: fx.orgId,
          streamType: 'run',
          streamId: runId,
          seq: 1,
          type: 'RunPlanned',
          payload: {
            orgId: fx.orgId,
            runDate,
            runIndex: 0,
            sessionIds: [sessionAId, sessionBId],
            plannedItems: [
              { skuId: skuA!.id, qty: '2' },
              { skuId: skuB!.id, qty: '2' },
              { skuId: skuC!.id, qty: '1' },
            ],
            purchaserMemberId: fx.superAdminMemberId,
          },
          actorId: fx.superAdminUserId,
          occurredAt: new Date('2042-08-05T10:00:00Z'),
        },
        {
          orgId: fx.orgId,
          streamType: 'run',
          streamId: runId,
          seq: 2,
          type: 'RunFinished',
          payload: {
            totalActual: '780',
            totalCash: '550',
            totalTransfer: '230',
          },
          actorId: fx.superAdminUserId,
          occurredAt: new Date('2042-08-05T12:00:00Z'),
        },
      ]);

      const caller = callerFor(managerSession);
      const page = await caller.run.history({
        dateFrom: runDate,
        dateTo: runDate,
        payment: 'mixed',
        page: 1,
        pageSize: 10,
        sort: 'newest',
      });
      expect(page.pageInfo.totalCount).toBe(1);
      expect(page.rows).toHaveLength(1);
      expect(Number(page.rows[0]!.actualTotal)).toBe(160);
      expect(Number(page.rows[0]!.actualCashTotal)).toBe(150);
      expect(Number(page.rows[0]!.actualTransferTotal)).toBe(10);
      expect(Number(page.summary.total)).toBe(160);
      expect(page.rows[0]!.storeTotals.map((row) => row.storeId)).toEqual([storeA.id]);

      const cashOnly = await caller.run.history({
        dateFrom: runDate,
        dateTo: runDate,
        payment: 'cash',
        page: 1,
        pageSize: 10,
      });
      const transferOnly = await caller.run.history({
        dateFrom: runDate,
        dateTo: runDate,
        payment: 'transfer',
        page: 1,
        pageSize: 10,
      });
      expect(cashOnly.rows).toHaveLength(0);
      expect(transferOnly.rows).toHaveLength(0);

      const hiddenSearch = await caller.run.history({
        search: `Foreign secret ${suffix}`,
        dateFrom: runDate,
        dateTo: runDate,
        page: 1,
        pageSize: 10,
        sort: 'newest',
      });
      expect(hiddenSearch.rows).toHaveLength(0);

      await expect(
        caller.run.history({ storeId: storeB.id, page: 1, pageSize: 10 }),
      ).rejects.toThrow('notAssignedToStore');

      const detail = await caller.run.historyDetail({ runId });
      expect(new Set(detail.items.map((item) => item.skuId))).toEqual(
        new Set([skuA!.id, skuC!.id]),
      );
      expect(detail.items.find((item) => item.skuId === skuA!.id)).toMatchObject({
        plannedQty: '1',
        purchasedQty: '1',
        unitPrice: '100.00',
        paymentMethod: 'cash',
        supplierId: null,
        receiptPhotoUrl: null,
      });
      expect(detail.items.find((item) => item.skuId === skuC!.id)).toMatchObject({
        unitPrice: '50.00',
        paymentMethod: 'cash',
        supplierId: visibleSupplier!.id,
        receiptPhotoUrl: `https://visible.example/${suffix}.jpg`,
      });
      expect(detail.perStoreDemand).toContainEqual({
        storeId: storeA.id,
        skuId: skuB!.id,
        qty: '1',
      });
      expect(new Set(detail.splits.map((split) => split.storeId))).toEqual(new Set([storeA.id]));
      expect(detail.splits.find((split) => split.skuId === skuA!.id)).toMatchObject({
        skuId: skuA!.id,
        storeId: storeA.id,
        qty: '1.000',
        unitPrice: '100.00',
        paymentMethod: 'cash',
      });
      expect(JSON.stringify(detail)).not.toContain(hiddenSupplier!.id);
      expect(JSON.stringify(detail)).not.toContain(`https://hidden.example/${suffix}.jpg`);
      expect(detail.sessions.map((session) => session.storeId)).toEqual([storeA.id]);
      expect(detail.expenses).toHaveLength(1);
      expect(detail.expenses[0]!.qty).toBe('1');
      expect(detail.expenses[0]!.storeSplits).toEqual([{ storeId: storeA.id, qty: '1' }]);
      // The flat session contains run.amend only because of a Store-A role.
      // A settled-run correction requires persisted GLOBAL provenance.
      expect(detail.canAmend).toBe(false);

      // Live run reads use generic assigned-store visibility, but must return
      // a Store-A projection instead of the raw A+B aggregate row.
      const liveReaderUser = await makeUser(`Live run reader ${suffix}`);
      const liveReaderMember = await makeMember(liveReaderUser.id);
      await bindRole(liveReaderMember, fx.managerRoleId, {
        type: 'store',
        storeId: storeA.id,
      });
      const liveReader = callerFor(await sessionFor(liveReaderMember, liveReaderUser.id));
      const liveRows = await liveReader.run.list();
      const liveSummary = liveRows.find((row) => row.id === runId);
      expect(liveSummary).toBeDefined();
      expect(liveSummary!.sessionIdsJson).toEqual([sessionAId]);
      expect(Number(liveSummary!.actualTotal)).toBe(150);
      expect(Number(liveSummary!.actualCashTotal)).toBe(150);
      expect(Number(liveSummary!.actualTransferTotal)).toBe(0);
      expect(liveSummary!.storeTotals.map((row) => row.storeId)).toEqual([storeA.id]);

      const liveDetail = await liveReader.run.get({ runId });
      expect(liveDetail.sessionIdsJson).toEqual([sessionAId]);
      expect(new Set(liveDetail.items.map((item) => item.skuId))).toEqual(
        new Set([skuA!.id, skuC!.id]),
      );
      expect(liveDetail.items.find((item) => item.skuId === skuA!.id)).toMatchObject({
        plannedQty: '1',
        purchasedQty: '1',
        unitPrice: '100.00',
        paymentMethod: 'cash',
        supplierId: null,
        receiptPhotoUrl: null,
      });
      expect(liveDetail.splits.map((split) => split.storeId)).toEqual([storeA.id, storeA.id]);
      // DX-BUY-1: a visible split paid like the item it belongs to reads as
      // inherited (null), so the row's cash / transfer switch stays a switch;
      // the item carries the method the reader's stores were paid with.
      expect(liveDetail.splits.find((split) => split.skuId === skuA!.id)).toMatchObject({
        unitPrice: '100.00',
        paymentMethod: null,
      });
      expect(liveDetail.splits.find((split) => split.skuId === skuC!.id)?.paymentMethod).toBeNull();
      expect(Number(liveDetail.actualTotal)).toBe(150);
      expect(Number(liveDetail.actualCashTotal)).toBe(150);
      expect(Number(liveDetail.actualTransferTotal)).toBe(0);
      expect(liveDetail.sessions.map((session) => session.storeId)).toEqual([storeA.id]);
      expect(liveDetail.expenses).toHaveLength(1);
      expect(liveDetail.expenses[0]!.qty).toBe('1');
      expect(liveDetail.expenses[0]!.storeSplits).toEqual([{ storeId: storeA.id, qty: '1' }]);
      expect(JSON.stringify(liveDetail)).not.toContain(hiddenSupplier!.id);
      expect(JSON.stringify(liveDetail)).not.toContain(`https://hidden.example/${suffix}.jpg`);

      expect(
        (await errorOf(() => caller.run.changeDate({ runId, runDate: '2042-08-06' })))?.message,
      ).toContain('cannotAmend');
      expect(
        (await errorOf(() => caller.run.reopen({ runId, reason: 'scoped role must not reopen' })))
          ?.message,
      ).toContain('cannotAmend');
      const globalDeniedUser = await makeUser(`History globally denied ${suffix}`);
      const globalDeniedMember = await makeMember(globalDeniedUser.id);
      await bindRole(globalDeniedMember, fx.superAdminRoleId, { type: 'global' });
      await db.insert(s.memberPermissionOverrides).values({
        memberId: globalDeniedMember,
        permissionKey: 'run.amend',
        effect: 'deny',
        scopeType: 'store',
        scopeId: storeA.id,
        grantedBy: fx.superAdminUserId,
      });
      const globalDeniedCaller = callerFor(
        await sessionFor(globalDeniedMember, globalDeniedUser.id),
      );
      expect((await globalDeniedCaller.run.historyDetail({ runId })).canAmend).toBe(false);
      await expect(
        globalDeniedCaller.run.reopen({ runId, reason: 'store deny must win' }),
      ).rejects.toThrow('cannotAmend');

      const adminPage = await appRouter.createCaller(fx.superAdminCtx).run.history({
        dateFrom: runDate,
        dateTo: runDate,
        page: 1,
        pageSize: 10,
        sort: 'newest',
      });
      expect(Number(adminPage.summary.total)).toBe(780);
      expect(new Set(adminPage.rows[0]!.storeTotals.map((row) => row.storeId))).toEqual(
        new Set([storeA.id, storeB.id]),
      );

      const superAdminCaller = appRouter.createCaller(fx.superAdminCtx);
      const superAdminDetail = await superAdminCaller.run.historyDetail({ runId });
      expect(superAdminDetail.canAmend).toBe(true);
      expect(superAdminDetail.items.find((item) => item.skuId === skuA!.id)).toMatchObject({
        unitPrice: '200.00',
        paymentMethod: 'transfer',
        supplierId: hiddenSupplier!.id,
        receiptPhotoUrl: `https://hidden.example/${suffix}.jpg`,
      });
      expect(
        superAdminDetail.splits.find(
          (split) => split.skuId === skuA!.id && split.storeId === storeB.id,
        ),
      ).toMatchObject({ unitPrice: null, paymentMethod: null });

      // Once the global actor reopens the run, every write path must repeat
      // the persisted-global gate. Domain commands alone only see the flat
      // permission union and would otherwise let this scoped actor refinalize
      // or even cancel the amending run.
      await superAdminCaller.run.reopen({ runId, reason: 'exercise amendment gate' });

      for (const attempt of [
        () =>
          caller.run.markUnavailable({
            runId,
            skuId: skuA!.id,
            note: 'scoped role must not edit an amended run',
          }),
        () => caller.run.refinalize({ runId }),
        () => caller.run.cancel({ runId, reason: '' }),
      ]) {
        expect((await errorOf(attempt))?.message).toContain('cannotAmend');
      }

      const staffUser = await makeUser(`History staff ${suffix}`);
      const staffMember = await makeMember(staffUser.id);
      await bindRole(staffMember, fx.staffRoleId, { type: 'store', storeId: storeA.id });
      const staffCaller = callerFor(await sessionFor(staffMember, staffUser.id));
      await expect(staffCaller.run.history({ page: 1, pageSize: 10 })).rejects.toThrow(
        'missingPermission',
      );
    },
  );

  test.skipIf(!SHOULD_RUN)(
    'global prices.view honors a store deny and keeps inactive historical stores',
    async () => {
      const fx = fixture();
      const db = getDb(undefined, { system: 'maintenance' });
      const globalUser = await makeUser('History global override actor');
      const globalMember = await makeMember(globalUser.id);
      await bindRole(globalMember, fx.adminRoleId, { type: 'global' });
      const inactiveStore = await makeStore(`History inactive ${Math.random()}`);
      const deniedStore = await makeStore(`History denied ${Math.random()}`);
      await db
        .update(s.stores)
        .set({ isActive: false, deletedAt: new Date() })
        .where(eq(s.stores.id, inactiveStore.id));
      await db.insert(s.memberPermissionOverrides).values({
        memberId: globalMember,
        permissionKey: 'prices.view',
        effect: 'deny',
        scopeType: 'store',
        scopeId: deniedStore.id,
        grantedBy: fx.superAdminUserId,
      });

      const session = await sessionFor(globalMember, globalUser.id);
      const stores = await withOrgContext(db, fx.orgId, (tx) =>
        getActorStoreIdsForPermission(tx, globalMember, 'prices.view', session.permissions),
      );
      expect(stores).not.toBeNull();
      expect(stores).toContain(inactiveStore.id);
      expect(stores).not.toContain(deniedStore.id);

      const catalogCaller = callerFor(session);
      const priceStores = await catalogCaller.catalog.stores({ permission: 'prices.view' });
      expect(priceStores.map((store) => store.id)).toContain(inactiveStore.id);
      expect(priceStores.map((store) => store.id)).not.toContain(deniedStore.id);

      // No permission input preserves the generic catalog contract:
      // org.admin sees the whole organization, including a store that has
      // a permission-specific deny.
      const unfilteredStores = await catalogCaller.catalog.stores();
      expect(unfilteredStores.map((store) => store.id)).toContain(deniedStore.id);
      const allOrgStores = await db
        .select({ id: s.stores.id })
        .from(s.stores)
        .where(eq(s.stores.orgId, fx.orgId));
      expect(new Set(unfilteredStores.map((store) => store.id))).toEqual(
        new Set(allOrgStores.map((store) => store.id)),
      );
    },
  );

  test.skipIf(!SHOULD_RUN)(
    'returns stable database pages with count and next/previous metadata',
    async () => {
      const fx = fixture();
      const db = getDb(undefined, { system: 'maintenance' });
      const store = await makeStore(`History pages ${Math.random()}`);
      // One run a day: a page is whole days (DX-HIS-5), tested below.
      const fixtures = Array.from({ length: 11 }, (_, i) => ({
        runId: randomUUID(),
        sessionId: randomUUID(),
        runDate: `2043-08-${String(i + 1).padStart(2, '0')}`,
      }));
      await db.insert(s.marketRunsV).values(
        fixtures.map(({ runId, sessionId, runDate }) => ({
          id: runId,
          orgId: fx.orgId,
          runDate,
          runIndex: 0,
          status: 'finished',
          actualTotal: '0',
          actualCashTotal: '0',
          actualTransferTotal: '0',
          sessionIdsJson: [sessionId],
          finishedAt: new Date('2043-08-05T12:00:00Z'),
        })),
      );
      await db.insert(s.orderSessionsV).values(
        fixtures.map(({ runId, sessionId, runDate }) => ({
          id: sessionId,
          orgId: fx.orgId,
          storeId: store.id,
          orderDate: runDate,
          status: 'archived',
          initiatedByMemberId: fx.superAdminMemberId,
          runId,
        })),
      );

      const caller = appRouter.createCaller(fx.superAdminCtx);
      const page = (n: number) =>
        caller.run.history({
          storeId: store.id,
          dateFrom: '2043-08-01',
          dateTo: '2043-08-11',
          page: n,
          pageSize: 10,
          sort: 'newest',
        });
      const first = await page(1);
      const second = await page(2);
      expect(first.rows).toHaveLength(10);
      expect(second.rows).toHaveLength(1);
      expect(first.rows.map((row) => row.runDate.slice(-2))).toEqual([
        '11', '10', '09', '08', '07', '06', '05', '04', '03', '02',
      ]);
      expect(second.rows[0]!.runDate).toBe('2043-08-01');
      expect(first.pageInfo).toEqual({
        page: 1,
        pageSize: 10,
        totalCount: 11,
        totalPages: 2,
        hasPrevious: false,
        hasNext: true,
        firstRun: 1,
        lastRun: 10,
      });
      expect(second.pageInfo.hasPrevious).toBe(true);
      expect(second.pageInfo.hasNext).toBe(false);
      expect(second.pageInfo.firstRun).toBe(11);
    },
  );

  test.skipIf(!SHOULD_RUN)(
    'DX-HIS-5: a page never splits a day; a day longer than a page is one page',
    async () => {
      const fx = fixture();
      const db = getDb(undefined, { system: 'maintenance' });
      const store = await makeStore(`History days ${Math.random()}`);
      // Days (newest first): 09-03 ×4, 09-02 ×7, 09-01 ×12. Pages of 10
      // runs: 09-03 starts at 0 and 09-02 at 4 → page 1 (11 runs); 09-01
      // starts at 11 → page 2 (12 runs), not split across pages 2 and 3.
      const plan: Array<[string, number]> = [
        ['2044-09-01', 12],
        ['2044-09-02', 7],
        ['2044-09-03', 4],
      ];
      const fixtures = plan.flatMap(([runDate, n]) =>
        Array.from({ length: n }, (_, runIndex) => ({
          runId: randomUUID(),
          sessionId: randomUUID(),
          runDate,
          runIndex,
        })),
      );
      await db.insert(s.marketRunsV).values(
        fixtures.map(({ runId, sessionId, runDate, runIndex }) => ({
          id: runId,
          orgId: fx.orgId,
          runDate,
          runIndex,
          status: 'finished',
          actualTotal: '0',
          actualCashTotal: '0',
          actualTransferTotal: '0',
          sessionIdsJson: [sessionId],
          finishedAt: new Date('2044-09-03T12:00:00Z'),
        })),
      );
      await db.insert(s.orderSessionsV).values(
        fixtures.map(({ runId, sessionId, runDate }) => ({
          id: sessionId,
          orgId: fx.orgId,
          storeId: store.id,
          orderDate: runDate,
          status: 'archived',
          initiatedByMemberId: fx.superAdminMemberId,
          runId,
        })),
      );
      const caller = appRouter.createCaller(fx.superAdminCtx);
      const page = (n: number) =>
        caller.run.history({
          storeId: store.id,
          dateFrom: '2044-09-01',
          dateTo: '2044-09-03',
          page: n,
          pageSize: 10,
          sort: 'newest',
        });
      const first = await page(1);
      const second = await page(2);
      const third = await page(3);
      expect(first.rows.map((r) => r.runDate)).toEqual([
        ...Array(4).fill('2044-09-03'),
        ...Array(7).fill('2044-09-02'),
      ]);
      expect(second.rows.map((r) => r.runDate)).toEqual(Array(12).fill('2044-09-01'));
      expect(third.rows).toHaveLength(0);
      expect(first.pageInfo).toMatchObject({ totalPages: 2, hasNext: true, firstRun: 1, lastRun: 11 });
      expect(second.pageInfo).toMatchObject({ hasNext: false, firstRun: 12, lastRun: 23 });
    },
  );
});
