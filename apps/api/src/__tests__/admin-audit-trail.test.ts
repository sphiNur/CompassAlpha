/**
 * Admin audit trail (2026-11-09 full review):
 *   - ADM2-05: a purge's audit row held ids and row counts only. Once the
 *     rows were gone it named nothing, it had no store (so the store's
 *     admins never saw it), and a failed audit insert let the purge
 *     commit unrecorded.
 *   - ADM2-06: edits recorded only the new values, not what they replaced.
 *   - ADM2-07: copying a store's roles granted roles to every member with
 *     one counting row in the audit.
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/admin-audit-trail.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getDb, schema as s, withOrgContext } from '@compass/db';
import { appRouter } from '../trpc/router';
import { auditAdmin } from '../services/adminAudit';
import { SHOULD_RUN } from './helpers/pg';
import { callerFor } from './helpers/ctx';
import { seedRoles, seedMember, sessionOf } from './helpers/fixtures';
import { cleanUpAfterAll, noteOrg } from './helpers/cleanup';

cleanUpAfterAll();

type Db = ReturnType<typeof getDb>;
type Caller = ReturnType<typeof appRouter.createCaller>;

interface Person {
  userId: string;
  memberId: string;
  name: string;
  as: Caller;
}

let fix: {
  db: Db;
  orgId: string;
  storeA: string;
  storeB: string;
  owner: Person;
  managerA: Person;
  managerB: Person;
  staffA: Person;
} | null = null;

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug: `audit-${suffix}`, name: 'Audit trail', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  noteOrg(org!.id);
  const orgId = org!.id;
  const roleIds = await seedRoles(db, orgId, ['super_admin', 'manager', 'staff']);
  const [a] = await db
    .insert(s.stores)
    .values({ orgId, name: 'Store A', code: `AA-${suffix.slice(-6)}` })
    .returning();
  const [b] = await db
    .insert(s.stores)
    .values({ orgId, name: 'Store B', code: `AB-${suffix.slice(-6)}` })
    .returning();
  let n = 0;
  const person = async (slug: string, storeId: string | null): Promise<Person> => {
    n += 1;
    const name = `Audit ${slug} ${n}`;
    const who = await seedMember(db, orgId, {
      name,
      stores: storeId ? [storeId] : [],
      roles: [{ roleId: roleIds[slug]!, storeId }],
    });
    const as = callerFor(await sessionOf(orgId, who));
    return { userId: who.userId, memberId: who.memberId, name, as };
  };
  fix = {
    db,
    orgId,
    storeA: a!.id,
    storeB: b!.id,
    owner: await person('super_admin', null),
    managerA: await person('manager', a!.id),
    managerB: await person('manager', b!.id),
    staffA: await person('staff', a!.id),
  };
});

const auditRow = (action: string, resourceId: string) =>
  fix!.db.query.policyDecisions.findFirst({
    where: (x, o) => o.and(o.eq(x.action, action), o.eq(x.resourceId, resourceId)),
  });

describe.skipIf(!SHOULD_RUN)('a purge says what it deleted (ADM2-05)', () => {
  test('a deleted order keeps its store, day and author, and its store’s admin sees it', async () => {
    const { db, orgId, storeA, owner, managerA, managerB } = fix!;
    const sessionId = randomUUID();
    await db.insert(s.orderSessionsV).values({
      id: sessionId,
      orgId,
      storeId: storeA,
      orderDate: '2026-06-20',
      status: 'draft',
      initiatedByMemberId: owner.memberId,
    });
    await owner.as.admin.purgeSession({ sessionId, dryRun: false });
    const row = await auditRow('admin.purge.session', sessionId);
    expect(row?.scopeStoreId).toBe(storeA);
    expect(row?.inputs).toMatchObject({
      storeId: storeA,
      orderDate: '2026-06-20',
      status: 'draft',
      memberId: owner.memberId,
    });
    const seenByA = await managerA.as.admin.adminAuditList({ limit: 200 });
    const listed = seenByA.find((r) => r.resourceId === sessionId);
    expect(listed?.labels.storeName).toBe('Store A');
    expect(listed?.labels.memberName).toBe(owner.name);
    const seenByB = await managerB.as.admin.adminAuditList({ limit: 200 });
    expect(seenByB.some((r) => r.resourceId === sessionId)).toBe(false);
  });

  test('a deleted run keeps its day, number and stores; each store’s admin sees it', async () => {
    const { db, orgId, storeA, storeB, owner, managerA, managerB } = fix!;
    const runId = randomUUID();
    const sessions = [randomUUID(), randomUUID()];
    for (const [i, storeId] of [storeA, storeB].entries()) {
      await db.insert(s.orderSessionsV).values({
        id: sessions[i]!,
        orgId,
        storeId,
        orderDate: '2026-06-21',
        status: 'in_run',
        initiatedByMemberId: owner.memberId,
        runId,
      });
    }
    await db.insert(s.marketRunsV).values({
      id: runId,
      orgId,
      runDate: '2026-06-21',
      runIndex: 1,
      status: 'finished',
      sessionIdsJson: sessions,
    });
    await owner.as.admin.purgeRun({ runId, dryRun: false });
    const row = await auditRow('admin.purge.run', runId);
    expect(row?.inputs).toMatchObject({ runDate: '2026-06-21', runIndex: 1, status: 'finished' });
    expect(((row?.inputs as { storeIds?: string[] }).storeIds ?? []).sort()).toEqual(
      [storeA, storeB].sort(),
    );
    for (const manager of [managerA, managerB]) {
      const seen = await manager.as.admin.adminAuditList({ limit: 200 });
      expect(seen.some((r) => r.resourceId === runId)).toBe(true);
    }
  });

  test('a date purge lists the stores whose orders went; each store’s admin sees it', async () => {
    const { db, orgId, storeA, storeB, owner, managerA, managerB } = fix!;
    const day = '2026-06-22';
    for (const storeId of [storeA, storeB]) {
      await db.insert(s.orderSessionsV).values({
        id: randomUUID(),
        orgId,
        storeId,
        orderDate: day,
        status: 'submitted',
        initiatedByMemberId: owner.memberId,
      });
    }
    await owner.as.admin.purgeByDate({ date: day, dryRun: false });
    const row = await auditRow('admin.purge.date', orgId);
    expect(row?.inputs).toMatchObject({ date: day });
    expect(((row?.inputs as { storeIds?: string[] }).storeIds ?? []).sort()).toEqual(
      [storeA, storeB].sort(),
    );
    for (const manager of [managerA, managerB]) {
      const seen = await manager.as.admin.adminAuditList({ limit: 200 });
      expect(seen.some((r) => r.action === 'admin.purge.date')).toBe(true);
    }
  });

  test('a strict audit that cannot be written fails the action with it', async () => {
    const { db, orgId, owner } = fix!;
    const ctx = { session: { userId: owner.userId, orgId } };
    // A bigint cannot be stored as JSON: the audit insert fails.
    const unwritable = { amount: 1n };
    await withOrgContext(db, orgId, (tx) =>
      auditAdmin(tx, ctx, 'admin.test.lenient', 'org', orgId, unwritable),
    );
    let refused = false;
    try {
      await withOrgContext(db, orgId, (tx) =>
        auditAdmin(tx, ctx, 'admin.test.strict', 'org', orgId, unwritable, { strict: true }),
      );
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });
});

describe.skipIf(!SHOULD_RUN)('an edit records what it replaced (ADM2-06)', () => {
  test('a product: name, unit and step, from what to what', async () => {
    const { db, orgId, owner } = fix!;
    const [sku] = await db
      .insert(s.skus)
      .values({
        orgId,
        code: `AT-${Date.now()}`.slice(0, 20),
        names: { en: 'Tomato', ru: 'Помидор' },
        unit: 'kg',
        step: '1',
      })
      .returning();
    await owner.as.admin.skuUpdate({
      skuId: sku!.id,
      names: { en: 'Cherry tomato', ru: 'Помидор' },
      unit: 'box',
      step: '1',
    });
    const row = await auditRow('admin.sku.update', sku!.id);
    expect((row?.inputs as { changes?: unknown }).changes).toEqual({
      names: [
        { en: 'Tomato', ru: 'Помидор' },
        { en: 'Cherry tomato', ru: 'Помидор' },
      ],
      unit: ['kg', 'box'],
    });
  });

  test('a store: address and timezone (a store without its own timezone was empty)', async () => {
    const { storeB, owner } = fix!;
    await owner.as.admin.storeUpdate({
      storeId: storeB,
      address: 'Navoi 5',
      timezone: 'Asia/Tashkent',
    });
    const rows = await fix!.db.query.policyDecisions.findMany({
      where: (x, o) => o.and(o.eq(x.action, 'admin.store.update'), o.eq(x.resourceId, storeB)),
    });
    expect((rows.at(-1)?.inputs as { changes?: unknown }).changes).toEqual({
      address: [null, 'Navoi 5'],
      timezone: [null, 'Asia/Tashkent'],
    });
  });
});

describe.skipIf(!SHOULD_RUN)('copying a store’s roles audits each grant (ADM2-07)', () => {
  test('every copied role and store assignment has its own row', async () => {
    const { db, storeA, storeB, owner, staffA, managerB } = fix!;
    await owner.as.admin.storeCloneRoles({
      sourceStoreId: storeA,
      targetStoreId: storeB,
      includeMembers: true,
    });
    const grants = await db.query.policyDecisions.findMany({
      where: (x, o) =>
        o.and(
          o.eq(x.action, 'admin.role.grant'),
          o.eq(x.resourceId, staffA.memberId),
          o.eq(x.scopeStoreId, storeB),
        ),
    });
    expect(grants.map((g) => g.inputs)).toEqual([
      expect.objectContaining({ roleSlug: 'staff', scopeId: storeB, via: 'storeCloneRoles' }),
    ]);
    const assignments = await db
      .select({ inputs: s.policyDecisions.inputs })
      .from(s.policyDecisions)
      .where(
        and(
          eq(s.policyDecisions.action, 'admin.memberAssignStore'),
          eq(s.policyDecisions.resourceId, staffA.memberId),
        ),
      );
    expect(assignments.map((r) => r.inputs)).toEqual([
      expect.objectContaining({ storeId: storeB, via: 'storeCloneRoles' }),
    ]);
    // Store B's admin finds the grant in their own log.
    const seen = await managerB.as.admin.adminAuditList({ limit: 200 });
    expect(
      seen.some((r) => r.action === 'admin.role.grant' && r.resourceId === staffA.memberId),
    ).toBe(true);
  });
});

describe.skipIf(!SHOULD_RUN)('a grant from the command line', () => {
  test('names its role and comes back as made by the system', async () => {
    const { db, orgId, owner, staffA } = fix!;
    const [role] = await db
      .select({ id: s.roles.id, name: s.roles.name })
      .from(s.roles)
      .where(and(eq(s.roles.orgId, orgId), eq(s.roles.slug, 'manager')));
    const bindingId = randomUUID();
    // The row `compass user grant` writes (packages/cli/src/commands/user.ts).
    await db.insert(s.policyDecisions).values({
      orgId,
      actorId: null,
      action: 'admin.role.grant',
      resourceType: 'member',
      resourceId: staffA.memberId,
      decision: 'allow',
      reason: 'cli',
      inputs: {
        memberId: staffA.memberId,
        roleId: role!.id,
        scopeType: 'global',
        scopeId: null,
        bindingId,
        roleRank: 50,
      },
      scopeStoreId: null,
    });
    const seen = await owner.as.admin.adminAuditList({ limit: 200 });
    const cli = seen.find((r) => (r.inputs as { bindingId?: string }).bindingId === bindingId);
    expect(cli).toMatchObject({ actor: null, bySystem: true });
    expect(cli?.labels).toMatchObject({
      memberName: staffA.name,
      roleName: role!.name,
      roleSlug: 'manager',
    });
    expect(seen.find((r) => r.actor !== null)?.bySystem).toBe(false);
  });
});
