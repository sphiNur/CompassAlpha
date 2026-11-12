/**
 * Review DB-20 (2026-11-12): the catalog scripts worked on the organisation
 * with the slug 'default', which in production is one customer's
 * workspace. They now need `--org <slug>`, and stop before they open a
 * database connection without it.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { orgSlugArg } from '../scriptArgs';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('--org', () => {
  test('is read as a pair or with =', () => {
    expect(orgSlugArg(['--apply', '--org', 'north'])).toBe('north');
    expect(orgSlugArg(['--org=north', '--apply'])).toBe('north');
  });

  test('missing, empty or followed by another flag is no organisation', () => {
    expect(orgSlugArg(['--apply'])).toBeNull();
    expect(orgSlugArg(['--org'])).toBeNull();
    expect(orgSlugArg(['--org='])).toBeNull();
    expect(orgSlugArg(['--org', '--apply'])).toBeNull();
  });

  test('the catalog scripts refuse to start without it', () => {
    for (const script of ['import-catalog.ts', 'audit-sku-catalog.ts']) {
      const run = spawnSync('bun', [join(SRC, script), '--apply'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          // Unreachable on purpose: the check has to stop the script first.
          DATABASE_URL: 'postgres://none:none@127.0.0.1:1/never',
          DATABASE_URL_DIRECT: 'postgres://none:none@127.0.0.1:1/never',
        },
      });
      expect({ script, status: run.status, said: run.stderr.includes('--org <slug>') }).toEqual({
        script,
        status: 2,
        said: true,
      });
    }
  });
});
