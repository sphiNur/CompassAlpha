/**
 * Review TEST2-01 (2026-11-12): the tenant tables rls-isolation.test.ts
 * never seeded, kept to their own workspace row by row: invitations,
 * subscriptions, policy rules, prices paid, stock movements, sales,
 * expense templates, notifications, the audit log, feature flags and
 * daily metrics. (The attendance tables are in rls-attendance.test.ts.)
 *
 * rls-catalog.test.ts proves that each has row-level security forced and
 * only the tenant policy. Here each gets a row in each of two new
 * workspaces, counted by `org_id`: each workspace sees its own rows, the
 * two together see exactly what the system context sees (a workspace that
 * also saw the other's rows would push the sum past it), and with neither
 * a workspace nor the system context set, nobody sees any.
 *
 * Skipped as rls-isolation.test.ts is: without a database, and with a
 * role that bypasses row-level security (an error in CI).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { closeDb, getDb, schema as s } from '@compass/db';
import { SHOULD_RUN } from './helpers/pg';
import { freshTgId } from './helpers/telegram';
import { cleanUpAfterAll, noteOrg, noteUser } from './helpers/cleanup';
import { countUnderEachContext, rlsSuiteRuns } from './helpers/rls';

cleanUpAfterAll();

const RUN_RLS = await rlsSuiteRuns('rls-records');

const orgIds: string[] = [];

/** A workspace with a person, a store, a product and a dish, and a row in each table below. */
async function seedTenant(label: string): Promise<string> {
  const db = getDb(undefined, { system: 'maintenance' });
  const [org] = await db
    .insert(s.organizations)
    .values({
      slug: `rls-rec-${Date.now()}-${label}`,
      name: `RLS records ${label}`,
      localeDefault: 'en',
      timezone: 'UTC',
    })
    .returning({ id: s.organizations.id });
  const orgId = noteOrg(org!.id);
  const [user] = await db
    .insert(s.users)
    .values({ displayName: label, tgUserId: freshTgId() })
    .returning({ id: s.users.id });
  const userId = noteUser(user!.id);
  const [member] = await db
    .insert(s.members)
    .values({ orgId, userId })
    .returning({ id: s.members.id });
  const [store] = await db
    .insert(s.stores)
    .values({ orgId, name: `Store ${label}`, code: `REC-${label}` })
    .returning({ id: s.stores.id });
  const storeId = store!.id;
  const [sku] = await db
    .insert(s.skus)
    .values({ orgId, names: { en: `Onion ${label}` }, unit: 'kg', step: '0.5' })
    .returning({ id: s.skus.id });
  const skuId = sku!.id;
  const [dish] = await db
    .insert(s.dishes)
    .values({ orgId, names: { en: `Soup ${label}` } })
    .returning({ id: s.dishes.id });

  await db.insert(s.memberInvites).values({
    orgId,
    tokenHash: randomBytes(32).toString('hex'),
    storeIds: [storeId],
    grants: [],
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  await db.insert(s.organizationSubscriptions).values({ orgId, planCode: 'legacy' });
  await db.insert(s.policyRules).values({
    orgId,
    subjectExpr: "role == 'manager'",
    action: 'rls.test',
    resourceExpr: 'true',
    effect: 'allow',
  });
  await db.insert(s.priceHistory).values({ orgId, skuId, storeId, unitPrice: '1.50', qty: '2' });
  await db
    .insert(s.inventoryMovements)
    .values({ orgId, storeId, skuId, delta: '2', reason: 'adjustment', actorMemberId: member!.id });
  await db.insert(s.sales).values({ orgId, storeId, dishId: dish!.id, qty: '1' });
  await db.insert(s.expenseTemplates).values({ orgId, label: 'Taxi', defaultUnitPrice: '3.00' });
  await db.insert(s.notifications).values({
    orgId,
    recipientUserId: userId,
    channel: 'inapp',
    template: 'rls.test',
    title: 'RLS test',
  });
  await db.insert(s.auditLog).values({ orgId, actorId: userId, action: 'rls.test' });
  await db.insert(s.featureFlags).values({ orgId, key: 'rls.test', value: true });
  await db.insert(s.dailyMetrics).values({ orgId, metricDate: '2026-11-12', metric: 'rls.test' });
  return orgId;
}

beforeAll(async () => {
  if (!RUN_RLS) return;
  orgIds.push(await seedTenant('A'), await seedTenant('B'));
});

afterAll(async () => {
  if (!SHOULD_RUN) return;
  // ops.daily_metrics has no foreign key to its workspace, so removing the
  // workspace (cleanUpAfterAll) leaves these rows behind.
  if (orgIds.length > 0) {
    const db = getDb(undefined, { system: 'maintenance' });
    await db.delete(s.dailyMetrics).where(inArray(s.dailyMetrics.orgId, orgIds));
  }
  await closeDb();
});

const TABLES = [
  'auth.member_invites',
  'auth.organization_subscriptions',
  'auth.policy_rules',
  'inventory.price_history',
  'inventory.movements',
  'inventory.sales',
  'inventory.expense_templates',
  'ops.notifications',
  'ops.audit_log',
  'ops.feature_flags',
  'ops.daily_metrics',
] as const;

describe.skipIf(!RUN_RLS)('RLS: tenant records stay in their workspace (PG-gated)', () => {
  for (const table of TABLES) {
    test(table, async () => {
      const [a, b] = orgIds;
      if (!a || !b) throw new Error('fixture missing');
      const r = await countUnderEachContext(table, `org_id IN ('${a}', '${b}')`, a, b);
      expect(r.aSeen).toBeGreaterThan(0);
      expect(r.bSeen).toBeGreaterThan(0);
      expect(r.aSeen + r.bSeen).toBe(r.totalSeen);
    });
  }
});
