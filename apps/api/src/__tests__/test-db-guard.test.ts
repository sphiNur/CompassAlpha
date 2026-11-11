/**
 * A test run uses only a throwaway database (packages/db client.ts).
 * Bun reads the repository's .env on its own, and there DATABASE_URL is
 * the development database: a run that forgot SKIP_PG_TESTS=1 used to
 * insert its fixtures there and delete rows.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { getDb, testDatabaseRefusal, withSystemContext } from '@compass/db';

const inTests = { NODE_ENV: 'test' };
const devUrl = 'postgres://compass:compass@localhost:5433/compass';

describe('which database a test run may use', () => {
  test('one with "test" or "e2e" as a word of its name', () => {
    for (const name of [
      'compass_test',
      'compass_test_rx',
      'COMPASS_TEST',
      'compass_e2e',
      'test-x',
      'e2e',
    ]) {
      const url = `postgres://u:p@localhost:5433/${name}?sslmode=disable`;
      expect([name, testDatabaseRefusal(url, inTests)]).toEqual([name, null]);
    }
  });

  test('any other name is refused, and the refusal names the database', () => {
    expect(testDatabaseRefusal(devUrl, inTests)).toContain('this one is "compass"');
    // The letters inside another word are not enough.
    for (const name of ['latest', 'contest', 'compass_attestation', 'compass_testing']) {
      expect(testDatabaseRefusal(`postgres://u:p@localhost:5433/${name}`, inTests)).toContain(
        `this one is "${name}"`,
      );
    }
    expect(testDatabaseRefusal('postgres://u:p@db.example.com/compass_prod', inTests)).toContain(
      'this one is "compass_prod"',
    );
  });

  test('so is a URL that names no database, or is not a URL', () => {
    expect(testDatabaseRefusal('postgres://u:p@localhost:5433', inTests)).toContain('unnamed');
    expect(testDatabaseRefusal('postgres://u:p@localhost:5433/', inTests)).toContain('unnamed');
    expect(testDatabaseRefusal('compass_test', inTests)).toContain('unnamed');
  });

  test('the refusal leaves the password out', () => {
    const refusal = testDatabaseRefusal('postgres://compass:s3cret@localhost/compass', inTests);
    expect(refusal).not.toBeNull();
    expect(refusal).not.toContain('s3cret');
  });

  test('outside a test run, or with ALLOW_ANY_TEST_DB=1, any database is allowed', () => {
    expect(testDatabaseRefusal(devUrl, { NODE_ENV: 'development' })).toBeNull();
    expect(testDatabaseRefusal(devUrl, { NODE_ENV: 'production' })).toBeNull();
    expect(testDatabaseRefusal(devUrl, {})).toBeNull();
    expect(testDatabaseRefusal(devUrl, { NODE_ENV: 'test', ALLOW_ANY_TEST_DB: '1' })).toBeNull();
  });
});

describe('getDb in a test run', () => {
  // getDb reads both variables from the process; pin them for these tests.
  const saved = { NODE_ENV: process.env.NODE_ENV, ALLOW: process.env.ALLOW_ANY_TEST_DB };
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    delete process.env.ALLOW_ANY_TEST_DB;
  });
  afterEach(() => {
    process.env.NODE_ENV = saved.NODE_ENV;
    if (saved.ALLOW === undefined) delete process.env.ALLOW_ANY_TEST_DB;
    else process.env.ALLOW_ANY_TEST_DB = saved.ALLOW;
  });

  test('a refused database gives a handle that throws on every use', async () => {
    // Checked before the pool lookup: in the PG suite, an earlier file's
    // pool on the test database is not handed out for this URL.
    for (const db of [getDb(devUrl), getDb(devUrl, { system: 'maintenance' })]) {
      expect(() => db.select()).toThrow('this one is "compass"');
      expect(() => db.execute(sql`SELECT 1`)).toThrow('this one is "compass"');
      await expect(
        withSystemContext(db, 'maintenance', (tx) => tx.execute(sql`SELECT 1`)),
      ).rejects.toThrow('this one is "compass"');
    }
  });

  test('passing the handle around, or awaiting it, is not a use', async () => {
    const db = getDb(devUrl);
    const context = { db };
    expect(context.db).toBe(db);
    expect(await Promise.resolve(db)).toBe(db);
  });
});
