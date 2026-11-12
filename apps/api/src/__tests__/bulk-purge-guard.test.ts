/**
 * D1 (2026-10-30): the api's workspace-wide purges are refused on
 * production unless COMPASS_ALLOW_BULK_PURGE=true. The route-level check
 * is in purge-guards.test.ts (PG-gated); the whole-database wipe script's
 * guard (D5) is tested in its own package, packages/db.
 */
import { describe, expect, test } from 'bun:test';
import { bulkPurgeAllowed } from '../services/bulkPurge';

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
