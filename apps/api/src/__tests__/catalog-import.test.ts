/**
 * 2026-10-23: importing another organisation's catalog
 * (admin.catalogImportSources / catalogImportPreview / catalogImport).
 *
 *   - only organisations the caller administers are offered and accepted;
 *   - the copy creates what is missing and reuses what matches;
 *   - a second import adds nothing; the source is untouched.
 *
 * Skipped when DATABASE_URL is unset OR SKIP_PG_TESTS=1.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  getDb,
  provisionOrganization,
  schema as s,
  withOrgContext,
  withSystemContext,
} from '@compass/db';
import { logger } from '../infra/log';
import { appRouter } from '../trpc/router';
import type { RequestContext, SessionContext } from '../trpc/context';

const SHOULD_RUN = !!process.env.DATABASE_URL && process.env.SKIP_PG_TESTS !== '1';

function caller(session: SessionContext) {
  const db = getDb();
  const ctx: RequestContext = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hono: {} as any,
    db,
    log: logger,
    traceId: `test-${Date.now()}`,
    ip: null,
    userAgent: null,
    idempotencyKey: null,
    session,
    async withOrg(fn) {
      return withOrgContext(db, session.orgId, fn);
    },
  };
  return appRouter.createCaller(ctx);
}

describe.skipIf(!SHOULD_RUN)('catalog import between organisations (PG-gated)', () => {
  const cleanupOrgIds: string[] = [];
  let userId = '';
  let orgA = '';
  let orgB = '';
  let orgC = '';
  let memberB = '';
  let session: SessionContext;

  beforeAll(async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    const [user] = await db
      .insert(s.users)
      .values({
        tgUserId: BigInt(9_000_000_000 + Math.floor(Math.random() * 900_000_000)),
        displayName: 'Catalog Owner',
        displayNameLocked: true,
      })
      .returning();
    userId = user!.id;

    const suffix = Math.random().toString(36).slice(2, 8);
    const orgs = await withSystemContext(db, 'maintenance', async (tx) => {
      const a = await provisionOrganization(tx, {
        name: 'Source A',
        slug: `src-a-${suffix}`,
        ownerUserId: userId,
      });
      const b = await provisionOrganization(tx, {
        name: 'Target B',
        slug: `tgt-b-${suffix}`,
        ownerUserId: userId,
      });
      // C: the caller is a plain member, not an admin.
      const c = await provisionOrganization(tx, { name: 'Other C', slug: `oth-c-${suffix}` });
      await tx.insert(s.members).values({ orgId: c.orgId, userId, status: 'active' });
      return { a, b, c };
    });
    orgA = orgs.a.orgId;
    orgB = orgs.b.orgId;
    orgC = orgs.c.orgId;
    memberB = orgs.b.ownerMemberId!;
    cleanupOrgIds.push(orgA, orgB, orgC);

    await withOrgContext(db, orgA, async (tx) => {
      const [veg] = await tx
        .insert(s.categories)
        .values({ orgId: orgA, slug: 'veg', names: { en: 'Vegetables' } })
        .returning();
      const [ali] = await tx
        .insert(s.suppliers)
        .values({ orgId: orgA, name: 'Bazaar Ali', contactPhone: '+998' })
        .returning();
      const skus = await tx
        .insert(s.skus)
        .values([
          { orgId: orgA, categoryId: veg!.id, names: { en: 'Lemon' }, unit: 'kg', step: '0.5' },
          { orgId: orgA, categoryId: veg!.id, names: { en: 'Onion' }, unit: 'kg', step: '1' },
          { orgId: orgA, names: { en: 'Old thing' }, unit: 'pcs', isArchived: true },
        ])
        .returning();
      await tx.insert(s.skuSupplierLinks).values({
        skuId: skus[0]!.id,
        supplierId: ali!.id,
        isPreferred: true,
        defaultPrice: '30000',
      });
    });
    // B already has onions.
    await withOrgContext(db, orgB, (tx) =>
      tx.insert(s.skus).values({ orgId: orgB, names: { en: 'onion' }, unit: 'kg' }),
    );

    session = {
      userId,
      memberId: memberB,
      orgId: orgB,
      orgTimezone: 'UTC',
      permissions: new Set(['users.manage', 'org.admin']),
      roleSlugs: new Set(['admin']),
    };
  });

  afterAll(async () => {
    const db = getDb(undefined, { system: 'maintenance' });
    for (const id of cleanupOrgIds) {
      await db.delete(s.organizations).where(eq(s.organizations.id, id));
    }
    if (userId) await db.delete(s.users).where(eq(s.users.id, userId));
  });

  test('only organisations the caller administers are offered', async () => {
    const sources = await caller(session).admin.catalogImportSources();
    expect(sources.map((o) => o.orgId)).toEqual([orgA]);
  });

  test('a source the caller does not administer is refused', async () => {
    await expect(
      caller(session).admin.catalogImport({ sourceOrgId: orgC, includeSuppliers: true }),
    ).rejects.toThrow();
  });

  test('preview, import, and a second import that adds nothing', async () => {
    const input = { sourceOrgId: orgA, includeSuppliers: true };
    const preview = await caller(session).admin.catalogImportPreview(input);
    expect(preview).toEqual({
      categories: { created: 1, existing: 0 },
      suppliers: { created: 1, existing: 0 },
      skus: { created: 1, existing: 1 },
      links: { created: 1 },
    });

    const done = await caller(session).admin.catalogImport(input);
    expect(done).toEqual(preview);

    const db = getDb(undefined, { system: 'maintenance' });
    const skus = await db.select().from(s.skus).where(eq(s.skus.orgId, orgB));
    expect(skus.map((k) => (k.names as Record<string, string>).en).sort()).toEqual([
      'Lemon',
      'onion',
    ]);
    const lemon = skus.find((k) => (k.names as Record<string, string>).en === 'Lemon')!;
    expect(lemon.step).toBe('0.500');
    const [veg] = await db.select().from(s.categories).where(eq(s.categories.orgId, orgB));
    expect(lemon.categoryId).toBe(veg!.id);
    const links = await db
      .select()
      .from(s.skuSupplierLinks)
      .where(eq(s.skuSupplierLinks.skuId, lemon.id));
    expect(links).toHaveLength(1);
    expect(links[0]!.isPreferred).toBe(true);
    // prices are the source's own history, not copied
    expect(links[0]!.defaultPrice).toBeNull();

    const again = await caller(session).admin.catalogImport(input);
    expect(again.categories.created + again.suppliers.created + again.skus.created).toBe(0);

    const sourceSkus = await db.select().from(s.skus).where(eq(s.skus.orgId, orgA));
    expect(sourceSkus).toHaveLength(3);
  });
});
