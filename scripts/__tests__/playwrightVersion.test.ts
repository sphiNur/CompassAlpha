/**
 * Review OPS-20 (2026-11-10): one Playwright in the repository.
 *
 * The smokes import `playwright` (root package.json) and the e2e suite
 * `@playwright/test` (tests/e2e). Both said `^1.59.1`, and the lockfile
 * resolved them to 1.59.1 and 1.64.0, which need different browser
 * builds: CI installed only the e2e one, and the smokes' build once took
 * a whole night to download. Both are pinned to the same exact version,
 * and the lockfile may resolve only that one.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const devDeps = (rel: string) =>
  (JSON.parse(read(rel)) as { devDependencies?: Record<string, string> }).devDependencies ?? {};

describe('one Playwright (OPS-20)', () => {
  const smokes = devDeps('package.json').playwright;
  const e2e = devDeps('tests/e2e/package.json')['@playwright/test'];

  test('the smokes and the e2e suite pin the same exact version', () => {
    expect(smokes).toMatch(/^\d+\.\d+\.\d+$/);
    expect(e2e).toBe(smokes!);
  });

  test('the lockfile resolves that version and no other', () => {
    const lock = read('pnpm-lock.yaml');
    const versions = (name: string) => [
      ...new Set(
        [...lock.matchAll(new RegExp(`^  '?${name}@(\\d+\\.\\d+\\.\\d+)'?:`, 'gm'))].map(
          (m) => m[1],
        ),
      ),
    ];
    expect(versions('playwright')).toEqual([smokes!]);
    expect(versions('playwright-core')).toEqual([smokes!]);
    expect(versions('@playwright/test')).toEqual([smokes!]);
  });
});
