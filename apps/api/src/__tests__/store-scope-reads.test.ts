/**
 * Store-scoped reads and writes outside administration: sales, dishes,
 * inventory, the finance reports and who is notified. A member bound to
 * one store must not read or write another's. With admin-scope.test.ts
 * and run-history-scope.test.ts, split out of store-scoped-admin.test.ts
 * (review TEST2-04, 2026-11).
 *
 * Skipped when DATABASE_URL is unset or SKIP_PG_TESTS=1.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb, schema as s } from '@compass/db';
import { appRouter } from '../trpc/router';
import { SHOULD_RUN } from './helpers/pg';
import { testContext } from './helpers/ctx';
import { seedFinishedPurchase } from './helpers/fixtures';
import { scopeOrgSuite } from './helpers/scopeOrg';

const { fixture, makeStore, makeUser, makeMember, bindRole, sessionFor } =
  scopeOrgSuite('Store Scope Reads Tests');

// ---------- M3.1: sales router store-scope assertion ---------------------
//
// Audit found sales.list took storeId as input without checking the
// caller was assigned to that store. A staff at Store A could pass
// storeId=<Store B> and read Store B's sales history. sales.record had
// the same shape — perm check + per-store override, but no MSA gate, so
// a Store A staff with `sales.record` could post deductions against
// Store B's inventory.
//
// Both procedures now call assertActorAssignedToStore BEFORE doing any
// other work; these tests lock that in.

describe('M3.1 sales router store-scope', () => {
  test.skipIf(!SHOULD_RUN)('staff assigned only to Store A cannot list Store B sales', async () => {
    const fx = fixture();
    const storeA = await makeStore(`SalesA-${Math.random()}`);
    const storeB = await makeStore(`SalesB-${Math.random()}`);
    // Staff bound to Store A via a store-scoped role binding. The
    // role itself doesn't matter for sales.list (it's authed-only);
    // what matters is `getActorStoreIds(member, perms)` only returns
    // [storeA.id] and `assertActorAssignedToStore(storeB)` must
    // throw FORBIDDEN.
    const staffUser = await makeUser('A-Staff');
    const staffMember = await makeMember(staffUser.id);
    await bindRole(staffMember, fx.staffRoleId, {
      type: 'store',
      storeId: storeA.id,
    });
    const ctx = testContext(await sessionFor(staffMember, staffUser.id));
    const caller = appRouter.createCaller(ctx);
    const db = getDb(undefined, { system: 'maintenance' });
    const [dish] = await db
      .insert(s.dishes)
      .values({ orgId: fx.orgId, names: { en: 'Plov' } })
      .returning();
    const [saleA] = await db
      .insert(s.sales)
      .values([
        { orgId: fx.orgId, storeId: storeA.id, dishId: dish!.id, qty: '1' },
        { orgId: fx.orgId, storeId: storeB.id, dishId: dish!.id, qty: '2' },
      ])
      .returning({ id: s.sales.id });

    // POSITIVE: their own store's sales, and no other's.
    const own = await caller.sales.list({ storeId: storeA.id });
    expect(own.map((sale) => sale.id)).toEqual([saleA!.id]);

    // NEGATIVE: foreign store throws notAssignedToStore.
    await expect(caller.sales.list({ storeId: storeB.id })).rejects.toThrow('notAssignedToStore');
  });

  test.skipIf(!SHOULD_RUN)(
    'staff with sales.record on a custom role cannot post a sale into a foreign store',
    async () => {
      const fx = fixture();
      const db = getDb(undefined, { system: 'maintenance' });
      const storeA = await makeStore(`SalesA2-${Math.random()}`);
      const storeB = await makeStore(`SalesB2-${Math.random()}`);
      // A custom role that carries sales.record, bound to Store A only.
      const [salesRole] = await db
        .insert(s.roles)
        .values({
          orgId: fx.orgId,
          slug: `sales-staff-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
          name: 'Sales Staff',
          rank: 15,
          isBuiltIn: false,
        })
        .returning();
      await db
        .insert(s.rolePermissions)
        .values({ roleId: salesRole!.id, permissionKey: 'sales.record' });

      const u = await makeUser('A-Sales');
      const m = await makeMember(u.id);
      await bindRole(m, salesRole!.id, { type: 'store', storeId: storeA.id });
      const ctx = testContext(await sessionFor(m, u.id));
      const caller = appRouter.createCaller(ctx);

      // Use a syntactically-valid (but unused) dish UUID — the gate must
      // fire BEFORE the dish-existence check, so the call must throw
      // notAssignedToStore rather than dishNotFound.
      const fakeDish = '00000000-0000-0000-0000-000000000000';
      // Critical: must be the store gate, NOT a downstream error.
      // If the gate didn't fire, we'd see dishNotFound or permission
      // denied — both would mean the leak still exists.
      await expect(
        caller.sales.record({ storeId: storeB.id, dishId: fakeDish, qty: '1' }),
      ).rejects.toThrow('notAssignedToStore');
    },
  );
});

// ---------- M3.2: dishes.manage demoted off store manager ----------------
//
// The pre-launch audit found that manager (rank 60, store-tier) had
// `dishes.manage` in its seed permission list. dishes/recipes are
// org-wide (the table has only org_id, not store_id) — so a Store A
// manager editing a recipe silently changes how every OTHER store
// deducts ingredient inventory at sale time.
//
// M3.2 removes the perm from the manager seed AND ships migration
// 0020 to retroactively delete the binding for every existing org.
// This test locks the seed state in.

describe('M3.2 store manager cannot edit org-wide dishes', () => {
  test.skipIf(!SHOULD_RUN)(
    'manager session does not carry dishes.manage and dishes.create throws FORBIDDEN',
    async () => {
      const fx = fixture();
      const storeA = await makeStore(`Dish-A-${Math.random()}`);
      const mgrUser = await makeUser('A-Manager-NoMenu');
      const mgrMember = await makeMember(mgrUser.id);
      await bindRole(mgrMember, fx.managerRoleId, { type: 'store', storeId: storeA.id });
      const session = await sessionFor(mgrMember, mgrUser.id);

      // (1) The manager's flat permission set must NOT carry
      // dishes.manage — proves the seed-level demotion took.
      expect(session.permissions.has('dishes.manage')).toBe(false);

      // (2) users.manage IS still on manager (for the M1.9 store-
      // level invite path). This is the trap the M3.2 follow-up
      // closes — without dropping the OR-fallback in
      // requireDishesManage, the manager would still slip through.
      expect(session.permissions.has('users.manage')).toBe(true);

      // (3) The real proof: calling dishes.create as the manager
      // must throw FORBIDDEN with the dishes.errors.cannotManage
      // marker. If this test ever starts succeeding it means the
      // users.manage fallback came back; that's a regression on the
      // org-wide write gate.
      const ctx = testContext(session);
      const caller = appRouter.createCaller(ctx);
      await expect(
        caller.dishes.create({
          names: { en: 'Forbidden Pasta' },
          ingredients: [],
        }),
      ).rejects.toThrow('cannotManage');
    },
  );
});

// ---------- M3.7: inventory + finance reports cannot leak cross-store ---
//
// Audit found procedures that took an input.storeId but never
// verified the actor was bound to that store:
//   - inventory.levels: read on-hand stock
//   - inventory.recentMovements: read movement history
//   - inventory.stocktake / recordWastage: write to inventory ledger
//     (had perm check + effective-perm override but no MSA gate)
//   - report.purchaseLines / totals: finance roll-ups gated on
//     users.manage; manager-of-A could read Store B's finance because
//     users.manage doesn't imply per-store scope
//
// The inventory procedures now go through assertActorAssignedToStore.
// The finance reports read only the stores financeStoreIds returns
// (every store for an org-wide reader).

describe('M3.7 inventory cannot be read for a foreign store', () => {
  test.skipIf(!SHOULD_RUN)(
    'staff bound to Store A cannot inventory.levels(storeId=B)',
    async () => {
      const fx = fixture();
      const storeA = await makeStore(`InvA-${Math.random()}`);
      const storeB = await makeStore(`InvB-${Math.random()}`);
      const staffUser = await makeUser('A-Staff-Inv');
      const staffMember = await makeMember(staffUser.id);
      await bindRole(staffMember, fx.staffRoleId, {
        type: 'store',
        storeId: storeA.id,
      });
      const ctx = testContext(await sessionFor(staffMember, staffUser.id));
      const caller = appRouter.createCaller(ctx);
      const db = getDb(undefined, { system: 'maintenance' });
      const [sku] = await db
        .insert(s.skus)
        .values({
          orgId: fx.orgId,
          code: `INV-${randomUUID().slice(0, 8)}`,
          names: { en: 'Flour' },
          unit: 'kg',
          step: '1',
        })
        .returning();
      await db.insert(s.inventoryMovements).values([
        { orgId: fx.orgId, storeId: storeA.id, skuId: sku!.id, delta: '3', reason: 'adjustment' },
        { orgId: fx.orgId, storeId: storeB.id, skuId: sku!.id, delta: '5', reason: 'adjustment' },
      ]);

      // OWN store: its stock, not B's.
      const own = await caller.inventory.levels({ storeId: storeA.id });
      expect(own).toEqual([
        expect.objectContaining({ skuId: sku!.id, onHand: '3.000', movementCount: 1 }),
      ]);

      // FOREIGN store: must throw notAssignedToStore. Pre-M3.7 this
      // returned Store B's full on-hand list.
      await expect(caller.inventory.levels({ storeId: storeB.id })).rejects.toThrow(
        'notAssignedToStore',
      );
    },
  );

  test.skipIf(!SHOULD_RUN)(
    'manager bound to Store A cannot inventory.stocktake(storeId=B)',
    async () => {
      // The manager role carries inventory.adjust, but only in Store A.
      // The store gate must fire BEFORE the perm check — order matters
      // because we want the FORBIDDEN to be notAssignedToStore, not
      // cannotAdjust.
      const fx = fixture();
      const storeA = await makeStore(`StockA-${Math.random()}`);
      const storeB = await makeStore(`StockB-${Math.random()}`);
      const mgrUser = await makeUser('A-Mgr-Stocktake');
      const mgrMember = await makeMember(mgrUser.id);
      await bindRole(mgrMember, fx.managerRoleId, {
        type: 'store',
        storeId: storeA.id,
      });
      const ctx = testContext(await sessionFor(mgrMember, mgrUser.id));
      const caller = appRouter.createCaller(ctx);

      // Real SKU UUID doesn't need to exist — the store-gate fires
      // before the SKU is looked up by the stocktake handler.
      const fakeSku = '00000000-0000-0000-0000-000000000000';
      await expect(
        caller.inventory.stocktake({
          storeId: storeB.id,
          skuId: fakeSku,
          target: '0',
        }),
      ).rejects.toThrow('notAssignedToStore');
    },
  );
});

describe('M3.7 finance reports filter by actor bindings unless org.admin', () => {
  test.skipIf(!SHOULD_RUN)(
    'manager-of-A passing storeId=B to report.purchaseLines throws notAssignedToStore',
    async () => {
      const fx = fixture();
      const storeA = await makeStore(`FinA-${Math.random()}`);
      const storeB = await makeStore(`FinB-${Math.random()}`);
      const mgrUser = await makeUser('A-Mgr-Finance');
      const mgrMember = await makeMember(mgrUser.id);
      await bindRole(mgrMember, fx.managerRoleId, {
        type: 'store',
        storeId: storeA.id,
      });
      // The manager role carries reports.view, so the finance gate at
      // the top of report.purchaseLines passes — what kicks in next is
      // the M3.7 store-scope filter.
      const ctx = testContext(await sessionFor(mgrMember, mgrUser.id));
      const caller = appRouter.createCaller(ctx);

      await expect(
        caller.report.purchaseLines({
          startDate: '2026-01-01',
          endDate: '2026-12-31',
          storeId: storeB.id,
        }),
      ).rejects.toThrow('notAssignedToStore');

      // OWN store: A's half of a purchase made for both stores.
      const db = getDb(undefined, { system: 'maintenance' });
      const { runId } = await seedFinishedPurchase(db, fx.orgId, {
        runDate: '2026-07-15',
        unitPrice: '1000',
        splits: [
          { storeId: storeA.id, qty: '1' },
          { storeId: storeB.id, qty: '1' },
        ],
      });
      const own = await caller.report.purchaseLines({
        startDate: '2026-01-01',
        endDate: '2026-12-31',
        storeId: storeA.id,
      });
      expect(own.filter((row) => row.runId === runId)).toEqual([
        expect.objectContaining({ storeId: storeA.id, lineTotal: '1000.00' }),
      ]);
    },
  );

  test.skipIf(!SHOULD_RUN)(
    'manager-of-A calling report.purchaseLines without storeId is auto-filtered to bound stores',
    async () => {
      const fx = fixture();
      const storeA = await makeStore(`FinA2-${Math.random()}`);
      const storeB = await makeStore(`FinB2-${Math.random()}`);
      const mgrUser = await makeUser('A-Mgr-Finance2');
      const mgrMember = await makeMember(mgrUser.id);
      await bindRole(mgrMember, fx.managerRoleId, {
        type: 'store',
        storeId: storeA.id,
      });
      const ctx = testContext(await sessionFor(mgrMember, mgrUser.id));
      const caller = appRouter.createCaller(ctx);

      // A finished run in the range that bought one product for both
      // stores.
      const db = getDb(undefined, { system: 'maintenance' });
      const { runId } = await seedFinishedPurchase(db, fx.orgId, {
        runDate: '2026-07-15',
        unitPrice: '1000',
        splits: [
          { storeId: storeA.id, qty: '1' },
          { storeId: storeB.id, qty: '1' },
        ],
      });

      // No storeId in the query → server-side allowedStoreIds filter
      // kicks in. Manager only bound to A, so the run shows only A's
      // half, and nothing else is listed. Pre-M3.7 the result would
      // include every store's purchases org-wide.
      const lines = await caller.report.purchaseLines({
        startDate: '2026-01-01',
        endDate: '2026-12-31',
      });
      expect(lines.filter((row) => row.runId === runId).map((row) => row.storeId)).toEqual([
        storeA.id,
      ]);
      expect(lines.every((row) => row.storeId === storeA.id)).toBe(true);
    },
  );
});

// ---------- M3.6: notification recipients are store-scoped ---------------
//
// Before M3.6 the order.submitted notification fan-out used
// findRecipientsByPermission which returned every user in the org
// with `order.approve` regardless of their binding's store scope.
// A manager bound to Store B would get notified about Store A
// submissions — an info leak about the other store's submission
// rate, contributor, and SKU mix.
//
// findRecipientsByPermissionInStore filters by perm AND
// (binding.scopeType='global' OR binding.scopeId=targetStoreId).
// Global bindings (admin/super_admin) still receive — they oversee
// the chain — but store-scoped bindings only fire for their own store.

describe('M3.6 notification recipients respect store scope', () => {
  test.skipIf(!SHOULD_RUN)(
    'findRecipientsByPermissionInStore: store-A manager included, store-B manager excluded, global admin included',
    async () => {
      const fx = fixture();
      const db = getDb(undefined, { system: 'maintenance' });
      const storeA = await makeStore(`NotifyA-${Math.random()}`);
      const storeB = await makeStore(`NotifyB-${Math.random()}`);

      // Two managers bound to A and B respectively. The manager role
      // carries `order.approve`.
      const mgrAUser = await makeUser('A-Mgr-Notify');
      const mgrAMember = await makeMember(mgrAUser.id);
      await bindRole(mgrAMember, fx.managerRoleId, {
        type: 'store',
        storeId: storeA.id,
      });

      const mgrBUser = await makeUser('B-Mgr-Notify');
      const mgrBMember = await makeMember(mgrBUser.id);
      await bindRole(mgrBMember, fx.managerRoleId, {
        type: 'store',
        storeId: storeB.id,
      });

      // Lazy import to avoid pulling the service module into every
      // test file's top-level. notify.ts itself is side-effect-free
      // for imports.
      const { findRecipientsByPermissionInStore } = await import('../services/notify');
      const recipients = await findRecipientsByPermissionInStore(
        db,
        fx.orgId,
        'order.approve',
        storeA.id,
      );

      // Manager of Store A: included.
      expect(recipients).toContain(mgrAUser.id);
      // Manager of Store B: EXCLUDED. This is the leak that M3.6 closes.
      expect(recipients).not.toContain(mgrBUser.id);
      // The owner: INCLUDED. Their Super Admin binding is org-wide and
      // carries order.approve.
      expect(recipients).toContain(fx.superAdminUserId);
    },
  );

  test.skipIf(!SHOULD_RUN)(
    'findRecipientsByPermission (no scope filter) returns BOTH managers — proves filter is what makes the difference',
    async () => {
      const fx = fixture();
      const db = getDb(undefined, { system: 'maintenance' });
      const storeA = await makeStore(`NotifyA2-${Math.random()}`);
      const storeB = await makeStore(`NotifyB2-${Math.random()}`);

      const mgrAUser = await makeUser('A-Mgr-Notify2');
      const mgrAMember = await makeMember(mgrAUser.id);
      await bindRole(mgrAMember, fx.managerRoleId, {
        type: 'store',
        storeId: storeA.id,
      });

      const mgrBUser = await makeUser('B-Mgr-Notify2');
      const mgrBMember = await makeMember(mgrBUser.id);
      await bindRole(mgrBMember, fx.managerRoleId, {
        type: 'store',
        storeId: storeB.id,
      });

      const { findRecipientsByPermission } = await import('../services/notify');
      const recipients = await findRecipientsByPermission(db, fx.orgId, 'order.approve');

      // The unscoped finder returns BOTH managers — same data shape
      // that was leaking to the notify fan-out pre-M3.6.
      expect(recipients).toContain(mgrAUser.id);
      expect(recipients).toContain(mgrBUser.id);
    },
  );
});
