/**
 * The `compass` operations CLI (packages/cli), run as a process (review
 * OPS-41, 2026-11). It lives here because CI's unit job covers `scripts`.
 *
 * DATABASE_URL points at a port nothing listens on: none of these runs
 * may need a database. A refusal must come before any query.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const CLI_SRC = join(ROOT, 'packages/cli/src');

function compass(...args: string[]): { code: number | null; out: string; err: string } {
  const run = Bun.spawnSync([process.execPath, join(CLI_SRC, 'index.ts'), ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: 'postgres://unit:unit@127.0.0.1:1/unit_tests',
      NO_COLOR: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 20_000,
  });
  return { code: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
}

/** Exit code 1 with the refusal's own words: no "[compass] Failed", no stack. */
function expectRefusal(run: ReturnType<typeof compass>, message: string): void {
  expect(run.code).toBe(1);
  expect(run.err).toContain(message);
  expect(run.err).not.toContain('[compass] Failed');
  expect(run.out).toBe('');
}

describe('compass CLI', () => {
  test('--version is the package version', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'packages/cli/package.json'), 'utf8')) as {
      version: string;
    };
    const run = compass('--version');
    expect(run.code).toBe(0);
    expect(run.out.trim()).toBe(pkg.version);
  });

  test('the "test purge" stub is gone: an unknown command, exit 1', () => {
    const run = compass(
      'test',
      'purge',
      '--org',
      'x',
      '--from',
      '2026-01-01',
      '--to',
      '2026-01-02',
    );
    expect(run.code).toBe(1);
    expect(run.err).toContain("unknown command 'test'");
  });

  test.each(['run', 'order', 'all'])('project rebuild %s points at reproject --type=%s', (s) => {
    expectRefusal(
      compass('project', 'rebuild', s),
      `Run instead: pnpm --filter @compass/api reproject --type=${s}\n`,
    );
  });

  test('project rebuild names the streams when given another', () => {
    const run = compass('project', 'rebuild', 'orders');
    expect(run.code).toBe(1);
    expect(run.err).toContain('Allowed choices are run, order, all.');
    expect(run.err).not.toContain('--type=');
  });

  // The last one is one past the largest Postgres bigint.
  const BAD_IDS: [string[], string][] = [
    [['platform', 'grant', '12abc'], '12abc'],
    [['platform', 'revoke', '0'], '0'],
    [['org', 'create', 'acme', '--owner', '1e9'], '1e9'],
    [['user', 'grant', '01', '--role', 'admin', '--org', 'acme'], '01'],
    [['platform', 'revoke', '9223372036854775808'], '9223372036854775808'],
  ];
  test.each(BAD_IDS)('%p refuses the Telegram id %p', (args, raw) => {
    expectRefusal(compass(...args), `Not a Telegram user id: ${raw}`);
  });

  test('the .env is loaded by the entry point first, by no command', () => {
    const index = readFileSync(join(CLI_SRC, 'index.ts'), 'utf8');
    const imports = index.split('\n').filter((line) => line.startsWith('import '));
    expect(imports[0]).toBe("import './env';");
    for (const file of readdirSync(join(CLI_SRC, 'commands'))) {
      expect(readFileSync(join(CLI_SRC, 'commands', file), 'utf8')).not.toContain('loadRepoEnv');
    }
  });
});
