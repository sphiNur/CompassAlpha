/**
 * The tutorial's screenshots: the e2e stack (real api, real database,
 * web dev server), a demo workspace instead of the development seed, and
 * a phone. Run by run.ts once per interface language; never part of
 * `pnpm test:e2e` or CI (the e2e config only looks in ../tests).
 */
import { defineConfig } from '@playwright/test';
import base from '../playwright.config';
import { CAMERA_FILE } from './camera';
import { tutorialLang } from './lang';

const lang = tutorialLang();

export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: /\.tutorial\.ts$/,
  globalSetup: './global-setup.ts',
  // Each card is a test; seeding runs in the first one's beforeAll.
  timeout: 3 * 60_000,
  reporter: [['list']],
  outputDir: '../test-results/tutorial',
  use: {
    ...base.use,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: { en: 'en-US', zh: 'zh-CN', ru: 'ru-RU', uz: 'uz-UZ' }[lang],
    trace: 'retain-on-failure',
    screenshot: 'off',
    // The clock-in card opens the camera: a fake one, allowed without asking.
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        `--use-file-for-fake-video-capture=${CAMERA_FILE}`,
      ],
    },
  },
  projects: [{ name: `tutorial-${lang}` }],
  // The api as e2e starts it, with a bot name so invite links can be made.
  webServer: (Array.isArray(base.webServer) ? base.webServer : []).map((server, i) =>
    i === 0
      ? { ...server, env: { ...server.env, TELEGRAM_BOT_USERNAME: 'DemoCompassBot' } }
      : server,
  ),
});
