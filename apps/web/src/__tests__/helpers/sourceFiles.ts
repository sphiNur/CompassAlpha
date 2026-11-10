/**
 * Review TEST3-04 (2026-11): the app's own source files, for tests that
 * read code as text. One walker, so every scan leaves out the same files:
 * `__tests__` folders and the `*.test.ts(x)` kept beside the code (as in
 * pages/attendance).
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** apps/web/src/, with the slash, so `file.slice(SRC.length)` reads "pages/…". */
export const SRC = fileURLToPath(new URL('../..', import.meta.url));

/** Every .ts / .tsx file under `dir` (all of src by default), tests left out. */
export function sourceFiles(dir: string = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}
