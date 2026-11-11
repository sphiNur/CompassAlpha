/**
 * Review COREAPI-10 / CONF-09 (2026-11): the direction of the API's
 * imports. A router depends on services and never on another router: the
 * nav router took its run-planning scope from the run router, and the
 * attendance router the wage roster from the settlement router, so editing
 * one router could change another. Nothing outside trpc/ imports a router;
 * trpc/router.ts assembles them. A router kept as a directory of files
 * (routers/admin/, review ADM1-11) is one router: its files import each
 * other.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SRC = resolve(import.meta.dir, '..');

/**
 * The one known exception, still to move: the attendance spreadsheet export
 * builds its month with the attendance router's loadMonthSheet, and the
 * sheet's helpers live in that router. Moving them to a service is a change
 * of its own; this list must then shrink.
 */
const KNOWN_OUTSIDE = ['http/attendanceExport.ts → trpc/routers/attendance'];

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

/** The router a path under trpc/routers/ belongs to (`admin` for routers/admin.ts and routers/admin/*), else null. */
function routerOf(path: string): string | null {
  return /^trpc\/routers\/([^/.]+)/.exec(path)?.[1] ?? null;
}

/** Each relative import of `file` that lands in another router, as "file → import". */
function routerImports(file: string): string[] {
  const own = routerOf(relative(SRC, file));
  return [...readFileSync(file, 'utf8').matchAll(/from '(\.{1,2}\/[^']+)'/g)]
    .map((m) => relative(SRC, resolve(file, '..', m[1]!)))
    .filter((target) => routerOf(target) !== null && routerOf(target) !== own)
    .map((target) => `${relative(SRC, file)} → ${target}`);
}

describe('API layering', () => {
  test('a router imports no other router', () => {
    expect(sourceFiles(join(SRC, 'trpc/routers')).flatMap(routerImports)).toEqual([]);
  });

  test('outside trpc/, nothing imports a router', () => {
    const outside = sourceFiles(SRC).filter((file) => !relative(SRC, file).startsWith('trpc/'));
    expect(outside.length).toBeGreaterThan(20);
    expect(outside.flatMap(routerImports)).toEqual(KNOWN_OUTSIDE);
  });
});
