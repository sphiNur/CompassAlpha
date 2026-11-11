/**
 * `pnpm test`: the unit tests CI's unit job and the deploy's gate run, from
 * the same list and in the same environment (lib/testTargets). PG-backed
 * tests skip themselves; CLAUDE.md says how to run them against a
 * throwaway database. Extra arguments go to `bun test` (`pnpm test -t
 * "catalog lint"`).
 *
 * Review OPS-17 (2026-11-12): `pnpm test` was `turbo run test`, which
 * reached the two packages that have a test script, while the README
 * called it every test.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { UNIT_TEST_DIRS, unitGateEnv } from './lib/testTargets';

const run = spawnSync('bun', ['test', ...UNIT_TEST_DIRS, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: join(import.meta.dir, '..'),
  env: unitGateEnv(process.env),
});
process.exit(run.status ?? 1);
