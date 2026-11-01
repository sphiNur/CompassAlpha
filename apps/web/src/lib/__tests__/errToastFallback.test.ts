/**
 * DX-COPY-8 (2026-11-01): a failed write tells the user what to do next.
 * `common.error` ("Something went wrong") was the fallback of 99 calls;
 * mutations now fall back to `common.errors.actionFailed` or their own
 * failure sentence, and the bare title stays for load banners that carry
 * a Retry button.
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

describe('error toasts', () => {
  it('never fall back to the bare "Something went wrong"', () => {
    const found: string[] = [];
    for (const path of sourceFiles(SRC)) {
      const src = readFileSync(path, 'utf8');
      for (const m of src.matchAll(
        /errToast\('common\.error'\)|toast\.error\(i18n\.t\('common\.error'\)\)|translateError\([^)]*'common\.error'\)/g,
      )) {
        found.push(`${path.slice(SRC.length)}: ${m[0]}`);
      }
    }
    expect(found, `\n${found.join('\n')}\n`).toEqual([]);
  });
});
