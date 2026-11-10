/**
 * The probe that finds queries running without a tenant (packages/db
 * client.ts). It is how the list of places to fix is produced before the
 * row-level policies stop letting such queries through, so it must not
 * miss a query on the root handle, and must stay quiet for the two
 * helpers that set a context.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import {
  closeDb,
  getDb,
  setTenantlessQueryReporter,
  withOrgContext,
  withSystemContext,
} from '@compass/db';
import type { TenantlessQuery } from '@compass/db';
import { SHOULD_RUN } from './helpers/pg';

const SOME_ORG = '00000000-0000-4000-8000-000000000001';
/** This file as the probe names it: relative to the repository, with `/`. */
const THIS_FILE = relative(
  resolve(fileURLToPath(import.meta.url), '../../../../..'),
  fileURLToPath(import.meta.url),
).replaceAll('\\', '/');

describe.skipIf(!SHOULD_RUN)('tenantless query probe (PG-gated)', () => {
  const seen: TenantlessQuery[] = [];
  const probeBefore = process.env.DB_TENANT_PROBE;
  let db: ReturnType<typeof getDb>;

  beforeAll(() => {
    db = getDb();
  });
  beforeEach(() => {
    delete process.env.DB_TENANT_PROBE;
    seen.length = 0;
    setTenantlessQueryReporter((use) => seen.push(use));
  });
  afterAll(async () => {
    // The reporter and the mode are process state, and `bun test` runs
    // every file in one process: left as they are here, they would hide
    // the probe from the files after this one (TEST2-17).
    if (probeBefore === undefined) delete process.env.DB_TENANT_PROBE;
    else process.env.DB_TENANT_PROBE = probeBefore;
    setTenantlessQueryReporter(null);
    await closeDb();
  });

  test('a query on the root handle is reported with where it came from', async () => {
    await db.execute(sql`SELECT 1`);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.operation).toBe('execute');
    expect(seen[0]!.site).toMatch(/:\d+$/);
    expect(seen[0]!.site.replace(/:\d+$/, '')).toBe(THIS_FILE);
  });

  test('the same place is reported once, however often it runs', async () => {
    for (let i = 0; i < 3; i++) await db.execute(sql`SELECT 1`);
    expect(seen).toHaveLength(1);
  });

  test('queries inside a tenant or a system context are not reported', async () => {
    await withOrgContext(db, SOME_ORG, (tx) => tx.execute(sql`SELECT 1`));
    const [row] = await withSystemContext(db, 'health', (tx) =>
      tx.execute(sql`SELECT current_setting('app.system_context', true) AS reason`),
    );
    expect(seen).toHaveLength(0);
    expect((row as { reason: string }).reason).toBe('health');
  });

  test('the system context ends with its transaction', async () => {
    await withSystemContext(db, 'health', (tx) => tx.execute(sql`SELECT 1`));
    const [row] = await withOrgContext(db, SOME_ORG, (tx) =>
      tx.execute(sql`SELECT coalesce(current_setting('app.system_context', true), '') AS reason`),
    );
    expect((row as { reason: string }).reason).toBe('');
  });

  test('in throw mode the query does not run', () => {
    process.env.DB_TENANT_PROBE = 'throw';
    expect(() => db.execute(sql`SELECT 1`)).toThrow(/runs without a tenant/);
  });

  test('off means silent', async () => {
    process.env.DB_TENANT_PROBE = 'off';
    await db.execute(sql`SELECT 1`);
    expect(seen).toHaveLength(0);
  });
});
