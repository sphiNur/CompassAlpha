/**
 * Review OPS-16 (2026-11-10): every test runs somewhere, and every list of
 * where agrees with scripts/lib/testTargets.ts.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  E2E_TEST_DIR,
  INTEGRATION_TEST_DIRS,
  PG_GATED,
  TEST_FILE,
  UNIT_TEST_DIRS,
  ciTestDirs,
  isUnder,
  unitGateEnv,
} from '../lib/testTargets';

const ROOT = join(import.meta.dir, '..', '..');
/** A repository file, with LF line ends whatever this checkout's core.autocrlf. */
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

/** The test files git tracks, repository-relative. */
function trackedTests(): string[] {
  const r = spawnSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`git ls-files: ${r.stderr || r.error}`);
  return r.stdout.split('\0').filter((f) => TEST_FILE.test(f));
}

describe('ciTestDirs', () => {
  const workflow = [
    'jobs:',
    '  unit:',
    '    steps:',
    '      - name: Unit tests',
    '        env:',
    '          A: b',
    '        # bun test is not run from a comment',
    '        run: |',
    '          bun test \\',
    '            packages/a \\',
    '            apps/b',
    '      - name: Next',
    '        run: bun test apps/c',
    '  other:',
    '    steps:',
    '      - name: Last',
    '        run: echo no tests',
  ].join('\r\n');

  test('reads the directories of one step, across continued lines and CRLF', () => {
    expect(ciTestDirs(workflow, 'Unit tests')).toEqual(['packages/a', 'apps/b']);
    expect(ciTestDirs(workflow, 'Next')).toEqual(['apps/c']);
  });

  test('a missing step, or one without bun test, is an error', () => {
    expect(() => ciTestDirs(workflow, 'Nope')).toThrow('no step named "Nope"');
    expect(() => ciTestDirs(workflow, 'Last')).toThrow('does not run bun test');
  });
});

describe('unitGateEnv', () => {
  test('the gate is a test run, even when the deploy loaded a development .env', () => {
    // 2026-11-11: NODE_ENV=development reached `bun test`, and three i18n
    // tests that hold only in a test run failed in the gate alone.
    const env = unitGateEnv({ NODE_ENV: 'development', PATH: '/usr/bin' });
    expect(env.NODE_ENV).toBe('test');
    expect(env.SKIP_PG_TESTS).toBe('1');
    expect(env.PATH).toBe('/usr/bin');
  });

  test("keeps the shell's settings, and fills placeholders for the ones it lacks", () => {
    const given = unitGateEnv({
      DATABASE_URL: 'postgres://a@localhost/compass_test_a',
      JWT_SECRET: 'shell-access',
      JWT_REFRESH_SECRET: 'shell-refresh',
    });
    expect(given.DATABASE_URL).toBe('postgres://a@localhost/compass_test_a');
    expect(given.JWT_SECRET).toBe('shell-access');
    expect(given.JWT_REFRESH_SECRET).toBe('shell-refresh');

    const filled = unitGateEnv({});
    // Port 1: nothing listens there, so a test that forgot the gate fails
    // to connect instead of writing somewhere.
    expect(filled.DATABASE_URL).toBe('postgres://unit:unit@127.0.0.1:1/unit_tests');
    expect(filled.JWT_SECRET!.length).toBeGreaterThanOrEqual(32);
    expect(filled.JWT_REFRESH_SECRET!.length).toBeGreaterThanOrEqual(32);
  });
});

describe('test targets (OPS-16)', () => {
  const ci = read('.github/workflows/ci.yml');

  test("CI's unit and integration jobs run the shared lists", () => {
    expect(ciTestDirs(ci, 'Unit tests (non-PG)')).toEqual([...UNIT_TEST_DIRS]);
    expect(ciTestDirs(ci, 'Integration tests')).toEqual([...INTEGRATION_TEST_DIRS]);
  });

  test('the command CLAUDE.md gives is the unit job', () => {
    expect(read('CLAUDE.md')).toContain(`SKIP_PG_TESTS=1 bun test ${UNIT_TEST_DIRS.join(' ')}\n`);
  });

  test('pnpm test runs the shared unit list (OPS-17)', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts.test).toBe('bun run scripts/unit-tests.ts');
    const script = read('scripts/unit-tests.ts');
    expect(script).toContain("['test', ...UNIT_TEST_DIRS");
    expect(script).toContain('env: unitGateEnv(process.env)');
  });

  test('the deploy runs the shared unit list', () => {
    const deploy = read('scripts/deploy.ts');
    expect(deploy).toContain("['test', ...UNIT_TEST_DIRS]");
    expect(deploy).toContain("from './lib/testTargets'");
    expect(deploy).toContain('env: unitGateEnv(process.env)');
  });

  const files = trackedTests();

  test('every test file is in a directory a run covers', () => {
    expect(files.length).toBeGreaterThan(100);
    const outside = files.filter((f) => !isUnder(f, UNIT_TEST_DIRS) && !isUnder(f, [E2E_TEST_DIR]));
    expect(outside).toEqual([]);
  });

  test('every PG-gated test is in a directory the integration job covers', () => {
    const gated = files.filter((f) => PG_GATED.test(read(f)));
    expect(gated.length).toBeGreaterThan(10);
    const missed = gated.filter((f) => !isUnder(f, INTEGRATION_TEST_DIRS));
    expect(missed).toEqual([]);
  });

  test('every integration directory is inside the unit run', () => {
    // A PG-gated file skips itself there; the rest of the file still runs.
    expect(INTEGRATION_TEST_DIRS.filter((d) => !isUnder(d, UNIT_TEST_DIRS))).toEqual([]);
  });
});
