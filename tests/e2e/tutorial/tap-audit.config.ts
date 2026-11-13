/**
 * The tap-target audit (tap-audit.tutorial.ts): the tutorial's stack,
 * demo workspace, database and ports, a different spec. On demand only,
 * with the tutorial's database and ports (README.md here):
 *
 *   cd tests/e2e && E2E_DATABASE_URL=postgres://compass:compass@localhost:5433/compass_e2e_tutorial \
 *     E2E_API_PORT=3198 E2E_WEB_PORT=5298 PLAYWRIGHT_CHANNEL=chrome \
 *     pnpm exec playwright test -c tutorial/tap-audit.config.ts
 */
import { defineConfig } from '@playwright/test';
import tutorial from './playwright.config';

export default defineConfig({
  ...tutorial,
  testMatch: /tap-audit\.tutorial\.ts$/,
  testIgnore: [],
  // Every screen in four languages at two widths.
  timeout: 4 * 60 * 60_000,
  outputDir: '../test-results/tap-audit',
  projects: [{ name: 'tap-audit' }],
});
