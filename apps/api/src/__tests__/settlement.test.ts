import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import type { SettlementSaveInput } from '@compass/contracts';
import { getDb, schema as s, withOrgContext } from '@compass/db';
import { todayInTz } from '@compass/domain';
import { logger } from '../infra/log';
import { appRouter } from '../trpc/router';
import type { RequestContext, SessionContext } from '../trpc/context';
import { normalizeSettlementMoney } from '../trpc/routers/settlement';

(function loadEnv() {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate) && existsSync(resolve(dir, 'pnpm-workspace.yaml'))) {
      for (const raw of readFileSync(candidate, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const idx = line.indexOf('=');
        if (idx < 0) continue;
        const key = line.slice(0, idx).trim();
        const value = line
          .slice(idx + 1)
          .trim()
          .replace(/^"(.*)"$/, '$1');
        if (!(key in process.env)) process.env[key] = value;
      }
      return;
    }
    dir = resolve(dir, '..');
  }
})();

const SHOULD_RUN = !!process.env.DATABASE_URL && process.env.SKIP_PG_TESTS !== '1';

describe('daily settlement money normalization', () => {
  test('normalizes equivalent decimal inputs and signed zero', () => {
    expect(normalizeSettlementMoney('10')).toBe('10.00');
    expect(normalizeSettlementMoney('0010.5')).toBe('10.50');
    expect(normalizeSettlementMoney('-12.3')).toBe('-12.30');
    expect(normalizeSettlementMoney('-0')).toBe('0.00');
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
  ownStoreId: string;
  foreignStoreId: string;
  managerElsewhereStoreId: string;
  assignedNoPermissionStoreId: string;
  inactiveStoreId: string;
  caller: ReturnType<typeof appRouter.createCaller>;
  cashierCaller: ReturnType<typeof appRouter.createCaller>;
  secondManagerMemberId: string;
  secondManagerCaller: ReturnType<typeof appRouter.createCaller>;
  orgAdminOverrideCaller: ReturnType<typeof appRouter.createCaller>;
}

let fixture: Fixture | null = null;

function buildCtx(session: SessionContext): RequestContext {
  const db = getDb();
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hono: {} as any,
    db,
    log: logger,
    traceId: `settlement-test-${Date.now()}`,
    ip: null,
    userAgent: null,
    idempotencyKey: null,
    session,
    async withOrg(fn, options) {
      return withOrgContext(db, session.orgId, fn, options);
    },
  };
}

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
  const db = getDb();
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
  const [user] = await db
    .insert(s.users)
    .values({
      displayName: 'Settlement Manager',
      tgUserId: BigInt(`7${Date.now()}`.slice(-12)),
    })
    .returning();
  const [member] = await db
    .insert(s.members)
    .values({ orgId: org!.id, userId: user!.id, status: 'active' })
    .returning();
  const [cashierUser] = await db
    .insert(s.users)
    .values({
      displayName: 'Settlement Cashier',
      tgUserId: BigInt(`8${Date.now()}`.slice(-12)),
    })
    .returning();
  const [cashierMember] = await db
    .insert(s.members)
    .values({ orgId: org!.id, userId: cashierUser!.id, status: 'active' })
    .returning();
  const [secondManagerUser] = await db
    .insert(s.users)
    .values({
      displayName: 'Second Settlement Manager',
      tgUserId: BigInt(`4${Date.now()}`.slice(-12)),
    })
    .returning();
  const [secondManagerMember] = await db
    .insert(s.members)
    .values({ orgId: org!.id, userId: secondManagerUser!.id, status: 'active' })
    .returning();
  const [orgAdminOverrideUser] = await db
    .insert(s.users)
    .values({
      displayName: 'Global Admin Override',
      tgUserId: BigInt(`2${Date.now()}`.slice(-12)),
    })
    .returning();
  const [orgAdminOverrideMember] = await db
    .insert(s.members)
    .values({ orgId: org!.id, userId: orgAdminOverrideUser!.id, status: 'active' })
    .returning();
  const [wageEmployeeUser] = await db
    .insert(s.users)
    .values({
      displayName: 'Ali Kitchen',
      tgUserId: BigInt(`9${Date.now()}`.slice(-12)),
    })
    .returning();
  const [wageEmployee] = await db
    .insert(s.members)
    .values({ orgId: org!.id, userId: wageEmployeeUser!.id, status: 'active' })
    .returning();
  const [assignedOnlyEmployeeUser] = await db
    .insert(s.users)
    .values({
      displayName: 'Assigned Only Employee',
      tgUserId: BigInt(`5${Date.now()}`.slice(-12)),
    })
    .returning();
  const [assignedOnlyEmployee] = await db
    .insert(s.members)
    .values({ orgId: org!.id, userId: assignedOnlyEmployeeUser!.id, status: 'active' })
    .returning();
  const [foreignEmployeeUser] = await db
    .insert(s.users)
    .values({
      displayName: 'Foreign Employee',
      tgUserId: BigInt(`6${Date.now()}`.slice(-12)),
    })
    .returning();
  const [foreignEmployee] = await db
    .insert(s.members)
    .values({ orgId: org!.id, userId: foreignEmployeeUser!.id, status: 'active' })
    .returning();
  const [suspendedUser] = await db
    .insert(s.users)
    .values({ displayName: 'Suspended Employee' })
    .returning();
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
      // This member remains below manager rank. The global org.admin
      // override below is what makes them higher authority for all stores.
      memberId: orgAdminOverrideMember!.id,
      roleId: cashierRole!.id,
      scopeType: 'global',
    },
    // Same person is a manager in another store. This proves a flattened
    // session role set cannot unlock operating expenses in their cashier store.
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
  await db.insert(s.storeDailySettlements).values({
    orgId: org!.id,
    storeId: inactiveStore!.id,
    settlementDate: '2026-07-31',
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
    // different store. Store-scoped authorization must still use cashier rank
    // for Own Store.
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
    ownStoreId: ownStore!.id,
    foreignStoreId: foreignStore!.id,
    managerElsewhereStoreId: managerElsewhereStore!.id,
    assignedNoPermissionStoreId: assignedNoPermissionStore!.id,
    inactiveStoreId: inactiveStore!.id,
    caller: appRouter.createCaller(buildCtx(session)),
    cashierCaller: appRouter.createCaller(buildCtx(cashierSession)),
    secondManagerMemberId: secondManagerMember!.id,
    secondManagerCaller: appRouter.createCaller(buildCtx(secondManagerSession)),
    orgAdminOverrideCaller: appRouter.createCaller(buildCtx(orgAdminOverrideSession)),
  };
});

describe.skipIf(!SHOULD_RUN)('daily settlement API (PG-gated)', () => {
  test('returns the selected store authoritative business date and timezone', async () => {
    const fx = fixture!;
    const businessDate = await fx.caller.settlement.businessDate({
      storeId: fx.ownStoreId,
    });
    expect(businessDate).toEqual({
      storeId: fx.ownStoreId,
      date: todayInTz('Pacific/Kiritimati'),
      timezone: 'Pacific/Kiritimati',
      canRecordOperatingExpenses: true,
    });
    expect(
      (await fx.cashierCaller.settlement.businessDate({ storeId: fx.ownStoreId }))
        .canRecordOperatingExpenses,
    ).toBe(false);
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
      saveInput(fx.foreignStoreId, '2026-07-17', 0, {
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
    expect(Object.keys(employee ?? {})).toEqual(['memberId', 'displayName', 'roles']);

    let error: unknown;
    try {
      await fx.cashierCaller.settlement.wageRoster({ storeId: fx.foreignStoreId });
    } catch (caught) {
      error = caught;
    }
    expect((error as { code?: string }).code).toBe('FORBIDDEN');
  });

  test('cashiers can close revenue and wages but cannot create or change operating expenses', async () => {
    const fx = fixture!;
    const zeroExpense = await fx.cashierCaller.settlement.save(
      saveInput(fx.ownStoreId, '2026-07-27', 0, {
        operatingExpenses: '0',
        operatingExpenseItems: [],
      }),
    );
    expect(zeroExpense.operatingExpenses).toBe('0.00');

    let createExpenseError: unknown;
    try {
      await fx.cashierCaller.settlement.save(saveInput(fx.ownStoreId, '2026-07-26', 0));
    } catch (caught) {
      createExpenseError = caught;
    }
    expect((createExpenseError as { code?: string }).code).toBe('FORBIDDEN');
    expect((createExpenseError as Error).message).toBe('settlement.errors.expensesManagerOnly');

    const managerClose = await fx.caller.settlement.save(saveInput(fx.ownStoreId, '2026-07-25', 0));
    const cashierCorrectionInput = saveInput(fx.ownStoreId, '2026-07-25', managerClose.version, {
      onlineRevenue: '101',
      correctionReason: 'Corrected transfer receipt',
    }) as Record<string, unknown>;
    // An unrelated cashier correction keeps the exact existing expense JSON.
    delete cashierCorrectionInput.operatingExpenseItems;
    const cashierCorrection = await fx.cashierCaller.settlement.save(
      cashierCorrectionInput as SettlementSaveInput,
    );
    expect(cashierCorrection.onlineRevenue).toBe('101.00');

    let changedExpenseError: unknown;
    try {
      await fx.cashierCaller.settlement.save(
        saveInput(fx.ownStoreId, '2026-07-25', cashierCorrection.version, {
          operatingExpenseItems: [{ amount: '10', reason: 'Attempted cashier change' }],
          correctionReason: 'Attempted expense correction',
        }),
      );
    } catch (caught) {
      changedExpenseError = caught;
    }
    expect((changedExpenseError as { code?: string }).code).toBe('FORBIDDEN');
  });

  test('rejects a forged wage recipient and resolves the selected employee name server-side', async () => {
    const fx = fixture!;
    let error: unknown;
    try {
      await fx.caller.settlement.save(
        saveInput(fx.ownStoreId, '2026-07-24', 0, {
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
      );
    } catch (caught) {
      error = caught;
    }
    expect((error as { code?: string }).code).toBe('BAD_REQUEST');

    const saved = await fx.caller.settlement.save(
      saveInput(fx.ownStoreId, '2026-07-23', 0, {
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
    const db = getDb();
    const [employeeUser] = await db
      .insert(s.users)
      .values({
        displayName: 'Historical Wage Employee',
        tgUserId: BigInt(`3${Date.now()}`.slice(-12)),
      })
      .returning();
    const [employee] = await db
      .insert(s.members)
      .values({ orgId: fx.orgId, userId: employeeUser!.id, status: 'active' })
      .returning();
    await db.insert(s.memberStoreAssignments).values({
      memberId: employee!.id,
      storeId: fx.ownStoreId,
    });

    const date = '2026-07-18';
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
    expect(
      await fx.caller.settlement.get({ storeId: fx.ownStoreId, date: '2026-08-01' }),
    ).toBeNull();

    const created = await fx.caller.settlement.save(saveInput(fx.ownStoreId, '2026-08-01', 0));
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
      date: '2026-08-01',
    });
    expect(read?.id).toBe(created.id);
    expect(read?.updatedByName).toBe('Settlement Manager');

    const revisions = await getDb()
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
    const date = '2026-07-30';

    let mismatch: unknown;
    try {
      await fx.caller.settlement.save(
        saveInput(fx.ownStoreId, date, 0, { operatingExpenses: '11' }),
      );
    } catch (error) {
      mismatch = error;
    }
    expect((mismatch as { code?: string }).code).toBe('BAD_REQUEST');
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

    let missingReason: unknown;
    try {
      await fx.caller.settlement.save(
        saveInput(fx.ownStoreId, date, created.version, {
          operatingExpenseItems: correctedExpenseItems,
        }),
      );
    } catch (error) {
      missingReason = error;
    }
    expect((missingReason as { code?: string }).code).toBe('BAD_REQUEST');

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

    const revisions = await getDb()
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
  });

  test('keeps each operating-expense recorder when another manager adds a row', async () => {
    const fx = fixture!;
    const date = '2026-07-20';
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

    const revision = await getDb().query.storeDailySettlementRevisions.findFirst({
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
    const date = '2026-07-29';
    const input = saveInput(fx.ownStoreId, date, 0) as Record<string, unknown>;
    delete input.operatingExpenseItems;
    delete input.wageItems;

    let missingDetails: unknown;
    try {
      await fx.caller.settlement.save(input as SettlementSaveInput);
    } catch (error) {
      missingDetails = error;
    }
    expect((missingDetails as { code?: string }).code).toBe('BAD_REQUEST');
    expect(await fx.caller.settlement.get({ storeId: fx.ownStoreId, date })).toBeNull();

    const created = await fx.caller.settlement.save(saveInput(fx.ownStoreId, '2026-07-28', 0));
    const unchangedOlderClientInput = saveInput(
      fx.ownStoreId,
      '2026-07-28',
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
    const date = '2026-07-22';
    const [legacy] = await getDb()
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

    const raw = await getDb().query.storeDailySettlements.findFirst({
      where: (row, { eq: eq2 }) => eq2(row.id, legacy!.id),
    });
    expect(raw?.operatingExpenseItems).toEqual([]);
    const revision = await getDb().query.storeDailySettlementRevisions.findFirst({
      where: (row, { and: and2, eq: eq2 }) =>
        and2(eq2(row.settlementId, legacy!.id), eq2(row.version, 2)),
    });
    expect(
      (revision?.snapshot as { operatingExpenseItems?: unknown } | undefined)
        ?.operatingExpenseItems,
    ).toEqual([]);
  });

  test('does not let a cashier clear a legacy scalar-only operating expense', async () => {
    const fx = fixture!;
    const date = '2026-07-19';
    const [legacy] = await getDb()
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

    let error: unknown;
    try {
      await fx.cashierCaller.settlement.save(
        saveInput(fx.ownStoreId, date, legacy!.version, {
          operatingExpenses: '0',
          operatingExpenseItems: [],
          wagesPaid: '0',
          wagesAccrued: '0',
          wageItems: [],
          correctionReason: 'Attempted to clear historical expense',
        }),
      );
    } catch (caught) {
      error = caught;
    }
    expect((error as { code?: string }).code).toBe('FORBIDDEN');
    expect((error as Error).message).toBe('settlement.errors.expensesManagerOnly');

    const raw = await getDb().query.storeDailySettlements.findFirst({
      where: (row, { eq: eq2 }) => eq2(row.id, legacy!.id),
    });
    expect(raw?.operatingExpenses).toBe('3.00');
    expect(raw?.operatingExpenseItems).toEqual([]);
  });

  test('does not backfill or newly attribute total-only historical outflows', async () => {
    const fx = fixture!;
    const date = '2026-07-17';
    const [legacy] = await getDb()
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

    let expenseError: unknown;
    try {
      await fx.caller.settlement.save(
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
      );
    } catch (caught) {
      expenseError = caught;
    }
    expect((expenseError as { code?: string }).code).toBe('BAD_REQUEST');

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

    let wageError: unknown;
    try {
      await fx.caller.settlement.save(wageInput as SettlementSaveInput);
    } catch (caught) {
      wageError = caught;
    }
    expect((wageError as { code?: string }).code).toBe('BAD_REQUEST');

    const raw = await getDb().query.storeDailySettlements.findFirst({
      where: (row, { eq: eq2 }) => eq2(row.id, legacy!.id),
    });
    expect(raw?.operatingExpenses).toBe('3.00');
    expect(raw?.operatingExpenseItems).toEqual([]);
    expect(raw?.wagesPaid).toBe('4.00');
    expect(raw?.wageItems).toEqual([]);
  });

  test('requires a correction reason, preserves no-ops, and rejects stale versions', async () => {
    const fx = fixture!;
    const created = await fx.caller.settlement.save(saveInput(fx.ownStoreId, '2026-08-02', 0));

    // Same values are idempotent even without a reason and do not bump version.
    const noOp = await fx.caller.settlement.save(
      saveInput(fx.ownStoreId, '2026-08-02', created.version),
    );
    expect(noOp.version).toBe(1);

    let missingReason: unknown;
    try {
      await fx.caller.settlement.save(
        saveInput(fx.ownStoreId, '2026-08-02', 1, { onlineRevenue: '101' }),
      );
    } catch (error) {
      missingReason = error;
    }
    expect((missingReason as { code?: string }).code).toBe('BAD_REQUEST');

    const updated = await fx.caller.settlement.save(
      saveInput(fx.ownStoreId, '2026-08-02', 1, {
        onlineRevenue: '101',
        correctionReason: 'Corrected closing total',
      }),
    );
    expect(updated.version).toBe(2);
    expect(updated.onlineRevenue).toBe('101.00');

    let stale: unknown;
    try {
      await fx.caller.settlement.save(
        saveInput(fx.ownStoreId, '2026-08-02', 1, {
          onlineRevenue: '102',
          correctionReason: 'Stale edit',
        }),
      );
    } catch (error) {
      stale = error;
    }
    expect((stale as { code?: string }).code).toBe('CONFLICT');
  });

  test('rejects get, recent, and save for a store outside the actor scope', async () => {
    const fx = fixture!;
    for (const call of [
      () => fx.caller.settlement.businessDate({ storeId: fx.foreignStoreId }),
      () => fx.caller.settlement.get({ storeId: fx.foreignStoreId, date: '2026-08-01' }),
      () => fx.caller.settlement.recent({ storeId: fx.foreignStoreId }),
      () => fx.caller.settlement.save(saveInput(fx.foreignStoreId, '2026-08-01', 0)),
    ]) {
      let error: unknown;
      try {
        await call();
      } catch (caught) {
        error = caught;
      }
      expect((error as { code?: string }).code).toBe('FORBIDDEN');
      expect((error as Error).message).toContain('notAssignedToStore');
    }
  });

  test('rejects an assigned store where settlement.record is not effective', async () => {
    const fx = fixture!;
    let error: unknown;
    try {
      await fx.caller.settlement.businessDate({
        storeId: fx.assignedNoPermissionStoreId,
      });
    } catch (caught) {
      error = caught;
    }
    expect((error as { code?: string }).code).toBe('FORBIDDEN');
    expect((error as Error).message).toContain('missingPermission');
  });

  test('keeps archived-store history readable but blocks saves', async () => {
    const fx = fixture!;
    const historical = await fx.caller.settlement.get({
      storeId: fx.inactiveStoreId,
      date: '2026-07-31',
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

    let error: unknown;
    try {
      await fx.caller.settlement.save(saveInput(fx.inactiveStoreId, '2026-08-01', 0));
    } catch (caught) {
      error = caught;
    }
    expect((error as { code?: string }).code).toBe('PRECONDITION_FAILED');
  });

  test('recent is date-descending and beforeDate is an exclusive cursor', async () => {
    const fx = fixture!;
    await fx.caller.settlement.save(saveInput(fx.ownStoreId, '2026-08-03', 0));
    await fx.caller.settlement.save(saveInput(fx.ownStoreId, '2026-08-04', 0));

    const recent = await fx.caller.settlement.recent({
      storeId: fx.ownStoreId,
      limit: 2,
    });
    expect(recent.map((row) => row.date)).toEqual(['2026-08-04', '2026-08-03']);

    const prior = await fx.caller.settlement.recent({
      storeId: fx.ownStoreId,
      beforeDate: '2026-08-03',
      limit: 7,
    });
    expect(prior.every((row) => row.date < '2026-08-03')).toBe(true);
  });
});
