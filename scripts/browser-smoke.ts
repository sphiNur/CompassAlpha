/**
 * Headless browser smoke against the live URL.
 *
 * Catches the kind of bug that only surfaces inside a real DOM:
 * `WebAppBottomButtonParamInvalid`, the "black screen" module-load
 * failure, the broken ICU plural rendering, etc.
 *
 * Strategy (shared with browser-smoke-deep.ts, see scripts/lib/smokeHarness.ts):
 *   1. Replace the Telegram WebApp SDK with a stub carrying fake initData,
 *      so AuthGate's auto-login path can't throw.
 *   2. Answer auth.telegramLogin and every read the tabs fire with stubs
 *      (so we don't need a valid bot token to test the UI). A tRPC call
 *      nothing stubs fails the smoke by name instead of reaching the
 *      server with the fake token.
 *   3. Open the URL, wait for `<html class="ready">`, and assert each tab
 *      renders without unhandled JS errors.
 *
 * Usage:
 *   COMPASS_BASE=https://<your-tunnel>.trycloudflare.com node --experimental-strip-types scripts/browser-smoke.ts
 *   COMPASS_BASE=http://localhost:3000                   node --experimental-strip-types scripts/browser-smoke.ts
 *
 * On Windows, run this with Node. Bun's Playwright launcher can hang before
 * Chromium produces any output; the app is not failing in that case.
 *
 * COMPASS_BASE is required (P0-4, 2026-05-17 — stale-default footgun removed).
 */
import { fileURLToPath } from 'node:url';
import type { ConsoleMessage } from 'playwright';
import {
  HEADLESS,
  PRIMARY_NAV_SELECTOR,
  blockRealtime,
  catchUnstubbedTrpc,
  createReport,
  launchSmoke,
  smokeBase,
  stubAppReads,
  stubSignIn,
  stubTelegramSdk,
} from './lib/smokeHarness.ts';

const BASE = smokeBase();
const { record, finish } = createReport();

/**
 * Review OPS-40 (2026-11-11): a failure screenshot goes under the repo's
 * test-results/ (ignored), wherever the script runs from. It used to land
 * in the working directory, unignored, and the next deploy refused the
 * dirty tree.
 */
const failureShot = (name: string): string =>
  fileURLToPath(new URL(`../test-results/${name}`, import.meta.url));

async function run() {
  const { browser, context } = await launchSmoke({
    viewport: { width: 414, height: 896 }, // iPhone 11 Pro
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  });
  // First, so every stub registered after it takes precedence.
  const unstubbed = await catchUnstubbedTrpc(context, new Set(['system.log']));
  await stubTelegramSdk(context);
  await stubSignIn(context);
  await stubAppReads(context);
  await blockRealtime(context);

  const page = await context.newPage();
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const trpcCalls: Array<{ method: string; url: string; status?: number }> = [];
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
    if (process.env.SMOKE_VERBOSE) {
      console.log(`  [console.${msg.type()}] ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => pageErrors.push(`${err.name}: ${err.message}`));
  page.on('request', (req) => {
    if (req.url().includes('/trpc/')) trpcCalls.push({ method: req.method(), url: req.url() });
  });
  page.on('response', (res) => {
    if (res.url().includes('/trpc/')) {
      const last = trpcCalls.find((c) => c.url === res.url() && c.status === undefined);
      if (last) last.status = res.status();
    }
  });

  console.log(`▶ Browser smoke against ${BASE} (headless=${HEADLESS})\n`);

  try {
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    record('page loaded', true);

    // Boot splash should disappear once main.tsx mounts React (adds .ready).
    try {
      await page.waitForFunction(() => document.documentElement.classList.contains('ready'), {
        timeout: 15_000,
      });
      record('React mounted (.ready class added)', true);
    } catch (err) {
      record('React mounted (.ready class added)', false, (err as Error).message);
      // Capture screenshot on failure for forensics.
      await page.screenshot({ path: failureShot('smoke-failure.png'), fullPage: true });
    }

    // Auth should resolve (fake telegramLogin) → AuthGate releases → Shell mounts.
    try {
      await page.waitForSelector(PRIMARY_NAV_SELECTOR, { timeout: 8_000 });
      record('BottomNav rendered', true);
    } catch {
      record('BottomNav rendered', false, 'tab bar selector did not appear');
      // Capture diagnostics: which tRPC calls fired, what's currently on screen.
      console.log('\n  --- diagnostic: tRPC calls so far ---');
      for (const c of trpcCalls)
        console.log(
          `    ${c.method} ${new URL(c.url).pathname}  status=${c.status ?? '(no resp)'}`,
        );
      const visibleText = await page.evaluate(() => document.body.innerText.slice(0, 500));
      console.log('  --- diagnostic: visible text (first 500 chars) ---');
      console.log('    ' + visibleText.replace(/\n/g, '\n    '));
      const authState = await page.evaluate(
        () => window.localStorage.getItem('compass.auth') ?? '(empty)',
      );
      console.log('  --- diagnostic: compass.auth localStorage ---');
      console.log('    ' + authState.slice(0, 800));
      const authDebug = await page.evaluate(() =>
        JSON.stringify(
          (window as unknown as { __compassAuthDebug?: unknown }).__compassAuthDebug ?? null,
        ),
      );
      console.log('  --- diagnostic: AuthGate render state ---');
      console.log('    ' + authDebug);
      const rootHtml = await page.evaluate(
        () => document.querySelector('#root')?.innerHTML.slice(0, 800) ?? '(no #root)',
      );
      console.log('  --- diagnostic: #root html (first 800 chars) ---');
      console.log('    ' + rootHtml.replace(/\n/g, '\n    '));
      await page.screenshot({ path: failureShot('smoke-failure-shell.png'), fullPage: true });
    }

    // Walk every tab. Each click must not produce a JS error.
    const tabs = await page.$$(`${PRIMARY_NAV_SELECTOR} button`);
    record(`BottomNav has tabs (${tabs.length})`, tabs.length >= 1);
    // Helper: count errors that AREN'T expected stub-mode noise.
    const realErrorCount = () =>
      consoleErrors.filter(
        (e) => !/WebSocket connection to.*\/ws/i.test(e) && !/HTTP Authentication failed/.test(e),
      ).length + pageErrors.length;
    // Re-query each time: a tab click can re-render the nav (badges), which
    // detaches the handles collected above.
    for (let i = 0; i < tabs.length; i++) {
      const tab = (await page.$$(`${PRIMARY_NAV_SELECTOR} button`))[i];
      if (!tab) break;
      const label = (await tab.textContent())?.replace(/\s+/g, ' ').trim() ?? '?';
      const errorsBefore = realErrorCount();
      await tab.click();
      await page.waitForTimeout(400); // let render + suspended queries settle
      const errorsAfter = realErrorCount();
      const newErrors = errorsAfter - errorsBefore;
      record(`tab "${label}" rendered without new JS errors`, newErrors === 0, `+${newErrors}`);
    }

    // Final aggregate check.
    record('zero pageerror events', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
    // Allow-list: the refused WebSocket (blockRealtime) is logged to the
    // console; that is noise, not a bug. No tRPC call reaches the server
    // any more, so a 401 is no longer expected and no longer filtered.
    const unexpectedErrors = consoleErrors.filter(
      (e) => !/WebSocket connection to.*\/ws/i.test(e) && !/HTTP Authentication failed/.test(e),
    );
    record(
      'zero unexpected console.error',
      unexpectedErrors.length === 0,
      unexpectedErrors.slice(0, 3).join(' | '),
    );
    record(
      'every tRPC call was stubbed',
      unstubbed.size === 0,
      unstubbed.size ? `unstubbed: ${[...unstubbed].sort().join(', ')}` : undefined,
    );
  } finally {
    await browser.close();
  }

  finish();
}

run().catch((err) => {
  console.error('smoke harness threw:', err);
  process.exit(2);
});
