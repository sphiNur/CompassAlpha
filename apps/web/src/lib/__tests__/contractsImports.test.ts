/**
 * P-5 (2026-10-31): a value import from the `@compass/contracts` barrel
 * pulls the whole of zod and every schema into the web bundle (the schema
 * modules run `z.object(...)` at load, so they cannot be tree-shaken).
 * Web code imports values from the zod-free subpaths (`/limits`,
 * `/money`, `/schemas/roles`); `import type` from the barrel is free.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../..', import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === '__tests__' ? [] : sourceFiles(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

describe('web imports from @compass/contracts', () => {
  it('takes only types from the barrel', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/import\s+(type\s+)?[^;]*?from\s+'@compass\/contracts'/g)) {
        if (!m[1]) offenders.push(`${file.slice(SRC.length)}: ${m[0].replace(/\s+/g, ' ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
