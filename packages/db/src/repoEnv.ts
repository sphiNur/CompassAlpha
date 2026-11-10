/**
 * The repository's `.env`, read the same way by every entry point: the API,
 * the worker, the CLI, the db scripts and the API tests (`@compass/db/env`).
 *
 * Review COREAPI-12 / TEST1-01 (2026-11): this was a hand-written loop
 * copied into 13 entry points and 34 test files. The copies only unquoted
 * double quotes, so a single-quoted value, a trailing comment or an
 * `export KEY=` line reached process.env as written.
 *
 * Only node built-ins are imported: an entry point loads the file before
 * anything that reads process.env is evaluated. In production systemd's
 * EnvironmentFile has already set every key, and a key that is set is
 * never replaced.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Parses `.env` text into key/value pairs. One `KEY=value` per line, with
 * an optional `export ` prefix. A value in single or double quotes is taken
 * as written between them (anything after the closing quote is ignored);
 * an unquoted value ends at a ` #` comment and is trimmed. Blank lines,
 * `#` comment lines and lines without `=` are skipped.
 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line
      .slice(0, eq)
      .replace(/^export\s+/, '')
      .trim();
    if (!key) continue;
    const rest = line.slice(eq + 1).trim();
    const quote = rest[0];
    if ((quote === '"' || quote === "'") && rest.indexOf(quote, 1) > 0) {
      out[key] = rest.slice(1, rest.indexOf(quote, 1));
      continue;
    }
    const comment = rest.search(/\s#/);
    out[key] = (comment < 0 ? rest : rest.slice(0, comment)).trim();
  }
  return out;
}

/**
 * Loads the `.env` next to `pnpm-workspace.yaml`, found by walking up from
 * the calling module (`import.meta.url`), into process.env. A variable that
 * is already set wins. Returns the file it read, or null when there is none.
 */
export function loadRepoEnv(fromUrl: string): string | null {
  let dir = dirname(fileURLToPath(fromUrl));
  for (let i = 0; i < 10; i++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate) && existsSync(resolve(dir, 'pnpm-workspace.yaml'))) {
      for (const [key, value] of Object.entries(parseEnv(readFileSync(candidate, 'utf8')))) {
        if (!(key in process.env)) process.env[key] = value;
      }
      return candidate;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
