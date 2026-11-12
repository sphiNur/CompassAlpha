/**
 * D5 (2026-10-30): the whole-database wipe script (purge-fake-data.ts) is
 * refused on production unless COMPASS_ALLOW_BULK_PURGE=true. The api's
 * own workspace-wide purges are checked in the api's
 * bulk-purge-guard.test.ts.
 *
 * Moved here from the api's tests (review TEST1-16, 2026-11): they reached
 * into this package by relative path, and a failure here named the api.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wipeRefusal } from '../purgeGuard';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'purge-fake-data.ts');

describe('purge-fake-data.ts', () => {
  test('refusal reasons', () => {
    expect(wipeRefusal({ env: {}, unitInstalled: false })).toBeNull();
    expect(wipeRefusal({ env: { NODE_ENV: 'production' }, unitInstalled: false })).toContain(
      'NODE_ENV',
    );
    expect(
      wipeRefusal({ env: { COMPASS_RELEASE_CHANNEL: 'production' }, unitInstalled: false }),
    ).toContain('COMPASS_RELEASE_CHANNEL');
    // The api's NODE_ENV lives in its systemd unit, not in .env: the
    // installed unit marks a production host for a hand-run script.
    expect(wipeRefusal({ env: {}, unitInstalled: true })).toContain('compass-api.service');
    expect(
      wipeRefusal({
        env: { NODE_ENV: 'production', COMPASS_ALLOW_BULK_PURGE: 'true' },
        unitInstalled: true,
      }),
    ).toBeNull();
  });

  test('--apply exits 2 before touching the database on production', () => {
    // An unreachable database: if the guard did not stop it first, the
    // script would fail on the connection instead (exit 1). The script
    // runs on the bun that runs this test, not whichever is on PATH.
    const r = spawnSync(process.execPath, [SCRIPT, '--apply'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        COMPASS_ALLOW_BULK_PURGE: '',
        DATABASE_URL: 'postgres://unit:unit@127.0.0.1:1/unit_tests',
        DATABASE_URL_DIRECT: 'postgres://unit:unit@127.0.0.1:1/unit_tests',
      },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Refusing to wipe');
  }, 15_000);
});
