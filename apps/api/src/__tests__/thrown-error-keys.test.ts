/**
 * Every error key the server throws has a sentence in the catalogs
 * (B15, 2026-10-30): 17 were missing, so users saw raw keys such as
 * order.errors.tooManyExtras. This scans the API and domain sources.
 * 2026-10-31: the development / test sign-in keys are in the catalogs too
 * (RE-COPY-9), so there is no exception list any more.
 * 2026-11-11 (TEST2-15): the contracts (zod messages the web shows too) and
 * the worker are scanned as well, and keys written in backticks count. The
 * one key built at run time, attendance's `fail()`, is checked by tsc
 * instead: its `key` is typed from the catalog. Only en is read: the other
 * catalogs must have every en key, or the type-check fails.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
/** Where a key can reach a user from: thrown, or a zod message. */
const SCANNED = [
  'apps/api/src',
  'apps/worker/src',
  'packages/domain/src',
  'packages/contracts/src',
];

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
    const files = SCANNED.flatMap((dir) => sources(join(ROOT, dir)));
    for (const file of files) {
      for (const m of readFileSync(file, 'utf8').matchAll(
        /[`'"]([a-z]+\.errors\.[a-zA-Z0-9_]+)[`'"]/g,
      )) {
        if (!known.has(m[1]!)) missing.add(m[1]!);
      }
    }
    expect([...missing].sort()).toEqual([]);
  });

  test('the scan reads every root', () => {
    // A renamed folder would leave the test above passing on nothing.
    for (const dir of SCANNED) expect(sources(join(ROOT, dir)).length).toBeGreaterThan(0);
  });
});
