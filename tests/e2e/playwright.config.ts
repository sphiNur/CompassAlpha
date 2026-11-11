import { defineConfig, devices } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_PORT, API_URL, APP_DATABASE_URL, BOT_TOKEN, WEB_PORT, WEB_URL } from './env';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The app as a person in a browser meets it: the real api on a real
 * database, the web dev server, and the development login (the only
 * sign-in that needs no Telegram client). Nothing is stubbed.
 */
export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  // One database, one story told in order.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // No retries. globalSetup resets the database once per run, so a retry
  // would start the story again on what the first attempt left behind:
  // it could only fail, at its first step, far from the real failure.
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    ...devices['Pixel 7'],
    // PLAYWRIGHT_CHANNEL=chrome runs on the installed Google Chrome.
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
    baseURL: WEB_URL,
    // Assertions read the English catalog.
    locale: 'en-US',
    timezoneId: 'Asia/Tashkent',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    // Walks the app from a fresh database.
    { name: 'story', testMatch: /main-flow\.spec\.ts$/ },
    // Measure the screens the story leaves: a run in buying with one
    // item bought and one to buy.
    {
      name: 'after-story',
      testMatch: /(render-count|narrow-screen)\.spec\.ts$/,
      dependencies: ['story'],
    },
    // Need no particular state.
    {
      name: 'standalone',
      testIgnore: [/main-flow\.spec\.ts$/, /render-count\.spec\.ts$/, /narrow-screen\.spec\.ts$/],
    },
  ],
  // Never reuse a server already on the port: it may be connected to
  // another database, and only E2E_DATABASE_URL is reset for the run.
  webServer: [
    {
      command: 'bun run src/main.ts',
      cwd: resolve(ROOT, 'apps/api'),
      url: `${API_URL}/health/live`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        DATABASE_URL: APP_DATABASE_URL,
        // A query with neither a tenant nor a declared system context is a
        // bug that would leak between customers; here it fails the run.
        DB_TENANT_PROBE: 'throw',
        PORT: String(API_PORT),
        HOST: '127.0.0.1',
        NODE_ENV: 'development',
        COMPASS_RELEASE_CHANNEL: 'development',
        DEV_MOCK_LOGIN_ENABLED: 'true',
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        FRONTEND_URL: WEB_URL,
        JWT_SECRET: 'e2e-only-access-secret-0123456789abcdef',
        JWT_REFRESH_SECRET: 'e2e-only-refresh-secret-0123456789abcdef',
      },
    },
    {
      command: `pnpm exec vite --port ${WEB_PORT} --strictPort`,
      cwd: resolve(ROOT, 'apps/web'),
      url: WEB_URL,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        VITE_API_URL: API_URL,
        VITE_WS_URL: `ws://localhost:${API_PORT}/ws`,
        VITE_DEV_MOCK_INIT_DATA: '1',
      },
    },
  ],
});
