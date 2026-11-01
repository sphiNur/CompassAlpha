/**
 * DX-ORD-6 (2026-11-01): catalog.skus returns products in the order the
 * admin set (sortIndex, then code). Rows used to come back in whatever
 * order Postgres found them, so the Order page listed them by accident.
 * PG-gated like the other router tests.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { getDb, schema as s, withOrgContext } from '@compass/db';
import { logger } from '../infra/log';
import { appRouter } from '../trpc/router';
import type { RequestContext, SessionContext } from '../trpc/context';

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

let ctx: RequestContext | null = null;
let codes: string[] = [];

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const slug = `skuorder-${Date.now()}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug, name: 'SKU order test', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  const [user] = await db
    .insert(s.users)
    .values({ displayName: 'Reader', tgUserId: BigInt(`7${Date.now()}3`.slice(-12)) })
    .returning();
  const [member] = await db
    .insert(s.members)
    .values({ orgId: org!.id, userId: user!.id })
    .returning();
  const suffix = slug.slice(-6);
  // Inserted out of order on purpose; two share a sortIndex (code breaks the tie).
  const rows = [
    { code: `C-${suffix}`, sortIndex: 20 },
    { code: `A-${suffix}`, sortIndex: 30 },
    { code: `Z-${suffix}`, sortIndex: 0 },
    { code: `B-${suffix}`, sortIndex: 20 },
  ];
  await db.insert(s.skus).values(
    rows.map((r) => ({
      orgId: org!.id,
      code: r.code,
      names: { en: r.code },
      unit: 'kg',
      step: '1',
      sortIndex: r.sortIndex,
    })),
  );
  codes = [`Z-${suffix}`, `B-${suffix}`, `C-${suffix}`, `A-${suffix}`];
  ctx = buildCtx(db, {
    userId: user!.id,
    memberId: member!.id,
    orgId: org!.id,
    orgTimezone: 'UTC',
    permissions: new Set(),
    roleSlugs: new Set(['staff']),
  });
});

describe.skipIf(!SHOULD_RUN)('catalog.skus order (PG-gated)', () => {
  test('sorted by sortIndex, then code', async () => {
    if (!ctx) throw new Error('fixture missing');
    const caller = appRouter.createCaller(ctx);
    const list = await caller.catalog.skus({ includeArchived: true });
    expect(list.map((r) => r.code)).toEqual(codes);
  });
});
