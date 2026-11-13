/**
 * Regenerate the tutorial screenshots: one walk per interface language,
 * each on a freshly seeded demo workspace, then tutorial-out/manifest.json.
 *
 *   bun run tutorial:shots            # zh ru uz en
 *   bun run tutorial:shots ru en      # just these
 *
 * See README.md in this folder for what it needs.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locale } from '@compass/i18n';
import { LOCALES } from './demo';
import { OUT_DIR, type CardRecord } from './shots';

const E2E_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const asked = process.argv.slice(2);
for (const l of asked) {
  if (!LOCALES.includes(l as Locale)) {
    console.error(`Unknown language "${l}"; use any of ${LOCALES.join(' ')}`);
    process.exit(2);
  }
}
const langs = (asked.length ? asked : LOCALES) as Locale[];

// Its own database and ports, so it never meets the e2e run's.
const env = {
  ...process.env,
  E2E_DATABASE_URL:
    process.env.E2E_DATABASE_URL ??
    'postgres://compass:compass@localhost:5433/compass_e2e_tutorial',
  E2E_API_PORT: process.env.E2E_API_PORT ?? '3198',
  E2E_WEB_PORT: process.env.E2E_WEB_PORT ?? '5298',
};

const failed: Locale[] = [];
for (const lang of langs) {
  console.log(`\n── ${lang} ──`);
  const run = spawnSync(
    'pnpm',
    ['exec', 'playwright', 'test', '-c', 'tutorial/playwright.config.ts'],
    {
      cwd: E2E_DIR,
      stdio: 'inherit',
      env: { ...env, TUTORIAL_LANG: lang },
    },
  );
  if (run.status !== 0) failed.push(lang);
}

writeManifest();
if (failed.length) {
  console.error(`\nThe walk failed in: ${failed.join(', ')} (their cards stop where it failed).`);
  process.exit(1);
}
console.log(`\nScreenshots and manifest.json in ${OUT_DIR}`);

interface Part {
  lang: Locale;
  cards: CardRecord[];
}

/** Every language's part, card by card and step by step. */
function writeManifest(): void {
  const parts: Part[] = LOCALES.map((l) => join(OUT_DIR, '.parts', `${l}.json`))
    .filter((f) => existsSync(f))
    .map((f) => JSON.parse(readFileSync(f, 'utf8')) as Part);
  if (!parts.length) return;
  // The English walk (or the first there is) gives the order and the taps.
  const lead = parts.find((p) => p.lang === 'en') ?? parts[0]!;
  const cards = lead.cards.map((card) => {
    const inLang = (lang: Locale) =>
      parts.find((p) => p.lang === lang)?.cards.find((c) => c.id === card.id);
    const steps = card.steps.map((step, i) => {
      const per = (pick: (s: CardRecord['steps'][number]) => string | null) =>
        Object.fromEntries(
          parts.flatMap((p) => {
            const s = inLang(p.lang)?.steps[i];
            return s && s.id === step.id ? [[p.lang, pick(s)]] : [];
          }),
        );
      return {
        id: step.id,
        screenshot: per((s) => s.screenshot),
        label: per((s) => s.label),
        taps: step.taps,
        ...(step.note ? { note: step.note } : {}),
      };
    });
    return {
      id: card.id,
      role: card.role,
      title: card.title,
      totalTaps: steps.reduce((n, s) => n + s.taps, 0),
      steps,
      ...(card.notes.length ? { notes: card.notes } : {}),
    };
  });
  const manifest = {
    generatedAt: new Date().toISOString(),
    languages: parts.map((p) => p.lang),
    screenshotsRelativeTo: 'tutorial-out/',
    viewport: { width: 390, height: 844, deviceScaleFactor: 2 },
    cards,
  };
  writeFileSync(join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}
