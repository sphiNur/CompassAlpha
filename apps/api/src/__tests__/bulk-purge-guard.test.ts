/**
 * D1 / D5 (2026-10-30): the workspace-wide purges (api) and the
 * whole-database wipe script (packages/db/src/purge-fake-data.ts) are
 * refused on production unless COMPASS_ALLOW_BULK_PURGE=true.
 * The route-level check is in purge-guards.test.ts (PG-gated).
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bulkPurgeAllowed } from '../services/bulkPurge';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const { wipeRefusal } = (await import(resolve(ROOT, 'packages/db/src/purgeGuard.ts'))) as {
  wipeRefusal: (i: {
    env: Record<string, string | undefined>;
    unitInstalled: boolean;
  }) => string | null;
};

describe('api workspace-wide purges', () => {
  test('allowed off production', () => {
    expect(bulkPurgeAllowed({ NODE_ENV: 'development' })).toBe(true);
    expect(bulkPurgeAllowed({ NODE_ENV: 'test' })).toBe(true);
    expect(bulkPurgeAllowed({ NODE_ENV: 'production', COMPASS_RELEASE_CHANNEL: 'staging' })).toBe(
      false,
    );
  });
  test('refused on production by either signal', () => {
    expect(bulkPurgeAllowed({ NODE_ENV: 'production' })).toBe(false);
    expect(
      bulkPurgeAllowed({ NODE_ENV: 'development', COMPASS_RELEASE_CHANNEL: 'production' }),
    ).toBe(false);
    expect(bulkPurgeAllowed({ NODE_ENV: 'production', COMPASS_ALLOW_BULK_PURGE: 'false' })).toBe(
      false,
    );
  });
  test('the explicit switch allows them', () => {
    expect(bulkPurgeAllowed({ NODE_ENV: 'production', COMPASS_ALLOW_BULK_PURGE: 'true' })).toBe(
      true,
    );
  });
});

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
    // An unreachable DATABASE_URL: if the guard did not stop it first,
    // the script would fail on the connection instead (exit 1).
    const r = spawnSync('bun', ['run', 'packages/db/src/purge-fake-data.ts', '--apply'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        COMPASS_ALLOW_BULK_PURGE: '',
        DATABASE_URL: 'postgres://unit:unit@127.0.0.1:1/unit_tests',
      },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Refusing to wipe');
  }, 15_000);
});
