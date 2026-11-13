/**
 * The daily close (日结, settlement router and services/settlement.ts):
 * the messages and money format without a database; then, PG-gated, who
 * may read and save a store's close, its itemised outflows and wages,
 * corrections and their history, archived stores, the 90-day limit on a
 * new close (CLS-14) and the workspace push after a save.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/settlement.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { BACKDATE_LIMIT_DAYS, type SettlementSaveInput } from '@compass/contracts';
import { getDb, schema as s } from '@compass/db';
import { nextDate, todayInTz } from '@compass/domain';
import { hub } from '../realtime/hub';
import { appRouter } from '../trpc/router';
import type { SessionContext } from '../trpc/context';
import { loadCatalog } from '@compass/i18n/catalogs';
import { normalizeSettlementMoney, SETTLEMENT_REASON_KEYS } from '../services/settlement';
import { SHOULD_RUN } from './helpers/pg';
import { freshTgId } from './helpers/telegram';
import { callerFor } from './helpers/ctx';
import { errorOf } from './helpers/errors';
import { cleanUpAfterAll, noteOrg, noteUser } from './helpers/cleanup';
import { middayZone } from './helpers/zone';

cleanUpAfterAll();

/**
 * Business dates for these tests, counted back from ten days ago: new
 * closes may be at most 90 days old (CLS-14), so fixed calendar dates
 * would expire.
 */
const DATE_BASE = new Date(Date.now() - 10 * 86_400_000);
function dayBack(days: number): string {
  const d = new Date(DATE_BASE);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * A business date no other test here has used, a day further back on each
 * call (review TEST2-09). Two closes of one store on one day collide, and
 * the dates used to be handed out by hand.
 */
let datesHandedOut = 0;
function freshDate(): string {
  return dayBack(datesHandedOut++);
}

describe('daily settlement rejection messages', () => {
  test('every reason the API names has a sentence in every language', async () => {
    for (const locale of ['en', 'zh', 'ru', 'uz'] as const) {
      const catalog = await loadCatalog(locale);
      for (const key of Object.values(SETTLEMENT_REASON_KEYS)) {
        expect(catalog[key]).toBeString();
      }
    }
  });
});

describe('daily settlement money normalization', () => {
  test('normalizes equivalent decimal inputs and signed zero', () => {
    expect(normalizeSettlementMoney('10')).toBe('10.00');
    expect(normalizeSettlementMoney('0010.5')).toBe('10.50');
    expect(normalizeSettlementMoney('-12.3')).toBe('-12.30');
    expect(normalizeSettlementMoney('-0')).toBe('0.00');
    // CONF-08: below one unit, and as large as the column holds.
    expect(normalizeSettlementMoney('-0.05')).toBe('-0.05');
    expect(normalizeSettlementMoney('-999999999999.99')).toBe('-999999999999.99');
  });
});

interface Fixture {
  orgId: string;
  /** Store manager; kept as caller for the existing happy-path coverage. */
  memberId: string;
  userId: string;
  cashierMemberId: string;
  cashierUserId: string;
  wageEmployeeMemberId: string;
  assignedOnlyEmployeeMemberId: string;
  foreignEmployeeMemberId: string;
  suspendedEmployeeMemberId: string;
  /** The custom manager role, which carries settlement.record. */
  managerRoleId: string;
  ownStoreId: string;
  foreignStoreId: string;
  managerElsewhereStoreId: string;
  assignedNoPermissionStoreId: string;
  inactiveStoreId: string;
  /** The day of the close seeded in the archived store. */
  archivedCloseDate: string;
  caller: ReturnType<typeof appRouter.createCaller>;
  cashierCaller: ReturnType<typeof appRouter.createCaller>;
  secondManagerMemberId: string;
  secondManagerCaller: ReturnType<typeof appRouter.createCaller>;
  orgAdminOverrideCaller: ReturnType<typeof appRouter.createCaller>;
}

let fixture: Fixture | null = null;

function saveInput(
  storeId: string,
  date: string,
  expectedVersion: number,
  overrides: Partial<SettlementSaveInput> = {},
): SettlementSaveInput {
  return {
    storeId,
    date,
    onlineRevenue: '100',
    invoicedCashRevenue: '50',
    operatingExpenses: '10',
    wagesPaid: '20',
    wagesAccrued: '5',
    operatingExpenseItems: [
      {
        amount: '6.25',
        reason: 'Fuel for the kitchen',
      },
      {
        amount: '3.75',
        reason: 'Collected market supplies',
      },
    ],
    wageItems: [
      {
        memberId: fixture!.wageEmployeeMemberId,
        status: 'paid',
        amount: '20',
        reason: 'Daily kitchen shift',
      },
      {
        memberId: fixture!.wageEmployeeMemberId,
        status: 'unpaid',
        amount: '5',
        reason: 'Ten-day payroll period',
      },
    ],
    nextPurchaseReserve: '30',
    priorPurchaseAdjustment: '-2',
    cashOnHand: '40',
    note: null,
    expectedVersion,
    ...overrides,
  };
}

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({
      slug: `settlement-test-${suffix}`,
      name: 'Settlement Test Org',
      localeDefault: 'en',
      timezone: 'UTC',
    })
    .returning();
  noteOrg(org!.id);
  const [user] = await db
    .insert(s.users)
    .values({
      displayName: 'Settlement Manager',
      tgUserId: freshTgId(),
    })
    .returning();
  noteUser(user!.id);
  const [member] = await db
    .insert(s.members)
    .values({ orgId: org!.id, userId: user!.id, status: 'active' })
    .returning();
  const [cashierUser] = await db
    .insert(s.users)
    .values({
      displayName: 'Settlement Cashier',
      tgUserId: freshTgId(),
    })
    .returning();
  noteUser(cashierUser!.id);
  const [cashierMember] = await db
    .insert(s.members)
    .values({ orgId: org!.id, userId: cashierUser!.id, status: 'active' })
    .returning();
  const [secondManagerUser] = await db
    .insert(s.users)
    .values({
      displayName: 'Second Settlement Manager',
      tgUserId: freshTgId(),
    })
    .returning();
  noteUser(secondManagerUser!.id);
  const [secondManagerMember] = await db
    .insert(s.members)
    .values({ orgId: org!.id, userId: secondManagerUser!.id, status: 'active' })
    .returning();
  const [orgAdminOverrideUser] = await db
    .insert(s.users)
    .values({
      displayName: 'Global Admin Override',
      tgUserId: freshTgId(),
    })
    .returning();
  noteUser(orgAdminOverrideUser!.id);
  const [orgAdminOverrideMember] = await db
    .insert(s.members)
    .values({ orgId: org!.id, userId: orgAdminOverrideUser!.id, status: 'active' })
    .returning();
  const [wageEmployeeUser] = await db
    .insert(s.users)
    .values({
      displayName: 'Ali Kitchen',
      tgUserId: freshTgId(),
    })
    .returning();
  noteUser(wageEmployeeUser!.id);
  const [wageEmployee] = await db
    .insert(s.members)
    .values({ orgId: org!.id, userId: wageEmployeeUser!.id, status: 'active' })
    .returning();
  const [assignedOnlyEmployeeUser] = await db
    .insert(s.users)
    .values({
      displayName: 'Assigned Only Employee',
      tgUserId: freshTgId(),
    })
    .returning();
  noteUser(assignedOnlyEmployeeUser!.id);
  const [assignedOnlyEmployee] = await db
    .insert(s.members)
    .values({ orgId: org!.id, userId: assignedOnlyEmployeeUser!.id, status: 'active' })
    .returning();
  const [foreignEmployeeUser] = await db
    .insert(s.users)
    .values({
      displayName: 'Foreign Employee',
      tgUserId: freshTgId(),
    })
    .returning();
  noteUser(foreignEmployeeUser!.id);
  const [foreignEmployee] = await db
    .insert(s.members)
    .values({ orgId: org!.id, userId: foreignEmployeeUser!.id, status: 'active' })
    .returning();
  const [suspendedUser] = await db
    .insert(s.users)
    .values({ displayName: 'Suspended Employee' })
    .returning();
  noteUser(suspendedUser!.id);
  const [suspendedEmployee] = await db
    .insert(s.members)
    .values({ orgId: org!.id, userId: suspendedUser!.id, status: 'suspended' })
    .returning();
  const [ownStore] = await db
    .insert(s.stores)
    .values({ orgId: org!.id, name: 'Own Store', timezone: 'Pacific/Kiritimati' })
    .returning();
  const [foreignStore] = await db
    .insert(s.stores)
    .values({ orgId: org!.id, name: 'Foreign Store' })
    .returning();
  const [managerElsewhereStore] = await db
    .insert(s.stores)
    .values({ orgId: org!.id, name: 'Manager Elsewhere' })
    .returning();
  const [assignedNoPermissionStore] = await db
    .insert(s.stores)
    .values({ orgId: org!.id, name: 'Assigned Without Settlement' })
    .returning();
  const [inactiveStore] = await db
    .insert(s.stores)
    .values({ orgId: org!.id, name: 'Archived Store', isActive: false, deletedAt: new Date() })
    .returning();

  await db
    .insert(s.permissions)
    .values([
      { key: 'settlement.record', description: 'Settlement tests' },
      { key: 'org.admin', description: 'Organization administration' },
    ])
    .onConflictDoNothing();
  const [managerRole] = await db
    .insert(s.roles)
    .values({
      orgId: org!.id,
      slug: `manager-${suffix}`,
      name: 'Store Manager',
      rank: 60,
    })
    .returning();
  const [cashierRole] = await db
    .insert(s.roles)
    .values({ orgId: org!.id, slug: `cashier-${suffix}`, name: 'Cashier', rank: 30 })
    .returning();
  await db.insert(s.rolePermissions).values([
    { roleId: managerRole!.id, permissionKey: 'settlement.record' },
    { roleId: cashierRole!.id, permissionKey: 'settlement.record' },
  ]);
  const [plainRole] = await db
    .insert(s.roles)
    .values({
      orgId: org!.id,
      slug: `plain-staff-${suffix}`,
      name: 'Plain staff',
      rank: 10,
    })
    .returning();
  await db.insert(s.memberRoleBindings).values([
    {
      memberId: member!.id,
      roleId: managerRole!.id,
      scopeType: 'store',
      scopeId: ownStore!.id,
    },
    {
      memberId: member!.id,
      roleId: managerRole!.id,
      scopeType: 'store',
      scopeId: inactiveStore!.id,
    },
    {
      memberId: member!.id,
      roleId: plainRole!.id,
      scopeType: 'store',
      scopeId: assignedNoPermissionStore!.id,
    },
    {
      memberId: cashierMember!.id,
      roleId: cashierRole!.id,
      scopeType: 'store',
      scopeId: ownStore!.id,
    },
    {
      memberId: secondManagerMember!.id,
      roleId: managerRole!.id,
      scopeType: 'store',
      scopeId: ownStore!.id,
    },
    {
      // This member holds only a cashier role. The global org.admin
      // override below is what grants them every store, including ones they
      // are not assigned to.
      memberId: orgAdminOverrideMember!.id,
      roleId: cashierRole!.id,
      scopeType: 'global',
    },
    // Same person is a manager in another store; their session role set is
    // flattened across stores, but each store is still authorized on its own.
    {
      memberId: cashierMember!.id,
      roleId: managerRole!.id,
      scopeType: 'store',
      scopeId: managerElsewhereStore!.id,
    },
    {
      memberId: wageEmployee!.id,
      roleId: plainRole!.id,
      scopeType: 'store',
      scopeId: ownStore!.id,
    },
  ]);
  await db.insert(s.memberStoreAssignments).values([
    { memberId: wageEmployee!.id, storeId: ownStore!.id },
    { memberId: assignedOnlyEmployee!.id, storeId: ownStore!.id },
    { memberId: foreignEmployee!.id, storeId: foreignStore!.id },
    { memberId: suspendedEmployee!.id, storeId: ownStore!.id },
  ]);
  await db.insert(s.memberPermissionOverrides).values({
    memberId: orgAdminOverrideMember!.id,
    permissionKey: 'org.admin',
    effect: 'allow',
    scopeType: 'global',
    grantedBy: user!.id,
  });

  // Seed one historical archived-store record directly: archived stores are
  // read-only through the API, but their financial history must remain visible.
  const archivedCloseDate = freshDate();
  await db.insert(s.storeDailySettlements).values({
    orgId: org!.id,
    storeId: inactiveStore!.id,
    settlementDate: archivedCloseDate,
    onlineRevenue: '1',
    operatingExpenses: '3',
    wagesPaid: '4',
    wagesAccrued: '5',
    createdByMemberId: member!.id,
    updatedByMemberId: member!.id,
  });

  const session: SessionContext = {
    userId: user!.id,
    memberId: member!.id,
    orgId: org!.id,
    orgTimezone: 'UTC',
    permissions: new Set(['settlement.record']),
    roleSlugs: new Set([managerRole!.slug]),
  };
  const cashierSession: SessionContext = {
    userId: cashierUser!.id,
    memberId: cashierMember!.id,
    orgId: org!.id,
    orgTimezone: 'UTC',
    permissions: new Set(['settlement.record']),
    // Deliberately includes manager because the member is a manager in a
    // different store. Store-scoped authorization must still resolve Own
    // Store from that store's own bindings.
    roleSlugs: new Set([cashierRole!.slug, managerRole!.slug]),
  };
  const secondManagerSession: SessionContext = {
    userId: secondManagerUser!.id,
    memberId: secondManagerMember!.id,
    orgId: org!.id,
    orgTimezone: 'UTC',
    permissions: new Set(['settlement.record']),
    roleSlugs: new Set([managerRole!.slug]),
  };
  const orgAdminOverrideSession: SessionContext = {
    userId: orgAdminOverrideUser!.id,
    memberId: orgAdminOverrideMember!.id,
    orgId: org!.id,
    orgTimezone: 'UTC',
    permissions: new Set(['settlement.record', 'org.admin']),
    roleSlugs: new Set([cashierRole!.slug]),
  };
  fixture = {
    orgId: org!.id,
    memberId: member!.id,
    userId: user!.id,
    cashierMemberId: cashierMember!.id,
    cashierUserId: cashierUser!.id,
    wageEmployeeMemberId: wageEmployee!.id,
    assignedOnlyEmployeeMemberId: assignedOnlyEmployee!.id,
    foreignEmployeeMemberId: foreignEmployee!.id,
    suspendedEmployeeMemberId: suspendedEmployee!.id,
    managerRoleId: managerRole!.id,
    ownStoreId: ownStore!.id,
    foreignStoreId: foreignStore!.id,
    managerElsewhereStoreId: managerElsewhereStore!.id,
    assignedNoPermissionStoreId: assignedNoPermissionStore!.id,
    inactiveStoreId: inactiveStore!.id,
    archivedCloseDate,
    caller: callerFor(session),
    cashierCaller: callerFor(cashierSession),
    secondManagerMemberId: secondManagerMember!.id,
    secondManagerCaller: callerFor(secondManagerSession),
    orgAdminOverrideCaller: callerFor(orgAdminOverrideSession),
  };
});

/**
 * A store of the test's own, run by the fixture's manager, for a test that
 * reads every close in a store or places closes by their distance from
 * today (review TEST2-09): the shared stores hold the other tests' closes.
 * The wage employee works there too, so saveInput's wages are valid.
 * Without a `timezone` of its own it runs on the organisation's (UTC).
 */
async function storeOfItsOwn(name: string, timezone?: string): Promise<string> {
  const fx = fixture!;
  const db = getDb(undefined, { system: 'maintenance' });
  const [store] = await db.insert(s.stores).values({ orgId: fx.orgId, name, timezone }).returning();
  await db.insert(s.memberRoleBindings).values({
    memberId: fx.memberId,
    roleId: fx.managerRoleId,
    scopeType: 'store',
    scopeId: store!.id,
  });
  await db
    .insert(s.memberStoreAssignments)
    .values({ memberId: fx.wageEmployeeMemberId, storeId: store!.id });
  return store!.id;
}

describe.skipIf(!SHOULD_RUN)('daily settlement API (PG-gated)', () => {
  test('returns the selected store authoritative business date and timezone', async () => {
    const fx = fixture!;
    // Read on both sides of the call: midnight in Kiritimati may fall
    // between the server's reading and the test's (review TEST2-14).
    const before = todayInTz('Pacific/Kiritimati');
    const businessDate = await fx.caller.settlement.businessDate({
      storeId: fx.ownStoreId,
    });
    expect([before, todayInTz('Pacific/Kiritimati')]).toContain(businessDate.date);
    expect(businessDate).toEqual({
      storeId: fx.ownStoreId,
      date: businessDate.date,
      timezone: 'Pacific/Kiritimati',
      canRecordOperatingExpenses: true,
    });
    // Operating expenses follow settlement.record, not role rank: the rank-30
    // cashier who does the daily close records them too.
    expect(
      (await fx.cashierCaller.settlement.businessDate({ storeId: fx.ownStoreId }))
        .canRecordOperatingExpenses,
    ).toBe(true);
    expect(
      (
        await fx.cashierCaller.settlement.businessDate({
          storeId: fx.managerElsewhereStoreId,
        })
      ).canRecordOperatingExpenses,
    ).toBe(true);
  });

  test('allows a persisted global org.admin override to record operating expenses', async () => {
    const fx = fixture!;
    const businessDate = await fx.orgAdminOverrideCaller.settlement.businessDate({
      storeId: fx.foreignStoreId,
    });
    expect(businessDate.canRecordOperatingExpenses).toBe(true);

    const saved = await fx.orgAdminOverrideCaller.settlement.save(
      saveInput(fx.foreignStoreId, freshDate(), 0, {
        wagesPaid: '0',
        wagesAccrued: '0',
        wageItems: [],
      }),
    );
    expect(saved.operatingExpenses).toBe('10.00');
  });

  test('catalog exposes only stores where settlement.record is effective', async () => {
    const fx = fixture!;
    const stores = await fx.caller.catalog.stores({ permission: 'settlement.record' });
    const storeIds = stores.map((store) => store.id);
    expect(storeIds).toContain(fx.ownStoreId);
    // Archived settlements remain readable by their direct API routes, but
    // archived stores must never be auto-selected as a new filing target.
    expect(storeIds).not.toContain(fx.inactiveStoreId);
    expect(storeIds).not.toContain(fx.assignedNoPermissionStoreId);
    expect(storeIds).not.toContain(fx.foreignStoreId);
  });

  test('wage roster exposes only active personnel in the selected store and their roles', async () => {
    const fx = fixture!;
    const roster = await fx.cashierCaller.settlement.wageRoster({ storeId: fx.ownStoreId });
    const employee = roster.find((row) => row.memberId === fx.wageEmployeeMemberId);
    expect(employee).toEqual(
      expect.objectContaining({
        memberId: fx.wageEmployeeMemberId,
        displayName: 'Ali Kitchen',
        roles: [expect.objectContaining({ name: 'Plain staff' })],
      }),
    );
    expect(roster.some((row) => row.memberId === fx.foreignEmployeeMemberId)).toBe(false);
    // Cashier is included through a role binding even without an explicit MSA;
    // suspended personnel are excluded even when their MSA remains present.
    expect(roster.some((row) => row.memberId === fx.cashierMemberId)).toBe(true);
    expect(roster.some((row) => row.memberId === fx.suspendedEmployeeMemberId)).toBe(false);
    expect(roster.find((row) => row.memberId === fx.assignedOnlyEmployeeMemberId)).toEqual(
      expect.objectContaining({ displayName: 'Assigned Only Employee', roles: [] }),
    );
    expect(Object.keys(employee ?? {})).toEqual(['memberId', 'displayName', 'roles', 'dailyWage']);

    const error = await errorOf(() =>
      fx.cashierCaller.settlement.wageRoster({ storeId: fx.foreignStoreId }),
    );
    expect(error?.code).toBe('FORBIDDEN');
  });

  test("S4: the wage roster carries each person's daily wage in effect on the day", async () => {
    const fx = fixture!;
    const db = getDb(undefined, { system: 'maintenance' });
    await db.insert(s.attendancePayRates).values([
      {
        orgId: fx.orgId,
        memberId: fx.wageEmployeeMemberId,
        dailyWage: '100.00',
        effectiveFrom: '2020-01-01',
      },
      {
        orgId: fx.orgId,
        memberId: fx.wageEmployeeMemberId,
        dailyWage: '150.50',
        effectiveFrom: '2999-01-01',
      },
    ]);
    const wageOn = async (date?: string) => {
      const roster = await fx.cashierCaller.settlement.wageRoster({
        storeId: fx.ownStoreId,
        ...(date ? { date } : {}),
      });
      return Object.fromEntries(roster.map((row) => [row.memberId, row.dailyWage]));
    };
    const today = await wageOn();
    expect(today[fx.wageEmployeeMemberId]).toBe('100.00');
    // No rate set: nothing to start a line from.
    expect(today[fx.assignedOnlyEmployeeMemberId]).toBeNull();
    expect((await wageOn('2019-12-31'))[fx.wageEmployeeMemberId]).toBeNull();
    expect((await wageOn('2999-06-01'))[fx.wageEmployeeMemberId]).toBe('150.50');
  });

  test('S4: a wage line saves without a reason', async () => {
    const fx = fixture!;
    const saved = await fx.caller.settlement.save(
      saveInput(fx.ownStoreId, freshDate(), 0, {
        wagesPaid: '20',
        wagesAccrued: '5',
        wageItems: [
          { memberId: fx.wageEmployeeMemberId, status: 'paid', amount: '20', reason: '' },
          // An older client may leave it out; it reads as ''.
          { memberId: fx.wageEmployeeMemberId, status: 'unpaid', amount: '5' } as never,
        ],
      }),
    );
    expect(saved.wageItems.map((item) => item.reason)).toEqual(['', '']);
  });

  // UX-15 (owner, 2026-11-13): the default price is a preset for whoever
  // may record the close, prices.view or not (it was redacted under
  // ADM2-01 before).
  test('S5/UX-15: the close offers the expense templates with their default price to whoever records it', async () => {
    const fx = fixture!;
    const db = getDb(undefined, { system: 'maintenance' });
    await db
      .insert(s.permissions)
      .values({ key: 'prices.view', description: 'prices.view' })
      .onConflictDoNothing();
    const [template] = await db
      .insert(s.expenseTemplates)
      .values({
        orgId: fx.orgId,
        label: 'Porter',
        unitHint: 'trip',
        defaultQty: '2',
        defaultUnitPrice: '7.50',
      })
      .returning();
    await db
      .insert(s.expenseTemplates)
      .values({ orgId: fx.orgId, label: 'Old taxi', defaultUnitPrice: '1', isArchived: true });

    const cashierView = await fx.cashierCaller.settlement.expenseTemplates({
      storeId: fx.ownStoreId,
    });
    expect(cashierView).toEqual([
      {
        id: template!.id,
        label: 'Porter',
        unitHint: 'trip',
        defaultQty: '2.000',
        defaultUnitPrice: '7.50',
      },
    ]);

    // An explicit prices.view deny in this store does not hide it either.
    const [deny] = await db
      .insert(s.memberPermissionOverrides)
      .values({
        memberId: fx.cashierMemberId,
        permissionKey: 'prices.view',
        effect: 'deny',
        scopeType: 'store',
        scopeId: fx.ownStoreId,
        grantedBy: fx.userId,
      })
      .returning();
    const deniedView = await fx.cashierCaller.settlement.expenseTemplates({
      storeId: fx.ownStoreId,
    });
    await db
      .delete(s.memberPermissionOverrides)
      .where(eq(s.memberPermissionOverrides.id, deny!.id));
    expect(deniedView.map((row) => row.defaultUnitPrice)).toEqual(['7.50']);

    const error = await errorOf(() =>
      fx.cashierCaller.settlement.expenseTemplates({ storeId: fx.foreignStoreId }),
    );
    expect(error?.code).toBe('FORBIDDEN');
  });

  test('cashiers with settlement.record can create and change operating expenses', async () => {
    const fx = fixture!;
    const managerDay = freshDate();
    const zeroExpense = await fx.cashierCaller.settlement.save(
      saveInput(fx.ownStoreId, freshDate(), 0, {
        operatingExpenses: '0',
        operatingExpenseItems: [],
      }),
    );
    expect(zeroExpense.operatingExpenses).toBe('0.00');

    const cashierClose = await fx.cashierCaller.settlement.save(
      saveInput(fx.ownStoreId, freshDate(), 0),
    );
    expect(cashierClose.operatingExpenses).toBe('10.00');
    expect(cashierClose.operatingExpenseItems).toEqual([
      expect.objectContaining({ amount: '6.25', reason: 'Fuel for the kitchen' }),
      expect.objectContaining({ amount: '3.75', reason: 'Collected market supplies' }),
    ]);

    const managerClose = await fx.caller.settlement.save(saveInput(fx.ownStoreId, managerDay, 0));
    const cashierCorrectionInput = saveInput(fx.ownStoreId, managerDay, managerClose.version, {
      onlineRevenue: '101',
      correctionReason: 'Corrected transfer receipt',
    }) as Record<string, unknown>;
    // An unrelated cashier correction keeps the exact existing expense JSON.
    delete cashierCorrectionInput.operatingExpenseItems;
    const cashierCorrection = await fx.cashierCaller.settlement.save(
      cashierCorrectionInput as SettlementSaveInput,
    );
    expect(cashierCorrection.onlineRevenue).toBe('101.00');
    expect(cashierCorrection.operatingExpenseItems).toEqual(managerClose.operatingExpenseItems);

    // The cashier may also change expenses a manager recorded earlier.
    const changedExpense = await fx.cashierCaller.settlement.save(
      saveInput(fx.ownStoreId, managerDay, cashierCorrection.version, {
        operatingExpenses: '10',
        operatingExpenseItems: [{ amount: '10', reason: 'Cashier expense correction' }],
        correctionReason: 'Corrected expense receipt',
      }),
    );
    expect(changedExpense.operatingExpenses).toBe('10.00');
    expect(changedExpense.operatingExpenseItems).toEqual([
      expect.objectContaining({ amount: '10.00', reason: 'Cashier expense correction' }),
    ]);
  });

  test('a manager-rank member without effective settlement.record cannot save operating expenses', async () => {
    const fx = fixture!;
    const date = freshDate();
    const error = await errorOf(() =>
      fx.caller.settlement.save(
        saveInput(fx.assignedNoPermissionStoreId, date, 0, {
          wagesPaid: '0',
          wagesAccrued: '0',
          wageItems: [],
        }),
      ),
    );
    expect(error?.code).toBe('FORBIDDEN');
    expect(error?.message).toBe('auth.errors.missingPermission');
    const raw = await getDb(undefined, {
      system: 'maintenance',
    }).query.storeDailySettlements.findFirst({
      where: (row, { and: and2, eq: eq2 }) =>
        and2(eq2(row.storeId, fx.assignedNoPermissionStoreId), eq2(row.settlementDate, date)),
    });
    expect(raw).toBeUndefined();
  });

  test('rejects a forged wage recipient and resolves the selected employee name server-side', async () => {
    const fx = fixture!;
    const error = await errorOf(() =>
      fx.caller.settlement.save(
        saveInput(fx.ownStoreId, freshDate(), 0, {
          operatingExpenses: '0',
          operatingExpenseItems: [],
          wagesPaid: '20',
          wagesAccrued: '0',
          wageItems: [
            {
              memberId: fx.foreignEmployeeMemberId,
              personName: 'Forged local employee name',
              status: 'paid',
              amount: '20',
              reason: 'Daily shift',
            },
          ],
        }),
      ),
    );
    expect(error?.code).toBe('BAD_REQUEST');
    expect(error?.message).toBe('settlement.errors.employeeNotInStore');

    const saved = await fx.caller.settlement.save(
      saveInput(fx.ownStoreId, freshDate(), 0, {
        operatingExpenses: '0',
        operatingExpenseItems: [],
        wagesPaid: '20',
        wagesAccrued: '0',
        wageItems: [
          {
            memberId: fx.wageEmployeeMemberId,
            personName: 'Forged local employee name',
            status: 'paid',
            amount: '20',
            reason: 'Daily shift',
          },
        ],
      }),
    );
    expect(saved.wageItems[0]).toEqual(
      expect.objectContaining({ memberId: fx.wageEmployeeMemberId, personName: 'Ali Kitchen' }),
    );
  });

  test('preserves a linked wage snapshot when that employee is later renamed or suspended', async () => {
    const fx = fixture!;
    const db = getDb(undefined, { system: 'maintenance' });
    const [employeeUser] = await db
      .insert(s.users)
      .values({
        displayName: 'Historical Wage Employee',
        tgUserId: freshTgId(),
      })
      .returning();
    noteUser(employeeUser!.id);
    const [employee] = await db
      .insert(s.members)
      .values({ orgId: fx.orgId, userId: employeeUser!.id, status: 'active' })
      .returning();
    await db.insert(s.memberStoreAssignments).values({
      memberId: employee!.id,
      storeId: fx.ownStoreId,
    });

    const date = freshDate();
    const created = await fx.caller.settlement.save(
      saveInput(fx.ownStoreId, date, 0, {
        wagesPaid: '20',
        wagesAccrued: '0',
        wageItems: [
          {
            memberId: employee!.id,
            status: 'paid',
            amount: '20',
            reason: 'Historical shift',
          },
        ],
      }),
    );
    const wageId = created.wageItems[0]!.id!;
    await db
      .update(s.users)
      .set({ displayName: 'Renamed After Payment' })
      .where(eq(s.users.id, employeeUser!.id));
    await db.update(s.members).set({ status: 'suspended' }).where(eq(s.members.id, employee!.id));

    const corrected = await fx.caller.settlement.save(
      saveInput(fx.ownStoreId, date, created.version, {
        wagesPaid: '21',
        wagesAccrued: '0',
        wageItems: [
          {
            id: wageId,
            memberId: employee!.id,
            status: 'paid',
            amount: '21',
            reason: 'Corrected historical shift',
          },
        ],
        correctionReason: 'Corrected historical payroll amount',
      }),
    );
    expect(corrected.wageItems[0]).toEqual(
      expect.objectContaining({
        id: wageId,
        memberId: employee!.id,
        personName: 'Historical Wage Employee',
        amount: '21.00',
      }),
    );
  });

  test('creates, reads, and audits one store-scoped daily settlement', async () => {
    const fx = fixture!;
    const date = freshDate();
    expect(await fx.caller.settlement.get({ storeId: fx.ownStoreId, date })).toBeNull();

    const created = await fx.caller.settlement.save(saveInput(fx.ownStoreId, date, 0));
    expect(created.version).toBe(1);
    expect(created.onlineRevenue).toBe('100.00');
    expect(created.operatingExpenses).toBe('10.00');
    expect(created.wagesPaid).toBe('20.00');
    expect(created.wagesAccrued).toBe('5.00');
    expect(created.operatingExpenseItems).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        amount: '6.25',
        reason: 'Fuel for the kitchen',
        isHistorical: false,
      }),
      expect.objectContaining({
        id: expect.any(String),
        amount: '3.75',
        reason: 'Collected market supplies',
        isHistorical: false,
      }),
    ]);
    expect(created.wageItems).toEqual([
      expect.objectContaining({
        memberId: fx.wageEmployeeMemberId,
        personName: 'Ali Kitchen',
        status: 'paid',
        amount: '20.00',
        reason: 'Daily kitchen shift',
        isHistorical: false,
      }),
      expect.objectContaining({
        memberId: fx.wageEmployeeMemberId,
        personName: 'Ali Kitchen',
        status: 'unpaid',
        amount: '5.00',
        reason: 'Ten-day payroll period',
        isHistorical: false,
      }),
    ]);
    expect(created.operatingExpenseItems[0]).not.toHaveProperty('enteredByMemberId');
    expect(created.actorName).toBe('Settlement Manager');
    expect(Number.isNaN(Date.parse(created.updatedAt))).toBe(false);

    const read = await fx.caller.settlement.get({
      storeId: fx.ownStoreId,
      date,
    });
    expect(read?.id).toBe(created.id);
    expect(read?.updatedByName).toBe('Settlement Manager');

    const revisions = await getDb(undefined, { system: 'maintenance' })
      .select()
      .from(s.storeDailySettlementRevisions)
      .where(eq(s.storeDailySettlementRevisions.settlementId, created.id));
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.version).toBe(1);
    const snapshot = revisions[0]?.snapshot as {
      operatingExpenseItems?: Array<{ enteredByMemberId?: string; amount: string; reason: string }>;
      wageItems?: Array<{ memberId?: string; personName?: string }>;
    };
    expect(snapshot.operatingExpenseItems?.[0]).toEqual(
      expect.objectContaining({
        amount: '6.25',
        reason: 'Fuel for the kitchen',
        enteredByMemberId: fx.memberId,
      }),
    );
    expect(snapshot.wageItems?.[0]).toEqual(
      expect.objectContaining({ memberId: fx.wageEmployeeMemberId, personName: 'Ali Kitchen' }),
    );
    expect(revisions[0]?.actorMemberId).toBe(fx.memberId);
  });

  test('derives outflow totals from itemized rows and versions detail corrections', async () => {
    const fx = fixture!;
    const date = freshDate();

    const mismatch = await errorOf(() =>
      fx.caller.settlement.save(saveInput(fx.ownStoreId, date, 0, { operatingExpenses: '11' })),
    );
    expect(mismatch?.code).toBe('BAD_REQUEST');
    expect(mismatch?.message).toBe('settlement.errors.totalMismatch');
    expect(await fx.caller.settlement.get({ storeId: fx.ownStoreId, date })).toBeNull();

    const created = await fx.caller.settlement.save(saveInput(fx.ownStoreId, date, 0));
    const correctedExpenseItems = [
      {
        id: created.operatingExpenseItems[0]!.id!,
        amount: '5',
        reason: 'Corrected kitchen gas receipt',
      },
      {
        id: created.operatingExpenseItems[1]!.id!,
        amount: '5',
        reason: 'Collected market supplies',
      },
    ];

    const missingReason = await errorOf(() =>
      fx.caller.settlement.save(
        saveInput(fx.ownStoreId, date, created.version, {
          operatingExpenseItems: correctedExpenseItems,
        }),
      ),
    );
    expect(missingReason?.code).toBe('BAD_REQUEST');
    expect(missingReason?.message).toBe('settlement.errors.correctionReasonRequired');

    const corrected = await fx.caller.settlement.save(
      saveInput(fx.ownStoreId, date, created.version, {
        operatingExpenseItems: correctedExpenseItems,
        correctionReason: 'Corrected the detailed gas receipt',
      }),
    );
    expect(corrected.version).toBe(2);
    expect(corrected.operatingExpenses).toBe('10.00');
    expect(corrected.operatingExpenseItems[0]?.reason).toBe('Corrected kitchen gas receipt');
    expect(corrected.operatingExpenseItems[0]?.id).toBe(created.operatingExpenseItems[0]?.id);

    const revisions = await getDb(undefined, { system: 'maintenance' })
      .select()
      .from(s.storeDailySettlementRevisions)
      .where(eq(s.storeDailySettlementRevisions.settlementId, created.id));
    expect(revisions.map((revision) => revision.version).sort()).toEqual([1, 2]);
    const originalSnapshot = revisions.find((revision) => revision.version === 1)?.snapshot as {
      operatingExpenseItems?: Array<{ reason: string }>;
    };
    const correctedSnapshot = revisions.find((revision) => revision.version === 2)?.snapshot as {
      operatingExpenseItems?: Array<{
        id?: string;
        reason: string;
        enteredByMemberId?: string;
      }>;
    };
    expect(revisions.find((revision) => revision.version === 2)?.changedFields).toEqual(
      expect.arrayContaining(['operatingExpenseItems']),
    );
    expect(originalSnapshot.operatingExpenseItems?.[0]?.reason).toBe('Fuel for the kitchen');
    expect(correctedSnapshot.operatingExpenseItems?.[0]?.reason).toBe(
      'Corrected kitchen gas receipt',
    );
    expect(correctedSnapshot.operatingExpenseItems?.[0]).toEqual(
      expect.objectContaining({
        id: created.operatingExpenseItems[0]?.id,
        enteredByMemberId: fx.memberId,
      }),
    );

    // CLS-20: the same history, readable through the API.
    const history = await fx.caller.settlement.revisions({ settlementId: created.id });
    expect(history.map((rev) => rev.version)).toEqual([2, 1]);
    expect(history[0]?.changedFields).toContain('operatingExpenseItems');
    expect(history[0]?.correctionReason).toBeTruthy();
    expect(history[0]?.actorName).toBeTruthy();
  });

  test('keeps each operating-expense recorder when another manager adds a row', async () => {
    const fx = fixture!;
    const date = freshDate();
    const created = await fx.caller.settlement.save(saveInput(fx.ownStoreId, date, 0));
    const updated = await fx.secondManagerCaller.settlement.save(
      saveInput(fx.ownStoreId, date, created.version, {
        operatingExpenses: '12',
        operatingExpenseItems: [
          {
            id: created.operatingExpenseItems[0]!.id!,
            amount: '6.25',
            reason: 'Fuel for the kitchen',
          },
          {
            id: created.operatingExpenseItems[1]!.id!,
            amount: '3.75',
            reason: 'Collected market supplies',
          },
          { amount: '2', reason: 'Emergency delivery fare' },
        ],
        correctionReason: 'Added the delivery fare receipt',
      }),
    );
    expect(updated.operatingExpenseItems[0]?.id).toBe(created.operatingExpenseItems[0]?.id);
    expect(updated.operatingExpenseItems[2]).not.toHaveProperty('enteredByMemberId');

    const revision = await getDb(undefined, { system: 'maintenance' }).query.storeDailySettlementRevisions.findFirst({
      where: (row, { and: and2, eq: eq2 }) =>
        and2(eq2(row.settlementId, created.id), eq2(row.version, 2)),
    });
    const items = (
      revision?.snapshot as {
        operatingExpenseItems?: Array<{ id?: string; enteredByMemberId?: string; reason: string }>;
      }
    ).operatingExpenseItems;
    expect(items?.[0]).toEqual(
      expect.objectContaining({
        id: created.operatingExpenseItems[0]?.id,
        enteredByMemberId: fx.memberId,
      }),
    );
    expect(items?.[2]).toEqual(
      expect.objectContaining({
        reason: 'Emergency delivery fare',
        enteredByMemberId: fx.secondManagerMemberId,
      }),
    );
    expect(revision?.actorMemberId).toBe(fx.secondManagerMemberId);
  });

  test('requires detail for new non-zero outflows but tolerates an unchanged older-client re-save', async () => {
    const fx = fixture!;
    const date = freshDate();
    const input = saveInput(fx.ownStoreId, date, 0) as Record<string, unknown>;
    delete input.operatingExpenseItems;
    delete input.wageItems;

    const missingDetails = await errorOf(() =>
      fx.caller.settlement.save(input as SettlementSaveInput),
    );
    expect(missingDetails?.code).toBe('BAD_REQUEST');
    expect(missingDetails?.message).toBe('settlement.errors.invalidDetails');
    expect(await fx.caller.settlement.get({ storeId: fx.ownStoreId, date })).toBeNull();

    const olderClientDate = freshDate();
    const created = await fx.caller.settlement.save(saveInput(fx.ownStoreId, olderClientDate, 0));
    const unchangedOlderClientInput = saveInput(
      fx.ownStoreId,
      olderClientDate,
      created.version,
    ) as Record<string, unknown>;
    delete unchangedOlderClientInput.operatingExpenseItems;
    delete unchangedOlderClientInput.wageItems;

    const noOp = await fx.caller.settlement.save(unchangedOlderClientInput as SettlementSaveInput);
    expect(noOp.version).toBe(1);
    expect(noOp.operatingExpenseItems).toEqual(created.operatingExpenseItems);
    expect(noOp.wageItems).toEqual(created.wageItems);
  });

  test('preserves raw legacy totals when an unrelated field is corrected', async () => {
    const fx = fixture!;
    const date = freshDate();
    const [legacy] = await getDb(undefined, { system: 'maintenance' })
      .insert(s.storeDailySettlements)
      .values({
        orgId: fx.orgId,
        storeId: fx.ownStoreId,
        settlementDate: date,
        onlineRevenue: '100',
        operatingExpenses: '3',
        createdByMemberId: fx.memberId,
        updatedByMemberId: fx.memberId,
      })
      .returning();
    const input = saveInput(fx.ownStoreId, date, legacy!.version, {
      onlineRevenue: '101',
      operatingExpenses: '3',
      wagesPaid: '0',
      wagesAccrued: '0',
      correctionReason: 'Corrected transfer total only',
    }) as Record<string, unknown>;
    delete input.operatingExpenseItems;
    delete input.wageItems;

    const corrected = await fx.caller.settlement.save(input as SettlementSaveInput);
    expect(corrected.onlineRevenue).toBe('101.00');
    expect(corrected.operatingExpenseItems).toEqual([
      expect.objectContaining({ amount: '3.00', isHistorical: true }),
    ]);

    const raw = await getDb(undefined, { system: 'maintenance' }).query.storeDailySettlements.findFirst({
      where: (row, { eq: eq2 }) => eq2(row.id, legacy!.id),
    });
    expect(raw?.operatingExpenseItems).toEqual([]);
    const revision = await getDb(undefined, { system: 'maintenance' }).query.storeDailySettlementRevisions.findFirst({
      where: (row, { and: and2, eq: eq2 }) =>
        and2(eq2(row.settlementId, legacy!.id), eq2(row.version, 2)),
    });
    expect(
      (revision?.snapshot as { operatingExpenseItems?: unknown } | undefined)
        ?.operatingExpenseItems,
    ).toEqual([]);
  });

  test('does not let anyone, including a cashier, clear a legacy scalar-only operating expense', async () => {
    const fx = fixture!;
    const date = freshDate();
    const [legacy] = await getDb(undefined, { system: 'maintenance' })
      .insert(s.storeDailySettlements)
      .values({
        orgId: fx.orgId,
        storeId: fx.ownStoreId,
        settlementDate: date,
        onlineRevenue: '100',
        operatingExpenses: '3',
        createdByMemberId: fx.memberId,
        updatedByMemberId: fx.memberId,
      })
      .returning();

    const error = await errorOf(() =>
      fx.cashierCaller.settlement.save(
        saveInput(fx.ownStoreId, date, legacy!.version, {
          operatingExpenses: '0',
          operatingExpenseItems: [],
          wagesPaid: '0',
          wagesAccrued: '0',
          wageItems: [],
          correctionReason: 'Attempted to clear historical expense',
        }),
      ),
    );
    // The rank gate is gone; the historical-total immutability rule still
    // applies to every recorder.
    expect(error?.code).toBe('BAD_REQUEST');
    expect(error?.message).toBe('settlement.errors.historicalTotalImmutable');
    expect((error?.cause as { reason?: string } | undefined)?.reason).toBe(
      'historical-total-immutable',
    );

    const raw = await getDb(undefined, { system: 'maintenance' }).query.storeDailySettlements.findFirst({
      where: (row, { eq: eq2 }) => eq2(row.id, legacy!.id),
    });
    expect(raw?.operatingExpenses).toBe('3.00');
    expect(raw?.operatingExpenseItems).toEqual([]);
  });

  test('does not backfill or newly attribute total-only historical outflows', async () => {
    const fx = fixture!;
    const date = freshDate();
    const [legacy] = await getDb(undefined, { system: 'maintenance' })
      .insert(s.storeDailySettlements)
      .values({
        orgId: fx.orgId,
        storeId: fx.ownStoreId,
        settlementDate: date,
        onlineRevenue: '100',
        operatingExpenses: '3',
        wagesPaid: '4',
        createdByMemberId: fx.memberId,
        updatedByMemberId: fx.memberId,
      })
      .returning();

    const expenseError = await errorOf(() =>
      fx.caller.settlement.save(
        saveInput(fx.ownStoreId, date, legacy!.version, {
          operatingExpenses: '4',
          operatingExpenseItems: [
            { amount: '3', reason: 'Attempted historical backfill' },
            { amount: '1', reason: 'Attempted newly entered expense' },
          ],
          wagesPaid: '4',
          wagesAccrued: '0',
          wageItems: [],
          correctionReason: 'Attempted to itemize a historical total',
        }),
      ),
    );
    expect(expenseError?.code).toBe('BAD_REQUEST');
    expect(expenseError?.message).toBe('settlement.errors.historicalTotalImmutable');

    const wageInput = saveInput(fx.ownStoreId, date, legacy!.version, {
      operatingExpenses: '3',
      wagesPaid: '4',
      wagesAccrued: '0',
      wageItems: [
        {
          memberId: fx.wageEmployeeMemberId,
          status: 'paid',
          amount: '4',
          reason: 'Attempted historical wage backfill',
        },
      ],
      correctionReason: 'Attempted to itemize a historical wage total',
    }) as Record<string, unknown>;
    delete wageInput.operatingExpenseItems;

    const wageError = await errorOf(() =>
      fx.caller.settlement.save(wageInput as SettlementSaveInput),
    );
    expect(wageError?.code).toBe('BAD_REQUEST');
    expect(wageError?.message).toBe('settlement.errors.historicalTotalImmutable');

    const raw = await getDb(undefined, { system: 'maintenance' }).query.storeDailySettlements.findFirst({
      where: (row, { eq: eq2 }) => eq2(row.id, legacy!.id),
    });
    expect(raw?.operatingExpenses).toBe('3.00');
    expect(raw?.operatingExpenseItems).toEqual([]);
    expect(raw?.wagesPaid).toBe('4.00');
    expect(raw?.wageItems).toEqual([]);
  });

  test('requires a correction reason, preserves no-ops, and rejects stale versions', async () => {
    const fx = fixture!;
    const date = freshDate();
    const created = await fx.caller.settlement.save(saveInput(fx.ownStoreId, date, 0));

    // Same values are idempotent even without a reason and do not bump version.
    const noOp = await fx.caller.settlement.save(saveInput(fx.ownStoreId, date, created.version));
    expect(noOp.version).toBe(1);

    const missingReason = await errorOf(() =>
      fx.caller.settlement.save(saveInput(fx.ownStoreId, date, 1, { onlineRevenue: '101' })),
    );
    expect(missingReason?.code).toBe('BAD_REQUEST');
    expect(missingReason?.message).toBe('settlement.errors.correctionReasonRequired');

    const updated = await fx.caller.settlement.save(
      saveInput(fx.ownStoreId, date, 1, {
        onlineRevenue: '101',
        correctionReason: 'Corrected closing total',
      }),
    );
    expect(updated.version).toBe(2);
    expect(updated.onlineRevenue).toBe('101.00');

    const stale = await errorOf(() =>
      fx.caller.settlement.save(
        saveInput(fx.ownStoreId, date, 1, {
          onlineRevenue: '102',
          correctionReason: 'Stale edit',
        }),
      ),
    );
    expect(stale?.code).toBe('CONFLICT');
  });

  test('rejects get, recent, and save for a store outside the actor scope', async () => {
    const fx = fixture!;
    const date = freshDate();
    for (const call of [
      () => fx.caller.settlement.businessDate({ storeId: fx.foreignStoreId }),
      () => fx.caller.settlement.get({ storeId: fx.foreignStoreId, date }),
      () => fx.caller.settlement.recent({ storeId: fx.foreignStoreId }),
      () => fx.caller.settlement.save(saveInput(fx.foreignStoreId, date, 0)),
    ]) {
      const error = await errorOf(() => call());
      expect(error?.code).toBe('FORBIDDEN');
      expect(error?.message).toContain('notAssignedToStore');
    }
  });

  test('rejects an assigned store where settlement.record is not effective', async () => {
    const fx = fixture!;
    const error = await errorOf(() =>
      fx.caller.settlement.businessDate({
        storeId: fx.assignedNoPermissionStoreId,
      }),
    );
    expect(error?.code).toBe('FORBIDDEN');
    expect(error?.message).toContain('missingPermission');
  });

  test('keeps archived-store history readable but blocks saves', async () => {
    const fx = fixture!;
    const historical = await fx.caller.settlement.get({
      storeId: fx.inactiveStoreId,
      date: fx.archivedCloseDate,
    });
    expect(historical?.onlineRevenue).toBe('1.00');
    expect(historical?.operatingExpenseItems).toEqual([
      expect.objectContaining({
        amount: '3.00',
        isHistorical: true,
      }),
    ]);
    expect(historical?.wageItems).toEqual([
      expect.objectContaining({
        personName: 'Unspecified recipient (historical total)',
        status: 'paid',
        amount: '4.00',
        memberId: null,
        isHistorical: true,
      }),
      expect.objectContaining({
        personName: 'Unspecified recipient (historical total)',
        status: 'unpaid',
        amount: '5.00',
        memberId: null,
        isHistorical: true,
      }),
    ]);

    const error = await errorOf(() =>
      fx.caller.settlement.save(saveInput(fx.inactiveStoreId, freshDate(), 0)),
    );
    expect(error?.code).toBe('PRECONDITION_FAILED');
  });

  test('CLS-14: a new close more than 90 days back is refused', async () => {
    const fx = fixture!;
    const storeId = await storeOfItsOwn('CLS-14 store');
    const old = dayBack(95);
    const error = await errorOf(() => fx.caller.settlement.save(saveInput(storeId, old, 0)));
    expect(error?.message).toBe('settlement.errors.dateTooOld');
    const recent = await fx.caller.settlement.save(saveInput(storeId, dayBack(60), 0));
    expect(recent.version).toBe(1);
  });

  test('CLS-14: exactly 90 days back is the oldest new close', async () => {
    // Review TEST2-14: the edge, in a store where it is midday, so its
    // today is the server's while the test runs.
    const fx = fixture!;
    const zone = middayZone(new Date());
    const storeId = await storeOfItsOwn('CLS-14 edge store', zone);
    const today = todayInTz(zone);
    const tooOld = nextDate(today, -(BACKDATE_LIMIT_DAYS + 1));
    const error = await errorOf(() => fx.caller.settlement.save(saveInput(storeId, tooOld, 0)));
    expect(error?.message).toBe('settlement.errors.dateTooOld');
    const oldest = nextDate(today, -BACKDATE_LIMIT_DAYS);
    expect((await fx.caller.settlement.save(saveInput(storeId, oldest, 0))).version).toBe(1);
  });

  test('recent is date-descending and beforeDate is an exclusive cursor', async () => {
    const fx = fixture!;
    const storeId = await storeOfItsOwn('Recent store');
    // Four days, newest first. Closed out of order, so the answer's order
    // is the query's.
    const first = freshDate();
    const second = freshDate();
    const third = freshDate();
    const fourth = freshDate();
    for (const day of [second, first, fourth, third]) {
      await fx.caller.settlement.save(saveInput(storeId, day, 0));
    }

    const recent = await fx.caller.settlement.recent({ storeId, limit: 2 });
    expect(recent.map((row) => row.date)).toEqual([first, second]);

    // Not the cursor's own day; the latest close before it.
    const prior = await fx.caller.settlement.recent({ storeId, beforeDate: third, limit: 1 });
    expect(prior.map((row) => row.date)).toEqual([fourth]);
  });

  test('CONF-26: a save is pushed to the workspace; a no-op or refused one is not', async () => {
    const fx = fixture!;
    const date = freshDate();
    const pushes: unknown[] = [];
    const unsubscribe = hub.subscribe(fx.orgId, (data) => {
      const message = JSON.parse(data) as { type?: string };
      if (message.type === 'settlement.changed') pushes.push(message);
    });
    try {
      const created = await fx.caller.settlement.save(saveInput(fx.ownStoreId, date, 0));
      expect(pushes).toEqual([
        { type: 'settlement.changed', orgId: fx.orgId, storeId: fx.ownStoreId },
      ]);

      await fx.caller.settlement.save(saveInput(fx.ownStoreId, date, created.version));
      const stale = await errorOf(() =>
        fx.caller.settlement.save(
          saveInput(fx.ownStoreId, date, 0, {
            onlineRevenue: '5',
            correctionReason: 'Edit from an old screen',
          }),
        ),
      );
      expect(stale?.code).toBe('CONFLICT');
      expect(pushes).toHaveLength(1);

      await fx.caller.settlement.save(
        saveInput(fx.ownStoreId, date, created.version, {
          onlineRevenue: '5',
          correctionReason: 'Corrected online total',
        }),
      );
      expect(pushes).toHaveLength(2);
    } finally {
      unsubscribe();
    }
  });

  test('CONF-26: the history lists each version with the fields it changed', async () => {
    const fx = fixture!;
    const date = freshDate();
    const created = await fx.caller.settlement.save(saveInput(fx.ownStoreId, date, 0));
    await fx.caller.settlement.save(
      saveInput(fx.ownStoreId, date, created.version, {
        cashOnHand: '7',
        correctionReason: 'Recounted the till',
      }),
    );
    const history = await fx.caller.settlement.revisions({ settlementId: created.id });
    expect(history.map((row) => row.version)).toEqual([2, 1]);
    expect(history[0]!.changedFields).toEqual(['cashOnHand']);
    expect(history[1]!.changedFields.length).toBeGreaterThan(1);
  });
});
