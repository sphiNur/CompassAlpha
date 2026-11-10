/**
 * Review RUNAPI-16 / ADM1-10 / ADM2-03 (2026-11-09): no `sql.raw` in the
 * API's source. Every use was an id list spliced as `'${id}'`, which
 * CONTRIBUTING forbids; services/sqlIn.ts binds each id as a parameter
 * instead. Tests may still run raw SQL files.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SRC = resolve(import.meta.dir, '..');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '__tests__' && name !== 'node_modules') out.push(...sourceFiles(path));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      out.push(path);
    }
  }
  return out;
}

describe('API SQL', () => {
  test('no sql.raw outside tests (use inUuids / inTexts or a bound parameter)', () => {
    const offenders = sourceFiles(SRC).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((line, i) => ({ line, at: `${relative(SRC, file)}:${i + 1}` }))
        .filter(({ line }) => line.includes('sql.raw('))
        .map(({ at }) => at),
    );
    expect(offenders).toEqual([]);
  });
});
