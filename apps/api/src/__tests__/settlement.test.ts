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
  memberId: string;
  userId: string;
  ownStoreId: string;
  foreignStoreId: string;
  assignedNoPermissionStoreId: string;
  inactiveStoreId: string;
  caller: ReturnType<typeof appRouter.createCaller>;
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
        category: 'utilities',
        item: 'Kitchen gas',
        amount: '6.25',
        paidTo: 'Utility provider',
        reason: 'Fuel for the kitchen',
      },
      {
        category: 'transport',
        item: 'Market taxi',
        amount: '3.75',
        paidTo: 'Taxi driver',
        reason: 'Collected market supplies',
      },
    ],
    wageItems: [
      {
        personName: 'Ali',
        status: 'paid',
        amount: '20',
        reason: 'Daily kitchen shift',
      },
      {
        personName: 'Dilnoza',
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
      displayName: 'Settlement Cashier',
      tgUserId: BigInt(`7${Date.now()}`.slice(-12)),
    })
    .returning();
  const [member] = await db
    .insert(s.members)
    .values({ orgId: org!.id, userId: user!.id, status: 'active' })
    .returning();
  const [ownStore] = await db
    .insert(s.stores)
    .values({ orgId: org!.id, name: 'Own Store', timezone: 'Pacific/Kiritimati' })
    .returning();
  const [foreignStore] = await db
    .insert(s.stores)
    .values({ orgId: org!.id, name: 'Foreign Store' })
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
    .values({ key: 'settlement.record', description: 'Settlement tests' })
    .onConflictDoNothing();
  const [role] = await db
    .insert(s.roles)
    .values({
      orgId: org!.id,
      slug: `cashier-${suffix}`,
      name: 'Cashier',
      rank: 30,
    })
    .returning();
  await db.insert(s.rolePermissions).values({
    roleId: role!.id,
    permissionKey: 'settlement.record',
  });
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
      roleId: role!.id,
      scopeType: 'store',
      scopeId: ownStore!.id,
    },
    {
      memberId: member!.id,
      roleId: role!.id,
      scopeType: 'store',
      scopeId: inactiveStore!.id,
    },
    {
      memberId: member!.id,
      roleId: plainRole!.id,
      scopeType: 'store',
      scopeId: assignedNoPermissionStore!.id,
    },
  ]);

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
    roleSlugs: new Set([role!.slug]),
  };
  fixture = {
    orgId: org!.id,
    memberId: member!.id,
    userId: user!.id,
    ownStoreId: ownStore!.id,
    foreignStoreId: foreignStore!.id,
    assignedNoPermissionStoreId: assignedNoPermissionStore!.id,
    inactiveStoreId: inactiveStore!.id,
    caller: appRouter.createCaller(buildCtx(session)),
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
    });
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
      {
        category: 'utilities',
        item: 'Kitchen gas',
        amount: '6.25',
        paidTo: 'Utility provider',
        reason: 'Fuel for the kitchen',
      },
      {
        category: 'transport',
        item: 'Market taxi',
        amount: '3.75',
        paidTo: 'Taxi driver',
        reason: 'Collected market supplies',
      },
    ]);
    expect(created.wageItems).toEqual([
      {
        personName: 'Ali',
        status: 'paid',
        amount: '20.00',
        reason: 'Daily kitchen shift',
      },
      {
        personName: 'Dilnoza',
        status: 'unpaid',
        amount: '5.00',
        reason: 'Ten-day payroll period',
      },
    ]);
    expect(created.actorName).toBe('Settlement Cashier');
    expect(Number.isNaN(Date.parse(created.updatedAt))).toBe(false);

    const read = await fx.caller.settlement.get({
      storeId: fx.ownStoreId,
      date: '2026-08-01',
    });
    expect(read?.id).toBe(created.id);
    expect(read?.updatedByName).toBe('Settlement Cashier');

    const revisions = await getDb()
      .select()
      .from(s.storeDailySettlementRevisions)
      .where(eq(s.storeDailySettlementRevisions.settlementId, created.id));
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.version).toBe(1);
    const snapshot = revisions[0]?.snapshot as {
      operatingExpenseItems?: unknown;
      wageItems?: unknown;
    };
    expect(snapshot.operatingExpenseItems).toEqual(created.operatingExpenseItems);
    expect(snapshot.wageItems).toEqual(created.wageItems);
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
        category: 'utilities' as const,
        item: 'Kitchen gas refill',
        amount: '5',
        paidTo: 'Utility provider',
        reason: 'Fuel for the kitchen',
      },
      {
        category: 'transport' as const,
        item: 'Market taxi',
        amount: '5',
        paidTo: 'Taxi driver',
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
    expect(corrected.operatingExpenseItems[0]?.item).toBe('Kitchen gas refill');

    const revisions = await getDb()
      .select()
      .from(s.storeDailySettlementRevisions)
      .where(eq(s.storeDailySettlementRevisions.settlementId, created.id));
    expect(revisions.map((revision) => revision.version).sort()).toEqual([1, 2]);
    const originalSnapshot = revisions.find((revision) => revision.version === 1)?.snapshot as {
      operatingExpenseItems?: Array<{ item: string }>;
    };
    const correctedSnapshot = revisions.find((revision) => revision.version === 2)?.snapshot as {
      operatingExpenseItems?: Array<{ item: string }>;
    };
    expect(revisions.find((revision) => revision.version === 2)?.changedFields).toEqual(
      expect.arrayContaining(['operatingExpenseItems']),
    );
    expect(originalSnapshot.operatingExpenseItems?.[0]?.item).toBe('Kitchen gas');
    expect(correctedSnapshot.operatingExpenseItems?.[0]?.item).toBe('Kitchen gas refill');
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
        item: 'Historical operating expense',
        amount: '3.00',
      }),
    ]);
    expect(historical?.wageItems).toEqual([
      expect.objectContaining({
        personName: 'Unspecified recipient (historical total)',
        status: 'paid',
        amount: '4.00',
      }),
      expect.objectContaining({
        personName: 'Unspecified recipient (historical total)',
        status: 'unpaid',
        amount: '5.00',
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
