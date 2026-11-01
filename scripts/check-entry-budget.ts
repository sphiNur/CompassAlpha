/**
 * Startup JavaScript budget (DX-PFE-2 / DX-PFE-11, 2026-11-01).
 *
 * Every cold start downloads and parses the scripts index.html loads
 * before anything else: the entry chunk and whatever it modulepreloads.
 * That was 611 KB / 183 KB gzip, with the English catalog and the review
 * and receiving pages in it; on slow 3G the entry alone took 6.5 s.
 * Moving them out took it to ~140 KB gzip. Nothing stopped it creeping
 * back — one static import of a page or a catalog is enough — so CI
 * builds the web app and fails when the startup scripts pass the budget.
 *
 * Raising the budget is a decision, not a fix: first look at what grew
 * (`vite build` prints the chunk sizes) and whether it can be lazy.
 *
 *   bun run scripts/check-entry-budget.ts <dist dir>   (default apps/web/dist)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

/** gzip bytes the startup scripts may take together. */
export const STARTUP_GZIP_BUDGET = 150 * 1024;

/** The scripts index.html loads at startup: module entries and their modulepreloads. */
export function startupScripts(html: string): string[] {
  const urls = new Set<string>();
  for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
    if (!/\btype=["']module["']/.test(tag)) continue;
    const src = /\bsrc=["']([^"']+)["']/.exec(tag)?.[1];
    if (src) urls.add(src);
  }
  for (const tag of html.match(/<link\b[^>]*>/g) ?? []) {
    if (!/\brel=["']modulepreload["']/.test(tag)) continue;
    const href = /\bhref=["']([^"']+)["']/.exec(tag)?.[1];
    if (href) urls.add(href);
  }
  // Only our own files: an absolute URL is a third-party script.
  return [...urls].filter((url) => !/^[a-z]+:\/\//i.test(url));
}

export interface BudgetReport {
  files: Array<{ url: string; bytes: number; gzip: number }>;
  gzipTotal: number;
  budget: number;
  ok: boolean;
}

export function checkBudget(
  html: string,
  read: (url: string) => Buffer,
  budget = STARTUP_GZIP_BUDGET,
): BudgetReport {
  const files = startupScripts(html).map((url) => {
    const body = read(url);
    return { url, bytes: body.length, gzip: gzipSync(body, { level: 9 }).length };
  });
  if (files.length === 0) throw new Error('index.html loads no module script — is this a vite build?');
  const gzipTotal = files.reduce((sum, f) => sum + f.gzip, 0);
  return { files, gzipTotal, budget, ok: gzipTotal <= budget };
}

if (import.meta.main) {
  const dist = process.argv[2] ?? 'apps/web/dist';
  const html = readFileSync(join(dist, 'index.html'), 'utf8');
  const report = checkBudget(html, (url) => readFileSync(join(dist, url.replace(/^\.?\//, ''))));
  const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
  for (const f of report.files) console.log(`  ${f.url}  ${kb(f.bytes)}  gzip ${kb(f.gzip)}`);
  console.log(`startup scripts: gzip ${kb(report.gzipTotal)} of ${kb(report.budget)} budget`);
  if (!report.ok) {
    console.error(
      'Over budget. Something heavy joined the startup chunk — a static import of a page,\n' +
        'a catalog or a library. Make it lazy (see app/pageChunks.ts) rather than raising the budget.',
    );
    process.exit(1);
  }
}
