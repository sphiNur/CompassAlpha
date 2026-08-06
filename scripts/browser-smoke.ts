/**
 * Headless browser smoke against the live URL.
 *
 * Catches the kind of bug that only surfaces inside a real DOM:
 * `WebAppBottomButtonParamInvalid`, the "black screen" module-load
 * failure, the broken ICU plural rendering, etc.
 *
 * Strategy:
 *   1. Stub `window.Telegram.WebApp` with a fake initData *before* any
 *      script runs so AuthGate's auto-login path can't throw.
 *   2. Block real /trpc/auth.telegramLogin requests at the network layer
 *      and respond with a synthetic session payload (so we don't need a
 *      valid bot token to test the UI).
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
import { chromium, type ConsoleMessage, type Page } from 'playwright';

// Use process.env (works under both Bun and Node) so this can run via
// `node --experimental-strip-types ...`.
const rawBase = process.env.COMPASS_BASE;
if (!rawBase) {
  console.error(
    '✖ COMPASS_BASE is required (e.g. https://<tunnel>.trycloudflare.com or http://localhost:3000)',
  );
  process.exit(2);
}
const BASE = rawBase.replace(/\/$/, '');
const HEADLESS = process.env.HEADLESS !== '0';
// `data-testid` is the stable contract. Keep the English aria-label fallback
// while validating the previous production bundle, which predates it.
const PRIMARY_NAV_SELECTOR = ':is([data-testid="primary-nav"], nav[aria-label="Main sections"])';

interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}
const results: Check[] = [];
function record(name: string, pass: boolean, detail?: string) {
  results.push({ name, pass, ...(detail !== undefined ? { detail } : {}) });
}

const fakeUser = { id: 6402913074, first_name: 'Smoke', username: 'smoke', language_code: 'en' };
const fakeSession = {
  user: {
    id: 'u-smoke',
    displayName: 'Smoke',
    displayNameLocked: true,
    avatarUrl: null,
    locale: 'en',
    secondaryLocale: null,
    tgUsername: 'smoke',
  },
  member: {
    memberId: 'mem-smoke',
    orgId: 'org-default',
    orgSlug: 'default',
    orgName: 'Default Organization',
    status: 'active',
    currency: 'UZS',
    taxRatePct: '0.00',
    pricesIncludeTax: true,
  },
  stores: [{ id: 'store-1', name: 'Smoke Store', code: 'SMOKE', isActive: true }],
  permissions: [
    'order.draft',
    'order.submit',
    'order.approve',
    'order.claim',
    'run.create',
    'run.purchase',
    'prices.view',
    'settlement.record',
    'delivery.dispatch',
    'delivery.confirm',
    'users.manage',
    'system.logs.view',
  ],
  roleSlugs: ['super_admin'],
  myMaxRank: 100,
  storeRanks: {},
  adminStoreIds: ['store-1'],
  needsOnboarding: false,
};
const fakeTokens = {
  accessToken: 'smoke-access-token',
  refreshToken: 'smoke-refresh-token',
  accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  refreshExpiresAt: new Date(Date.now() + 600_000).toISOString(),
};

async function run() {
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    viewport: { width: 414, height: 896 }, // iPhone 11 Pro
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  });

  // The page loads telegram.org/js/telegram-web-app.js in <head> and that
  // script overwrites whatever `window.Telegram` we set in addInitScript.
  // Route the fetch and return our own SDK shim instead.
  await context.route('**/telegram.org/js/telegram-web-app.js', async (route) => {
    const initDataString = 'user=' + encodeURIComponent(JSON.stringify(fakeUser)) + '&hash=stub';
    const script = `
      (function() {
        var noop = function() {};
        var stub = function() { throw new Error('WebAppBottomButtonParamInvalid (test stub)'); };
        var mainBtn = {
          text: '', isVisible: false, isActive: true,
          show: function(){ this.isVisible = true; },
          hide: function(){ this.isVisible = false; },
          enable: function(){ this.isActive = true; },
          disable: function(){ this.isActive = false; },
          setText: function(t){ if (!t || !String(t).trim()) { stub(); } this.text = t; },
          onClick: noop, offClick: noop, setParams: noop,
        };
        window.Telegram = {
          WebApp: {
            initData: ${JSON.stringify(initDataString)},
            initDataUnsafe: { user: ${JSON.stringify(fakeUser)} },
            themeParams: {},
            colorScheme: 'light',
            viewportHeight: window.innerHeight,
            isExpanded: true,
            expand: noop, ready: noop, close: noop,
            MainButton: mainBtn,
            BackButton: { isVisible: false, show: noop, hide: noop, onClick: noop, offClick: noop },
            HapticFeedback: { impactOccurred: noop, notificationOccurred: noop },
            showAlert: noop,
            showConfirm: function(_message, callback) {
              if (typeof callback === 'function') callback(true);
            },
            setHeaderColor: noop, setBackgroundColor: noop,
          },
        };
      })();
    `;
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/javascript' },
      body: script,
    });
  });

  // Belt-and-suspenders: also addInitScript so even if the route fails,
  // the global is set early. (The route fulfillment above is the
  // authoritative source.)
  await context.addInitScript(
    ({ user }) => {
      const noop = () => {};
      const smokeWindow = window as unknown as {
        Telegram: unknown;
      };
      smokeWindow.Telegram = {
        WebApp: {
          initData: 'user=' + encodeURIComponent(JSON.stringify(user)) + '&hash=stub',
          initDataUnsafe: { user },
          themeParams: {},
          colorScheme: 'light',
          viewportHeight: window.innerHeight,
          isExpanded: true,
          expand: noop,
          ready: noop,
          close: noop,
          MainButton: {
            text: '',
            isVisible: false,
            isActive: true,
            show() {
              this.isVisible = true;
            },
            hide() {
              this.isVisible = false;
            },
            enable() {
              this.isActive = true;
            },
            disable() {
              this.isActive = false;
            },
            setText(text: string) {
              // Throw on empty just like the real Telegram WebApp does. This
              // is the regression check for the WebAppBottomButtonParamInvalid
              // bug we shipped to prod earlier.
              if (!text || !text.trim()) {
                throw new Error('WebAppBottomButtonParamInvalid (test stub)');
              }
              this.text = text;
            },
            onClick: noop,
            offClick: noop,
            setParams: noop,
          },
          BackButton: { isVisible: false, show: noop, hide: noop, onClick: noop, offClick: noop },
          HapticFeedback: { impactOccurred: noop, notificationOccurred: noop },
          showAlert: noop,
          showConfirm(_message: string, callback?: (confirmed: boolean) => void) {
            callback?.(true);
          },
          setHeaderColor: noop,
          setBackgroundColor: noop,
        },
      };
    },
    { user: fakeUser },
  );

  // Stub auth.loginModes, auth.telegramLogin & auth.me at the network layer.
  await context.route('**/trpc/auth.loginModes*', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        result: {
          data: {
            environment: { nodeEnv: 'test', releaseChannel: 'development', localRequest: true },
            telegram: { available: true, hasBotToken: true, requiresInitData: true },
            devPersona: {
              available: false,
              enabled: false,
              reason: 'auth.errors.devBypassDisabled',
            },
            nonTelegram: {
              available: false,
              enabled: false,
              reason: 'auth.errors.nonTelegramLoginDisabled',
            },
          },
        },
      }),
    });
  });
  await context.route('**/trpc/auth.telegramLogin', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      body: JSON.stringify({
        result: { data: { tokens: fakeTokens, session: fakeSession } },
      }),
    });
  });
  await context.route('**/trpc/auth.me*', async (route) => {
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      body: JSON.stringify({ result: { data: fakeSession } }),
    });
  });
  // Stub the catalog queries — empty data is fine for a render smoke.
  for (const path of [
    'catalog.categories',
    'catalog.skus',
    'catalog.stores',
    'catalog.suppliers',
  ]) {
    await context.route(`**/trpc/${path}*`, async (route) => {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ result: { data: [] } }),
      });
    });
  }
  // Stub other reads that pages might fire during initial render.
  await context.route('**/trpc/order.todaySession*', async (r) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: { data: null } }),
    }),
  );
  await context.route('**/trpc/order.todayBatches*', async (r) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: { data: [] } }),
    }),
  );
  await context.route('**/trpc/order.pendingList*', async (r) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: { data: [] } }),
    }),
  );
  await context.route('**/trpc/run.list*', async (r) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: { data: [] } }),
    }),
  );
  await context.route('**/trpc/run.history*', async (r) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        result: {
          data: {
            rows: [],
            pageInfo: {
              page: 1,
              pageSize: 20,
              totalCount: 0,
              totalPages: 0,
              hasPrevious: false,
              hasNext: false,
            },
            summary: { total: '0', cash: '0', transfer: '0' },
          },
        },
      }),
    }),
  );
  await context.route('**/trpc/settlement.get*', async (r) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: { data: null } }),
    }),
  );
  await context.route('**/trpc/settlement.businessDate*', async (r) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        result: {
          data: {
            storeId: fakeSession.stores[0]?.id,
            date: '2026-05-01',
            timezone: 'Asia/Tashkent',
            canRecordOperatingExpenses: true,
          },
        },
      }),
    }),
  );
  // The wage picker loads this roster only after the user adds a wage row.
  // Keep its real response shape covered in the lightweight tab-render smoke
  // as well as the interaction coverage in browser-smoke-deep.ts.
  await context.route('**/trpc/settlement.wageRoster*', async (r) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        result: {
          data: [
            {
              memberId: 'mem-wage-cashier',
              displayName: 'Wage Cashier',
              roles: [{ id: 'role-cashier', slug: 'cashier', name: 'Cashier' }],
            },
            {
              memberId: 'mem-wage-manager',
              displayName: 'Wage Manager',
              roles: [{ id: 'role-manager', slug: 'manager', name: 'Manager' }],
            },
          ],
        },
      }),
    }),
  );
  await context.route('**/trpc/settlement.recent*', async (r) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: { data: [] } }),
    }),
  );
  await context.route('**/trpc/run.expenseTemplates*', async (r) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: { data: [] } }),
    }),
  );
  await context.route('**/trpc/run.previewCreatable*', async (r) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        result: {
          data: {
            date: '2026-05-01',
            sessions: [],
            plannedItems: [],
            // M1.5: extended preview shape.
            perStoreDemand: [],
            supplierBySku: {},
            total: 0,
          },
        },
      }),
    }),
  );
  await context.route('**/trpc/system.health*', async (r) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        result: { data: { status: 'ok', db: true, projectorLag: 0, version: 'smoke' } },
      }),
    }),
  );
  await context.route('**/trpc/system.recentLogs*', async (r) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: { data: [] } }),
    }),
  );
  // upload.config is queried by usePhotoUploader on RunPage + ConfirmPage.
  // Returning enabled:false keeps PhotoCapture in data-URI fallback mode
  // and avoids needing a real bucket during smoke.
  await context.route('**/trpc/upload.config*', async (r) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        result: {
          data: {
            enabled: false,
            maxBytes: 8388608,
            allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp'],
          },
        },
      }),
    }),
  );
  // Admin tab queries — stub all four to empty/zero so the page renders.
  await context.route('**/trpc/admin.overview*', async (r) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        result: {
          data: {
            memberCount: 0,
            storeCount: 0,
            skuCount: 0,
            runCount: 0,
            pendingApprovals: 0,
            ordersThisWeek: 0,
          },
        },
      }),
    }),
  );
  await context.route('**/trpc/admin.memberList*', async (r) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: { data: [] } }),
    }),
  );
  await context.route('**/trpc/admin.storeList*', async (r) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: { data: [] } }),
    }),
  );
  await context.route('**/trpc/admin.roleList*', async (r) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: { data: [] } }),
    }),
  );
  await context.route('**/trpc/admin.categoryList*', async (r) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: { data: [] } }),
    }),
  );
  await context.route('**/trpc/admin.skuList*', async (r) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: { data: [] } }),
    }),
  );
  await context.route('**/trpc/admin.supplierList*', async (r) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: { data: [] } }),
    }),
  );
  await context.route('**/trpc/admin.recentEvents*', async (r) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: { data: [] } }),
    }),
  );
  await context.route('**/trpc/system.appConfig*', async (r) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: { data: { botUsername: 'CompassSmokeBot' } } }),
    }),
  );
  // Maintenance purge endpoints — tests don't actually invoke them but
  // stubbing keeps the network noise clean if a future smoke does.
  await context.route('**/trpc/admin.purgeByDate*', async (r) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        result: { data: { dryRun: true, total: 0, byTable: {}, date: '2026-05-01' } },
      }),
    }),
  );
  await context.route('**/trpc/admin.purgeAllTestData*', async (r) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        result: { data: { dryRun: true, total: 0, byTable: {}, orgSlug: 'default' } },
      }),
    }),
  );
  await context.route('**/trpc/admin.sessionList*', async (r) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: { data: [] } }),
    }),
  );
  await context.route('**/trpc/admin.runList*', async (r) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: { data: [] } }),
    }),
  );
  await context.route('**/trpc/admin.purgeSession*', async (r) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        result: {
          data: {
            dryRun: true,
            total: 0,
            byTable: {},
            sessionId: '00000000-0000-0000-0000-000000000000',
          },
        },
      }),
    }),
  );
  await context.route('**/trpc/admin.purgeRun*', async (r) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        result: {
          data: {
            dryRun: true,
            total: 0,
            byTable: {},
            runId: '00000000-0000-0000-0000-000000000000',
            sessionIds: [],
          },
        },
      }),
    }),
  );
  await context.route('**/trpc/admin.memberStoreAssignments*', async (r) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: { data: [] } }),
    }),
  );
  await context.route('**/trpc/admin.submissionHistory*', async (r) =>
    r.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: { data: [] } }),
    }),
  );

  // useRealtime opens /ws?token=...; with our stubbed token the real
  // server would refuse. Block the request so we don't see retry noise.
  await context.route('**/ws*', async (r) => r.abort('connectionrefused'));

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
      await page.screenshot({ path: 'smoke-failure.png', fullPage: true });
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
      await page.screenshot({ path: 'smoke-failure-shell.png', fullPage: true });
    }

    // Walk every tab. Each click must not produce a JS error.
    const tabs = await page.$$(`${PRIMARY_NAV_SELECTOR} button`);
    record(`BottomNav has tabs (${tabs.length})`, tabs.length >= 1);
    // Helper: count errors that AREN'T expected stub-mode noise.
    const realErrorCount = () =>
      consoleErrors.filter(
        (e) => !/WebSocket connection to.*\/ws/i.test(e) && !/HTTP Authentication failed/.test(e),
      ).length + pageErrors.length;
    for (const tab of tabs) {
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
    // Allow-list: expected errors from stubbed flows. The smoke runs with
    // a fake token so the WebSocket handshake legitimately fails (HTTP 401),
    // which iOS/Chromium logs to the console as a TypeError. That's noise,
    // not a real bug, so we filter it out.
    const unexpectedErrors = consoleErrors.filter(
      (e) =>
        !/(401|UNAUTHORIZED|FORBIDDEN)/.test(e) &&
        !/WebSocket connection to.*\/ws/i.test(e) &&
        !/HTTP Authentication failed/.test(e),
    );
    record(
      'zero unexpected console.error',
      unexpectedErrors.length === 0,
      unexpectedErrors.slice(0, 3).join(' | '),
    );
  } finally {
    await browser.close();
  }

  // Render report.
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  for (const r of results) {
    const tag = r.pass ? '\x1b[32m PASS \x1b[0m' : '\x1b[31m FAIL \x1b[0m';
    const detail = r.detail ? `\x1b[2m — ${r.detail}\x1b[0m` : '';
    console.log(`${tag} ${r.name}${detail}`);
  }
  console.log(
    `\n${passed} / ${results.length} passed — ${failed.length} failure${failed.length === 1 ? '' : 's'}.`,
  );
  if (failed.length > 0) process.exit(1);
}

run().catch((err) => {
  console.error('smoke harness threw:', err);
  process.exit(2);
});
