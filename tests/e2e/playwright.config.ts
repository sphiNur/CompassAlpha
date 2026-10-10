import { defineConfig, devices } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_PORT, API_URL, DATABASE_URL, WEB_PORT, WEB_URL } from './env';

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
  retries: process.env.CI ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    ...devices['Pixel 7'],
    baseURL: WEB_URL,
    // Assertions read the English catalog.
    locale: 'en-US',
    timezoneId: 'Asia/Tashkent',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'bun run src/main.ts',
      cwd: resolve(ROOT, 'apps/api'),
      url: `${API_URL}/health/live`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        DATABASE_URL,
        PORT: String(API_PORT),
        HOST: '127.0.0.1',
        NODE_ENV: 'development',
        COMPASS_RELEASE_CHANNEL: 'development',
        DEV_MOCK_LOGIN_ENABLED: 'true',
        FRONTEND_URL: WEB_URL,
        JWT_SECRET: 'e2e-only-access-secret-0123456789abcdef',
        JWT_REFRESH_SECRET: 'e2e-only-refresh-secret-0123456789abcdef',
      },
    },
    {
      command: `pnpm exec vite --port ${WEB_PORT} --strictPort`,
      cwd: resolve(ROOT, 'apps/web'),
      url: WEB_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        VITE_API_URL: API_URL,
        VITE_WS_URL: `ws://localhost:${API_PORT}/ws`,
        VITE_DEV_MOCK_INIT_DATA: '1',
      },
    },
  ],
});
