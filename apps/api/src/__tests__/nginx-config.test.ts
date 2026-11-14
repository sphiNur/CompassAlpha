/**
 * Review OPS-23 (2026-11-15): every path the api answers is forwarded by
 * the production nginx site (infra/nginx/compass-app.conf). POST
 * /csp-report and the attendance export link were not, so the reports
 * never arrived and the download got the SPA page.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CSP_REPORT_PATH } from '../http/cspReport';

const ROOT = join(import.meta.dir, '..', '..', '..', '..');
const conf = readFileSync(join(ROOT, 'infra', 'nginx', 'compass-app.conf'), 'utf8');
const appSrc = readFileSync(join(import.meta.dir, '..', 'app.ts'), 'utf8');

interface Location {
  exact: boolean;
  path: string;
  proxied: boolean;
}

/** The site's locations, and whether each passes to the api. */
function locations(): Location[] {
  const out: Location[] = [];
  const re = /location\s+(=\s+)?(\S+)\s*\{([^}]*)\}/g;
  for (const m of conf.matchAll(re)) {
    out.push({
      exact: !!m[1],
      path: m[2]!,
      proxied: /proxy_pass http:\/\/127\.0\.0\.1:3000;/.test(m[3]!),
    });
  }
  return out;
}

/** nginx's choice for a path: an exact match, else the longest prefix. */
function locationFor(path: string): Location | undefined {
  const all = locations();
  const exact = all.find((l) => l.exact && l.path === path);
  if (exact) return exact;
  return all
    .filter((l) => !l.exact && path.startsWith(l.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

/** The literal paths app.ts registers, a tRPC call and the socket. */
function apiPaths(): string[] {
  const paths = [...appSrc.matchAll(/app\.(?:get|post|put|delete|all)\(\s*'([^']+)'/g)].map(
    (m) => m[1]!,
  );
  expect(appSrc).toContain('app.post(\n    CSP_REPORT_PATH,');
  return [...paths, CSP_REPORT_PATH, '/trpc/auth.me', '/ws'];
}

describe('the nginx site forwards every api path (OPS-23)', () => {
  test('the routes are found', () => {
    expect(apiPaths()).toEqual(
      expect.arrayContaining(['/health/live', '/files/attendance-month.xlsx', '/csp-report']),
    );
  });

  test('each reaches the api, not the SPA fallback', () => {
    for (const path of apiPaths()) {
      expect({ path, proxied: locationFor(path)?.proxied }).toEqual({ path, proxied: true });
    }
  });

  test('the page itself and its assets are served by nginx', () => {
    expect(locationFor('/')?.proxied).toBe(false);
    expect(locationFor('/assets/index-abc.js')?.proxied).toBe(false);
  });
});
