/**
 * Every error key the server throws has a sentence in the catalogs
 * (B15, 2026-10-30): 17 were missing, so users saw raw keys such as
 * order.errors.tooManyExtras. This scans the API and domain sources.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Development / test sign-in paths: the sign-in page maps these itself. */
const SIGN_IN_ONLY = new Set([
  'auth.errors.devBypassDisabled',
  'auth.errors.devBypassNoMember',
  'auth.errors.devDatabaseUnavailable',
  'auth.errors.devLocalhostOnly',
  'auth.errors.devMockSeedRequired',
  'auth.errors.devPersonaMissing',
  'auth.errors.invalidNonTelegramLogin',
  'auth.errors.nonTelegramAllowlistEmpty',
  'auth.errors.nonTelegramLoginDisabled',
  'auth.errors.nonTelegramProductionDisabled',
]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

describe('thrown error keys', () => {
  test('every key the server throws is in the en catalog', () => {
    const en = readFileSync(join(ROOT, 'packages/i18n/src/catalogs/en.ts'), 'utf8');
    const known = new Set([...en.matchAll(/^\s*'([a-zA-Z0-9_.]+)':/gm)].map((m) => m[1]));
    const missing = new Set<string>();
    for (const file of [...sources(join(ROOT, 'apps/api/src')), ...sources(join(ROOT, 'packages/domain/src'))]) {
      for (const m of readFileSync(file, 'utf8').matchAll(/['"]([a-z]+\.errors\.[a-zA-Z0-9_]+)['"]/g)) {
        if (!known.has(m[1]!) && !SIGN_IN_ONLY.has(m[1]!)) missing.add(m[1]!);
      }
    }
    expect([...missing].sort()).toEqual([]);
  });
});
