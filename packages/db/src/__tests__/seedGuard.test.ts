/**
 * Review DB-02 (2026-11-09): the development seed refuses to run on a
 * production host before it opens a database connection.
 */
import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SEED = join(dirname(fileURLToPath(import.meta.url)), '..', 'seed.ts');

test('db:seed refuses on production and never reaches the database', () => {
  const run = spawnSync('bun', [SEED], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      // Unreachable on purpose: the guard has to stop the script first.
      DATABASE_URL: 'postgres://seed:seed@127.0.0.1:1/never',
      DATABASE_URL_DIRECT: 'postgres://seed:seed@127.0.0.1:1/never',
    },
  });
  expect(run.status).toBe(2);
  expect(run.stderr).toContain('Refusing to seed');
});
