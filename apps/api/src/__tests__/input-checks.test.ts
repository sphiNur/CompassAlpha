/**
 * Input checks (2026-10-30 operation atlas, low findings): impossible
 * dates answered 500 (BUY-15, HIS-11), blank names were stored (ADM-11),
 * expense templates took a 0 quantity and over-long prices (CAT-11), "%"
 * in history search matched everything (HIS-14), and an upload's key took
 * its extension from the client's file name (AUTH-24).
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/input-checks.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { getDb, schema as s, withOrgContext } from '@compass/db';
import { logger } from '../infra/log';
import { appRouter } from '../trpc/router';
import { loadSession, type RequestContext, type SessionContext } from '../trpc/context';
import { randomUUID } from 'node:crypto';
import { pickExtension } from '../trpc/routers/upload';

const HERE = dirname(fileURLToPath(import.meta.url));
type SeedData = {
  BUILTIN_ROLES: readonly { slug: string; rank: number; permissions: readonly string[] }[];
};
const seedDataPath = resolve(HERE, '../../../../packages/db/src/seed-data.ts');
const { BUILTIN_ROLES } = (await import(seedDataPath)) as SeedData;

(function loadEnv() {
  let dir = HERE;
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate) && existsSync(resolve(dir, 'pnpm-workspace.yaml'))) {
      for (const raw of readFileSync(candidate, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const idx = line.indexOf('=');
        if (idx < 0) continue;
        const key = line.slice(0, idx).trim();
        const val = line
          .slice(idx + 1)
          .trim()
          .replace(/^"(.*)"$/, '$1');
        if (!(key in process.env)) process.env[key] = val;
      }
      return;
    }
    dir = resolve(dir, '..');
  }
})();

const SHOULD_RUN = !!process.env.DATABASE_URL && process.env.SKIP_PG_TESTS !== '1';

function buildCtx(db: ReturnType<typeof getDb>, session: SessionContext): RequestContext {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hono: {} as any,
    db,
    log: logger,
    traceId: `test-${Date.now()}`,
    ip: null,
    userAgent: null,
    idempotencyKey: null,
    session,
    async withOrg(fn, options) {
      return withOrgContext(db, session.orgId, fn, options);
    },
  };
}

type Caller = ReturnType<typeof appRouter.createCaller>;
let owner: Caller | null = null;
let runId = '';

async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? 'unknown';
  }
}

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug: `checks-${suffix}`, name: 'Input checks', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  const def = BUILTIN_ROLES.find((r) => r.slug === 'super_admin')!;
  const [role] = await db
    .insert(s.roles)
    .values({ orgId: org!.id, slug: 'super_admin', name: 'super_admin', rank: def.rank, isBuiltIn: true })
    .returning();
  for (const key of def.permissions) {
    await db.insert(s.permissions).values({ key, description: key }).onConflictDoNothing();
    await db.insert(s.rolePermissions).values({ roleId: role!.id, permissionKey: key }).onConflictDoNothing();
  }
  const [u] = await db
    .insert(s.users)
    .values({ displayName: 'Checks', tgUserId: BigInt(`${suffix}1`.slice(-12)) })
    .returning();
  const [m] = await db.insert(s.members).values({ orgId: org!.id, userId: u!.id, status: 'active' }).returning();
  await db.insert(s.memberRoleBindings).values({ memberId: m!.id, roleId: role!.id, scopeType: 'global', scopeId: null });
  runId = randomUUID();
  await db.insert(s.marketRunsV).values({ id: runId, orgId: org!.id, runDate: '2026-06-01', status: 'finished' });
  const session = await loadSession(db, u!.id, org!.id, m!.id);
  if (!session) throw new Error('session failed to load');
  owner = appRouter.createCaller(buildCtx(db, session));
});

describe.skipIf(!SHOULD_RUN)('input checks (PG-gated)', () => {
  test('impossible dates are refused as input, not a 500', async () => {
    expect(await codeOf(() => owner!.run.changeDate({ runId, runDate: '2026-02-31' }))).toBe('BAD_REQUEST');
    expect(await codeOf(() => owner!.admin.purgeByDate({ date: '2026-13-01', dryRun: true }))).toBe('BAD_REQUEST');
  });

  test('a blank store name is refused; an empty code means none', async () => {
    expect(await codeOf(() => owner!.admin.storeCreate({ name: '   ' }))).toBe('BAD_REQUEST');
    expect(await codeOf(() => owner!.admin.storeCreate({ name: '  Kitchen  ', code: '' }))).toBeNull();
  });

  test('expense templates need a positive quantity and a price that fits', async () => {
    const base = { label: 'Porter', defaultUnitPrice: '20000' };
    expect(await codeOf(() => owner!.admin.expenseTemplateCreate({ ...base, defaultQty: '0' }))).toBe('BAD_REQUEST');
    expect(
      await codeOf(() => owner!.admin.expenseTemplateCreate({ ...base, defaultUnitPrice: '999999999999999' })),
    ).toBe('BAD_REQUEST');
    expect(await codeOf(() => owner!.admin.expenseTemplateCreate({ ...base, defaultQty: '1' }))).toBeNull();
  });

  test('"%" in history search is a literal, not a wildcard', async () => {
    const all = await owner!.run.history({ dateFrom: '2026-06-01', dateTo: '2026-06-01' });
    expect(all.rows.length).toBe(1);
    const percent = await owner!.run.history({ dateFrom: '2026-06-01', dateTo: '2026-06-01', search: '%' });
    expect(percent.rows.length).toBe(0);
  });

  test('an upload key takes its extension from the signed content type only', () => {
    expect(pickExtension('image/png')).toBe('png');
    expect(pickExtension('image/jpeg')).toBe('jpg');
  });
});
