/**
 * Every attendance error the router can send has a sentence in every
 * language. Split out of attendance.test.ts (review TEST1-17, 2026-11).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '@compass/i18n/catalogs';

describe('attendance copy', () => {
  test('every attendance error has a sentence in every language', async () => {
    const src = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../trpc/routers/attendance.ts'),
      'utf8',
    );
    const keys = [...src.matchAll(/fail\(\s*'[A-Z_]+',\s*'([A-Za-z]+)'/g)].map(
      (m) => `attendance.errors.${m[1]}`,
    );
    expect(keys.length).toBeGreaterThan(10);
    for (const locale of ['en', 'zh', 'ru', 'uz'] as const) {
      const catalog = await loadCatalog(locale);
      for (const key of keys)
        expect([locale, key, typeof catalog[key]]).toEqual([locale, key, 'string']);
    }
  });
});
