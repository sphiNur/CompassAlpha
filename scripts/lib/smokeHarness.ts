/**
 * What the two browser smokes share: the target URL, the signed-in session
 * they fake, the Telegram SDK stub, tRPC stubs, the catch-all that fails a
 * smoke on a call nobody stubbed, and the report. Each smoke keeps only its
 * own flow and data.
 *
 * Review OPS-25 (2026-11): each smoke used to carry its own copy, and the
 * copies drifted. The shallow smoke's session never got `org.admin` when the
 * deep one did (#199), and only the deep smoke failed on an unstubbed call;
 * in the shallow one such a call reached the live API with the fake token.
 *
 * The smokes run under `node --experimental-strip-types` (deploy.ts): this
 * file uses only erasable TypeScript, and they import it with its `.ts`
 * extension. Stub data is typed against the API's outputs, so `pnpm
 * type-check` fails when a procedure's output changes under a stub.
 */
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Request,
} from 'playwright';
import type { RouterOutputs } from '../../apps/api/src/trpc/outputs.ts';

/** COMPASS_BASE without a trailing slash; exits 2 when it is not set. */
export function smokeBase(): string {
  const raw = process.env.COMPASS_BASE;
  if (!raw) {
    console.error(
      '✖ COMPASS_BASE is required (e.g. https://<tunnel>.trycloudflare.com or http://localhost:3000)',
    );
    process.exit(2);
  }
  return raw.replace(/\/$/, '');
}

export const HEADLESS = process.env.HEADLESS !== '0';

/** `data-testid` is the stable contract. The English aria-label fallback
 *  keeps the smokes passing against the previous production bundle. */
export const PRIMARY_NAV_SELECTOR =
  ':is([data-testid="primary-nav"], nav[aria-label="Main sections"])';

export interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

/** Collects checks; `finish` prints them and exits 1 when any failed. */
export function createReport() {
  const results: Check[] = [];
  return {
    results,
    record(name: string, pass: boolean, detail?: string): void {
      results.push({ name, pass, ...(detail !== undefined ? { detail } : {}) });
    },
    finish(): void {
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
    },
  };
}

/** PLAYWRIGHT_CHANNEL=chrome uses the installed Google Chrome instead of
 *  Playwright's bundled build (e.g. on an OS Playwright has no build for). */
export async function launchSmoke(
  options: BrowserContextOptions,
): Promise<{ browser: Browser; context: BrowserContext }> {
  const browser = await chromium.launch({
    headless: HEADLESS,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  return { browser, context: await browser.newContext(options) };
}

// ---------------------------------------------------------------------------
// The fake sign-in
// ---------------------------------------------------------------------------

export const fakeUser = {
  id: 123456789,
  first_name: 'Smoke',
  username: 'smoke',
  language_code: 'en',
};

const PERMISSIONS = [
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
  // A real super admin holds org.admin; without it the Admin home lists
  // only Stores and Operations (#197), as it does for a store manager.
  'org.admin',
  'system.logs.view',
];

/** A super admin of one store, as auth.telegramLogin and auth.me return it. */
export const fakeSession = {
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
    orgName: 'Default Org',
    status: 'active',
    currency: 'UZS',
    taxRatePct: '0.00',
    pricesIncludeTax: true,
  },
  // Review OPS-25: typing the stubs showed these four had been missing
  // since the session gained them.
  memberships: [
    {
      orgId: 'org-default',
      orgSlug: 'default',
      orgName: 'Default Org',
      memberId: 'mem-smoke',
      status: 'active',
      joinedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  isPlatformAdmin: false,
  subscription: {
    planCode: 'standard',
    planName: 'Standard',
    status: 'active',
    writeAccess: true,
    trialEndsAt: null,
    currentPeriodEnd: null,
    graceEndsAt: null,
    cancelAtPeriodEnd: false,
    limits: { stores: null, members: null },
    usage: { stores: 1, members: 1 },
  },
  storePermissions: { 'store-1': PERMISSIONS },
  stores: [{ id: 'store-1', name: 'Smoke Store', code: 'SMOKE', isActive: true }],
  permissions: PERMISSIONS,
  roleSlugs: ['super_admin'],
  myMaxRank: 100,
  storeRanks: {},
  adminStoreIds: ['store-1'],
  needsOnboarding: false,
} satisfies RouterOutputs['auth']['me'];

export const fakeTokens = {
  accessToken: 'smoke-access-token',
  refreshToken: 'smoke-refresh-token',
  accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  refreshExpiresAt: new Date(Date.now() + 600_000).toISOString(),
};

/**
 * The Telegram WebApp SDK, which the page loads from telegram.org in
 * <head>. `MainButton.setText` throws on empty text like the real one (the
 * WebAppBottomButtonParamInvalid regression). `__compassMainButtonClick()`
 * and `__compassBackButtonClick()` tap the buttons through the handlers the
 * app registered, as Telegram would; every `showConfirm` is confirmed and
 * counted in `__compassConfirmCount`.
 */
function telegramSdkScript(): string {
  const initData = 'user=' + encodeURIComponent(JSON.stringify(fakeUser)) + '&hash=stub';
  return `
    (function() {
      var noop = function() {};
      var clickHandlers = [];
      var mainBtn = {
        text: '', isVisible: false, isActive: true,
        show: function(){ this.isVisible = true; },
        hide: function(){ this.isVisible = false; },
        enable: function(){ this.isActive = true; },
        disable: function(){ this.isActive = false; },
        setText: function(t){
          if (!t || !String(t).trim()) throw new Error('WebAppBottomButtonParamInvalid (test stub)');
          this.text = t;
        },
        onClick: function(cb){ clickHandlers.push(cb); },
        offClick: function(cb){ clickHandlers = clickHandlers.filter(function(h){ return h !== cb; }); },
        setParams: noop,
      };
      window.__compassMainButtonClick = function() {
        if (!mainBtn.isVisible || !mainBtn.isActive) return false;
        clickHandlers.forEach(function(h){ try { h(); } catch (e) {} });
        return true;
      };
      var backHandlers = [];
      var backBtn = {
        isVisible: false,
        show: function(){ this.isVisible = true; },
        hide: function(){ this.isVisible = false; },
        onClick: function(cb){ backHandlers.push(cb); },
        offClick: function(cb){ backHandlers = backHandlers.filter(function(h){ return h !== cb; }); },
      };
      window.__compassBackButtonClick = function() {
        if (!backBtn.isVisible) return false;
        backHandlers.forEach(function(h){ try { h(); } catch (e) {} });
        return true;
      };
      window.__compassConfirmCount = 0;
      window.Telegram = {
        WebApp: {
          initData: ${JSON.stringify(initData)},
          initDataUnsafe: { user: ${JSON.stringify(fakeUser)} },
          themeParams: {}, colorScheme: 'light',
          viewportHeight: window.innerHeight, isExpanded: true,
          expand: noop, ready: noop, close: noop,
          onEvent: noop, offEvent: noop,
          MainButton: mainBtn,
          BackButton: backBtn,
          HapticFeedback: { impactOccurred: noop, notificationOccurred: noop },
          showAlert: noop,
          showConfirm: function(_message, callback) {
            window.__compassConfirmCount += 1;
            if (typeof callback === 'function') callback(true);
          },
          openTelegramLink: noop, openLink: noop,
          setHeaderColor: noop, setBackgroundColor: noop,
        },
      };
    })();
  `;
}

/** Serves the SDK stub in place of telegram.org's script, and also runs it
 *  before any page script in case that request never happens. */
export async function stubTelegramSdk(context: BrowserContext): Promise<void> {
  const script = telegramSdkScript();
  await context.route('**/telegram.org/js/telegram-web-app.js', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/javascript' },
      body: script,
    }),
  );
  await context.addInitScript({ content: script });
}

// ---------------------------------------------------------------------------
// tRPC stubs
// ---------------------------------------------------------------------------

/** Every procedure, as `router.procedure` (e.g. `catalog.skus`). */
export type TrpcPath = {
  [R in keyof RouterOutputs & string]: `${R}.${keyof RouterOutputs[R] & string}`;
}[keyof RouterOutputs & string];

/** What the procedure at `P` returns. */
export type TrpcOutput<P extends TrpcPath> = P extends `${infer R}.${infer Q}`
  ? R extends keyof RouterOutputs
    ? Q extends keyof RouterOutputs[R]
      ? RouterOutputs[R][Q]
      : never
    : never
  : never;

type Answer<P extends TrpcPath> =
  | TrpcOutput<P>
  | ((request: Request) => TrpcOutput<P> | Promise<TrpcOutput<P>>);

const JSON_HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
};

/** The procedure path of a tRPC URL (`/trpc/catalog.skus?input=…` →
 *  `catalog.skus`), or null when it is not one. */
function trpcPathOf(url: URL): string | null {
  const at = url.pathname.indexOf('/trpc/');
  return at < 0 ? null : decodeURIComponent(url.pathname.slice(at + '/trpc/'.length));
}

/**
 * Answers every call to one procedure with `answer` (or what it returns for
 * the request). The name must match exactly: a glob such as `order.submit*`
 * would also take `order.submittedVersion`. A later stub for the same
 * procedure replaces an earlier one. An answer function that throws is
 * answered with a 500, which the page logs and the smoke then fails on.
 */
export async function stubTrpc<P extends TrpcPath>(
  context: BrowserContext,
  path: P,
  answer: Answer<P>,
): Promise<void> {
  await context.route(
    (url) => trpcPathOf(url) === path,
    async (route) => {
      try {
        const data = typeof answer === 'function' ? await answer(route.request()) : answer;
        await route.fulfill({
          status: 200,
          headers: JSON_HEADERS,
          body: JSON.stringify({ result: { data } }),
        });
      } catch (err) {
        const message = `smoke stub for ${path} threw: ${(err as Error).message}`;
        console.error(`  ${message}`);
        await route.fulfill({
          status: 500,
          headers: JSON_HEADERS,
          body: JSON.stringify({
            error: { message, code: -32603, data: { code: 'INTERNAL_SERVER_ERROR', path } },
          }),
        });
      }
    },
  );
}

/**
 * Answers every tRPC call no stub took with null and returns the set of
 * their names, for the smoke to fail on. Register it before any stub:
 * Playwright tries the most recently registered matching route first.
 *
 * 2026-11-05: order.submittedVersion (#190) went to the real server with
 * the fake token, got 401, and the failed refresh sent the app back to its
 * login loop; the smoke timed out much later on an unrelated step.
 * `passThrough` names the calls allowed to reach the server.
 */
export async function catchUnstubbedTrpc(
  context: BrowserContext,
  passThrough: ReadonlySet<string> = new Set(),
): Promise<Set<string>> {
  const unstubbed = new Set<string>();
  await context.route('**/trpc/**', async (route) => {
    const path = trpcPathOf(new URL(route.request().url())) ?? '';
    const names = path.split(',');
    if (names.every((n) => passThrough.has(n))) {
      await route.continue();
      return;
    }
    for (const n of names) if (!passThrough.has(n)) unstubbed.add(n);
    // A batched call (an older bundle) wants one result per procedure.
    const one = { result: { data: null } };
    await route.fulfill({
      status: 200,
      headers: JSON_HEADERS,
      body: JSON.stringify(names.length > 1 ? names.map(() => one) : one),
    });
  });
  return unstubbed;
}

/** useRealtime opens /ws?token=…, which the server refuses for the fake
 *  token; refusing it here keeps the retries out of the console. */
export async function blockRealtime(context: BrowserContext): Promise<void> {
  await context.route('**/ws*', (route) => route.abort('connectionrefused'));
}

/** Sign-in by Telegram, answered with fakeSession, and the nav badges. */
export async function stubSignIn(context: BrowserContext): Promise<void> {
  await stubTrpc(context, 'auth.loginModes', {
    environment: { nodeEnv: 'test', releaseChannel: 'development', localRequest: true },
    telegram: { available: true, hasBotToken: true, requiresInitData: true },
    devPersona: { available: false, enabled: false, reason: 'auth.errors.devBypassDisabled' },
    nonTelegram: {
      available: false,
      enabled: false,
      reason: 'auth.errors.nonTelegramLoginDisabled',
    },
  });
  await stubTrpc(context, 'auth.telegramLogin', { tokens: fakeTokens, session: fakeSession });
  await stubTrpc(context, 'auth.me', fakeSession);
  // nav.counts (#177): the bottom-nav badges.
  await stubTrpc(context, 'nav.counts', {
    approve: null,
    run: null,
    confirm: null,
    settlementDue: null,
  });
}

const NO_PAGES = {
  page: 1,
  pageSize: 20,
  totalCount: 0,
  totalPages: 0,
  hasPrevious: false,
  hasNext: false,
  firstRun: 0,
  lastRun: 0,
};

/**
 * The reads the tabs fire on first render, answered with an empty org that
 * has one store. A smoke that needs data stubs those procedures again after
 * this (the later stub wins).
 */
export async function stubAppReads(context: BrowserContext): Promise<void> {
  await stubTrpc(context, 'catalog.categories', []);
  await stubTrpc(context, 'catalog.skus', []);
  await stubTrpc(context, 'catalog.skuPriceStats', []);
  await stubTrpc(context, 'catalog.stores', []);
  await stubTrpc(context, 'catalog.suppliers', []);
  await stubTrpc(context, 'order.todaySession', null);
  await stubTrpc(context, 'order.todayBatches', []);
  // #190: what the store sent for review; null = nothing to show.
  await stubTrpc(context, 'order.submittedVersion', null);
  await stubTrpc(context, 'order.pendingList', []);
  await stubTrpc(context, 'run.list', []);
  await stubTrpc(context, 'run.history', {
    rows: [],
    pageInfo: NO_PAGES,
    summary: { total: '0', itemsTotal: '0', expensesTotal: '0', cash: '0', transfer: '0' },
  });
  await stubTrpc(context, 'run.expenseTemplates', []);
  await stubTrpc(context, 'run.previewCreatable', {
    date: '2026-05-01',
    today: '2026-05-01',
    sessions: [],
    plannedItems: [],
    perStoreDemand: [],
    perSessionDemand: [],
    supplierBySku: {},
    lastPurchasePriceBySku: {},
    perStoreBudgets: [],
    sessionNotesByStore: {},
    sessionExtrasByStore: {},
    total: 0,
  });
  await stubTrpc(context, 'settlement.get', null);
  await stubTrpc(context, 'settlement.businessDate', {
    storeId: 'store-1',
    date: '2026-05-01',
    timezone: 'Asia/Tashkent',
    canRecordOperatingExpenses: true,
  });
  // The wage picker loads this roster only after a wage row is added.
  await stubTrpc(context, 'settlement.wageRoster', [
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
  ]);
  await stubTrpc(context, 'settlement.recent', []);
  await stubTrpc(context, 'system.health', {
    status: 'ok',
    db: true,
    projectorLag: 0,
    outboxPending: 0,
    outboxOldestSec: null,
    version: 'smoke',
  });
  await stubTrpc(context, 'system.recentLogs', []);
  await stubTrpc(context, 'system.appConfig', {
    botUsername: 'CompassSmokeBot',
    bulkPurgeAllowed: false,
  });
  // usePhotoUploader (run and confirm pages): disabled keeps photo capture
  // on its data-URI fallback, so no bucket is needed.
  await stubTrpc(context, 'upload.config', {
    enabled: false,
    maxBytes: 8388608,
    allowedContentTypes: ['image/jpeg', 'image/png', 'image/webp'],
  });
  await stubTrpc(context, 'admin.overview', {
    memberCount: 0,
    storeCount: 0,
    skuCount: 0,
    runCount: 0,
    pendingApprovals: 0,
    ordersThisWeek: 0,
  });
  await stubTrpc(context, 'admin.memberList', []);
  await stubTrpc(context, 'admin.memberStoreAssignments', []);
  await stubTrpc(context, 'admin.storeList', []);
  await stubTrpc(context, 'admin.roleList', []);
  await stubTrpc(context, 'admin.categoryList', []);
  await stubTrpc(context, 'admin.skuList', []);
  await stubTrpc(context, 'admin.supplierList', []);
  await stubTrpc(context, 'admin.recentEvents', []);
  await stubTrpc(context, 'admin.sessionList', []);
  await stubTrpc(context, 'admin.runList', []);
  await stubTrpc(context, 'admin.submissionHistory', []);
  // Maintenance purges: dry-run answers, in case a flow opens them.
  await stubTrpc(context, 'admin.purgeByDate', {
    dryRun: true,
    total: 0,
    byTable: {},
    date: '2026-05-01',
    scope: { sameDay: { orders: 0, runs: 0 }, linkedOrders: [], linkedRuns: [] },
  });
  await stubTrpc(context, 'admin.purgeAllTestData', {
    dryRun: true,
    total: 0,
    byTable: {},
    orgSlug: 'default',
  });
  await stubTrpc(context, 'admin.purgeSession', {
    dryRun: true,
    total: 0,
    byTable: {},
    sessionId: '00000000-0000-0000-0000-000000000000',
  });
  await stubTrpc(context, 'admin.purgeRun', {
    dryRun: true,
    total: 0,
    byTable: {},
    runId: '00000000-0000-0000-0000-000000000000',
    sessionIds: [],
  });
}
