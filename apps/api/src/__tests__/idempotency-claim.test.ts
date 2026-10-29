/**
 * R3 (2026-10-30): the idempotency middleware claims a key before it runs
 * the handler. Two requests with the same key used to both miss the
 * cache and both run (a double-tapped sale was booked twice).
 *
 * Run with: DATABASE_URL=… bun test apps/api/src/__tests__/idempotency-claim.test.ts
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getDb, schema as s, withOrgContext } from '@compass/db';
import { logger } from '../infra/log';
import { idempotentMutation, router } from '../trpc/trpc';
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

let session: SessionContext | null = null;
let runs = 0;
let failNext = false;

const testRouter = router({
  slowWrite: idempotentMutation.mutation(async () => {
    runs += 1;
    const n = runs;
    await new Promise((r) => setTimeout(r, 150));
    if (failNext) {
      failNext = false;
      throw new Error('handler failed');
    }
    return { n };
  }),
});

function caller(key: string) {
  const db = getDb();
  const ctx: RequestContext = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hono: {} as any,
    db,
    log: logger,
    traceId: `test-${Date.now()}`,
    ip: null,
    userAgent: null,
    idempotencyKey: key,
    session: session!,
    async withOrg(fn, options) {
      return withOrgContext(db, session!.orgId, fn, options);
    },
  };
  return testRouter.createCaller(ctx);
}

beforeAll(async () => {
  if (!SHOULD_RUN) return;
  const db = getDb(undefined, { system: 'maintenance' });
  const slug = `idem-${Date.now()}`;
  const [org] = await db
    .insert(s.organizations)
    .values({ slug, name: 'Idempotency claim test', localeDefault: 'en', timezone: 'UTC' })
    .returning();
  const [user] = await db
    .insert(s.users)
    .values({ displayName: 'Idem', tgUserId: BigInt(`7${Date.now()}4`.slice(-12)) })
    .returning();
  const [member] = await db.insert(s.members).values({ orgId: org!.id, userId: user!.id }).returning();
  session = {
    userId: user!.id,
    memberId: member!.id,
    orgId: org!.id,
    orgTimezone: 'UTC',
    permissions: new Set<string>(),
    roleSlugs: new Set<string>(),
  } as unknown as SessionContext;
});

describe.skipIf(!SHOULD_RUN)('idempotency claim (PG-gated)', () => {
  test('two concurrent requests with one key run the handler once and share its answer', async () => {
    const key = randomUUID();
    const before = runs;
    const [a, b] = await Promise.all([caller(key).slowWrite(), caller(key).slowWrite()]);
    expect(runs - before).toBe(1);
    expect(a).toEqual(b);
    // And a later retry gets the cached answer without running again.
    const c = await caller(key).slowWrite();
    expect(c).toEqual(a);
    expect(runs - before).toBe(1);
  });

  test('a failed attempt frees its key so the retry runs', async () => {
    const key = randomUUID();
    failNext = true;
    await expect(caller(key).slowWrite()).rejects.toThrow();
    const before = runs;
    const ok = await caller(key).slowWrite();
    expect(runs - before).toBe(1);
    expect(ok.n).toBe(runs);
  });

  test('different keys still each run', async () => {
    const before = runs;
    await Promise.all([caller(randomUUID()).slowWrite(), caller(randomUUID()).slowWrite()]);
    expect(runs - before).toBe(2);
  });
});
