/**
 * Tap-target audit (review WALK-03, 2026-11-13): every control on every
 * screen and sheet an owner, a manager, a staff member, a purchaser and a
 * cashier reach, at 360×740 and 390×844, in each interface language, must
 * take a tap of at least 44×44 px (docs/UI_STANDARDS.md, the kit's
 * hit-44). Run on demand, never in CI:
 *
 *   cd tests/e2e && E2E_DATABASE_URL=postgres://compass:compass@localhost:5433/compass_e2e_tutorial \
 *     E2E_API_PORT=3198 E2E_WEB_PORT=5298 PLAYWRIGHT_CHANNEL=chrome \
 *     pnpm exec playwright test -c tutorial/tap-audit.config.ts
 *
 * It seeds the tutorial's demo workspace, moves it through an order's
 * life (a draft, submitted, being bought, being delivered) and at each
 * point opens every tab and admin page as each person, measures them
 * (tapMeasure.ts), then taps every button on the screen once and measures
 * the sheet it opens. Writes made while measuring never reach the api:
 * the audit's phones have their mutations refused.
 *
 * Output (TAP_AUDIT_OUT, default tutorial-out/tap-audit): report.json
 * (every control under 44 in either dimension, with where and in which
 * languages and widths) and report.md. Narrow a run with TAP_AUDIT_LANGS
 * ("zh,en"), TAP_AUDIT_VIEWPORTS ("360") and TAP_AUDIT_CRAWL ("360", the
 * widths at which buttons are tapped to open sheets; "none" for none).
 */
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locale } from '@compass/i18n';
import { API_URL } from '../env';
import { mutate, type Login } from './api';
import { LOCALES, STORES, skuName, type Role } from './demo';
import { translator, type T } from './i18n';
import { seedDemo, type Demo } from './seed';
import { openAs } from './shots';
import { measureTapTargets, type TapTarget } from './tapMeasure';

test.describe.configure({ mode: 'serial' });

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const OUT = resolve(ROOT, process.env.TAP_AUDIT_OUT ?? 'tutorial-out/tap-audit');
const MIN = 44;
/** Integer sampling of a 44 px span can read 43. */
const TOLERANCE = 1;

const list = (v: string | undefined): string[] | null =>
  v
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : null;
const LANGS = (list(process.env.TAP_AUDIT_LANGS) ?? [...LOCALES]) as Locale[];
const VIEWPORTS: Record<string, { width: number; height: number }> = {
  '360': { width: 360, height: 740 },
  '390': { width: 390, height: 844 },
};
const WIDTHS = list(process.env.TAP_AUDIT_VIEWPORTS) ?? ['360', '390'];
const CRAWL = list(process.env.TAP_AUDIT_CRAWL) ?? ['360'];

type AuditRole = Exclude<Role, 'clocker'>;

interface Finding extends Omit<TapTarget, 'box' | 'tap'> {
  view: string;
  role: AuditRole;
  stage: string;
  /** lang@width → tap size (box size). */
  sizes: Record<string, string>;
  minTap: { w: number; h: number };
}

const findings = new Map<string, Finding>();
/** Buttons already tapped to see what they open. */
const crawled = new Set<string>();
let measured = 0;

function record(stage: string, role: AuditRole, view: string, where: string, targets: TapTarget[]) {
  for (const t of targets) {
    measured++;
    if (t.tap.w >= MIN - TOLERANCE && t.tap.h >= MIN - TOLERANCE) continue;
    // Labels with numbers in them (a count, a date) vary; the classes find the source.
    const key = [view, t.tag, t.role, t.label.replace(/\d+/g, '#'), t.classes].join('|');
    let f = findings.get(key);
    if (!f) {
      const { box: _box, tap: _tap, ...rest } = t;
      f = { ...rest, view, role, stage, sizes: {}, minTap: { ...t.tap } };
      findings.set(key, f);
    }
    f.sizes[where] = `${t.tap.w}×${t.tap.h} (box ${t.box.w}×${t.box.h}, ${t.how})`;
    f.minTap = { w: Math.min(f.minTap.w, t.tap.w), h: Math.min(f.minTap.h, t.tap.h) };
  }
}

// ─────────────────────────── the story's phones ───────────────────────────

let t: T;
let demo: Demo;
let browser: Browser;
const phones = new Map<Role, { context: BrowserContext; page: Page }>();

test.beforeAll(async ({ browser: b }) => {
  browser = b;
  t = await translator('en');
  demo = await seedDemo('en', browser);
});

test.afterAll(async () => {
  for (const { context } of phones.values()) await context.close();
  writeReport();
});

async function phone(who: Role): Promise<Page> {
  let p = phones.get(who);
  if (!p) {
    p = await openAs(browser, demo.logins[who]);
    phones.set(who, p);
  }
  return p.page;
}

const main = (page: Page): Locator => page.getByRole('main');
const sheet = (page: Page): Locator => page.getByRole('dialog');
const tab = (page: Page, name: string): Locator => page.getByTestId(`nav-${name}`);
const mainButton = (page: Page): Locator => page.getByTestId('page-main-button');
const row = (page: Page, code: string): Locator =>
  main(page)
    .getByRole('listitem')
    .filter({ hasText: skuName(code, 'en') })
    .last();

async function addToOrder(page: Page, code: string, n: number): Promise<void> {
  const saved = page.waitForResponse((res) => res.url().includes('order.adjustItem'));
  for (let i = 0; i < n; i++) {
    await row(page, code)
      .getByRole('button', { name: t('qty.increment') })
      .click();
  }
  await saved;
}

async function reach(page: Page, sign: Locator): Promise<void> {
  try {
    await expect(sign.first()).toBeVisible({ timeout: 8_000 });
  } catch {
    await page.reload();
    await expect(sign.first()).toBeVisible({ timeout: 15_000 });
  }
}

// ─────────────────────────────── the audit ───────────────────────────────

interface Nav {
  tab: string;
  adminSection?: string;
  catalogSub?: string | null;
  opsSub?: string | null;
  storeFocus?: { kind: 'store'; storeId: string; storeName: string } | { kind: 'org-level' } | null;
  storeSub?: string;
}

function viewName(nav: Nav): string {
  if (nav.tab !== 'admin') return nav.tab;
  const parts = ['admin', nav.adminSection ?? 'home'];
  if (nav.catalogSub) parts.push(nav.catalogSub);
  if (nav.opsSub) parts.push(nav.opsSub);
  if (nav.storeFocus) {
    parts.push(nav.storeFocus.kind === 'store' ? nav.storeFocus.storeName : 'org-level');
    parts.push(nav.storeSub ?? 'team');
  }
  return parts.join('/');
}

function adminViews(): Nav[] {
  const a = (adminSection: string, more: Partial<Nav> = {}): Nav => ({
    tab: 'admin',
    adminSection,
    ...more,
  });
  const central = {
    kind: 'store' as const,
    storeId: demo.stores.central,
    storeName: STORES.en.central,
  };
  return [
    a('home'),
    a('organization'),
    a('stores'),
    ...['team', 'settings', 'inventory', 'sales'].map((storeSub) =>
      a('stores', { storeFocus: central, storeSub }),
    ),
    a('stores', { storeFocus: { kind: 'org-level' }, storeSub: 'team' }),
    a('permissions'),
    a('catalog'),
    ...['categories', 'skus', 'suppliers', 'dishes', 'expenseTemplates'].map((catalogSub) =>
      a('catalog', { catalogSub }),
    ),
    a('operations'),
    // maintenance is never restored from storage (navStore), so not here.
    ...['activity', 'history', 'adminAudit', 'priceReport', 'finance'].map((opsSub) =>
      a('operations', { opsSub }),
    ),
    a('attendance'),
    a('platform'),
  ];
}

async function goView(page: Page, auth: string, nav: Nav): Promise<boolean> {
  await page.evaluate(
    ([auth, nav]) => {
      localStorage.setItem('compass.auth', auth!);
      localStorage.setItem(
        'compass.nav.v1',
        JSON.stringify({
          state: {
            adminSection: 'home',
            catalogSub: null,
            opsSub: null,
            storeFocus: null,
            storeSub: 'team',
            ...JSON.parse(nav!),
          },
          version: 0,
        }),
      );
    },
    [auth, JSON.stringify(nav)],
  );
  await page.reload();
  try {
    await page.getByRole('main').waitFor({ timeout: 15_000 });
  } catch {
    return false;
  }
  await settle(page);
  return true;
}

/**
 * The screen has its data: no spinner for a moment. (Not networkidle:
 * the app's polling keeps the network busy, and each wait ran out.)
 */
async function settle(page: Page): Promise<void> {
  await page
    .waitForFunction(() => !document.querySelector('main [class*="animate-[spin"]'), undefined, {
      timeout: 5_000,
      polling: 100,
    })
    .catch(() => {});
  await page.waitForTimeout(200);
}

const measure = (page: Page, scope: 'page' | 'dialog'): Promise<TapTarget[]> =>
  page.evaluate(measureTapTargets, scope);

/** What the screen shows, to tell whether a tap changed it. */
const signature = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const m = document.querySelector('main');
    return `${location.pathname}|${(m?.innerText ?? '').length}|${m?.querySelectorAll('button,input').length}`;
  });

const dialogOpen = (page: Page): Promise<boolean> =>
  page.evaluate(() =>
    [...document.querySelectorAll('[role=dialog],[role=alertdialog]')].some(
      (d) => d.getClientRects().length > 0,
    ),
  );

/**
 * Buttons on the page (not in a sheet, not the bottom nav, not a field)
 * that might open something, as [index among the query, label].
 */
const tappables = (page: Page): Promise<Array<[number, string, boolean]>> =>
  page.evaluate(() => {
    const els = [
      ...document.querySelectorAll<HTMLElement>(
        'button, [role=button], [role=tab], [role=radio], [role=menuitem], [role=switch], a[href^="#"]',
      ),
    ];
    return els
      .map((el, i): [number, string, boolean, boolean] => {
        const r = el.getBoundingClientRect();
        const ok =
          r.width > 1 &&
          r.height > 1 &&
          !el.closest(
            '[role=dialog],[role=alertdialog],[data-testid=primary-nav],[aria-hidden="true"],[inert]',
          ) &&
          !(el as HTMLButtonElement).disabled;
        const label = (
          el.getAttribute('aria-label') ||
          el.innerText ||
          el.getAttribute('title') ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 60);
        return [i, label, !!el.closest('header'), ok];
      })
      .filter((x) => x[3])
      .map(([i, label, inHeader]) => [i, label, inHeader]);
  });

const tapNth = (page: Page, i: number): Promise<boolean> =>
  page.evaluate((i) => {
    const el = document.querySelectorAll<HTMLElement>(
      'button, [role=button], [role=tab], [role=radio], [role=menuitem], [role=switch], a[href^="#"]',
    )[i];
    if (!el) return false;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.click();
    return true;
  }, i);

async function auditRole(stage: string, role: AuditRole, lang: Locale, width: string) {
  const login: Login = demo.logins[role];
  const session = await mutate<Login['session']>(login.accessToken, 'auth.setLocale', {
    locale: lang,
  });
  const context = await browser.newContext({
    viewport: VIEWPORTS[width]!,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  });
  context.setDefaultTimeout(20_000);
  const page = await context.newPage();
  // Same origin, no app code: where the sign-in is stored before the app boots.
  await page.goto('/boot.css');
  await page.evaluate(
    (state) => localStorage.setItem('compass.auth', state),
    JSON.stringify({
      state: {
        accessToken: login.accessToken,
        refreshToken: login.refreshToken,
        session,
        currentStoreId: null,
      },
      version: 0,
    }),
  );
  await page.goto('/');
  await page.getByRole('main').waitFor();
  await settle(page);
  const where = `${lang}@${width}`;
  try {
    // Nothing the audit taps is written.
    await context.route(`${API_URL}/trpc/**`, (route) => {
      const req = route.request();
      if (req.method() === 'POST' && !req.url().includes('auth.refresh')) return route.abort();
      return route.continue();
    });
    page.on('dialog', (d) => void d.dismiss().catch(() => {}));
    const auth = await page.evaluate(() => localStorage.getItem('compass.auth')!);
    const tabs = await page
      .locator('[data-testid^="nav-"]:not([data-testid^="nav-badge"])')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.slice(4)));
    const current = await page.evaluate(() => {
      try {
        return JSON.parse(localStorage.getItem('compass.nav.v1') ?? '{}').state?.tab ?? 'order';
      } catch {
        return 'order';
      }
    });
    const views: Nav[] = (tabs.length ? tabs : [current]).flatMap((tabKey) =>
      tabKey === 'admin' ? adminViews() : [{ tab: tabKey }],
    );
    const crawl = CRAWL.includes(width);
    const tappedHeader = new Set<string>();
    for (const nav of views) {
      const view = viewName(nav);
      if (!(await goView(page, auth, nav))) continue;
      record(stage, role, view, where, await measure(page, 'page'));
      if (!crawl) continue;
      const done = new Set<string>();
      const before = await signature(page);
      const candidates = await tappables(page);
      for (const [i, label, inHeader] of candidates) {
        const k = label || `#${i}`;
        // Once per screen and label, across the story's stages.
        const once = `${role}|${where}|${view}|${k}`;
        if (done.has(k) || (inHeader && tappedHeader.has(k)) || crawled.has(once)) continue;
        done.add(k);
        crawled.add(once);
        if (inHeader) tappedHeader.add(k);
        if (done.size > 30) break;
        // The candidate list is from the screen as it was first drawn.
        if ((await signature(page)) !== before) {
          if (!(await goView(page, auth, nav))) break;
        }
        if (!(await tapNth(page, i).catch(() => false))) continue;
        await page.waitForTimeout(300);
        if (await dialogOpen(page)) {
          // The sheet's slide-in.
          await page.waitForTimeout(300);
          record(stage, role, `${view} › ${label}`, where, await measure(page, 'dialog'));
          await page.keyboard.press('Escape');
          await page.waitForTimeout(250);
          if (await dialogOpen(page)) await goView(page, auth, nav);
        } else if ((await signature(page)) !== before) {
          await settle(page);
          record(stage, role, `${view} › after ${label}`, where, await measure(page, 'page'));
          if (await dialogOpen(page)) await goView(page, auth, nav);
        }
      }
    }
  } finally {
    await context.close();
    await mutate(login.accessToken, 'auth.setLocale', { locale: 'en' });
  }
}

async function audit(stage: string, roles: AuditRole[]) {
  for (const lang of LANGS) {
    for (const width of WIDTHS) {
      for (const role of roles) {
        const started = Date.now();
        await auditRole(stage, role, lang, width);
        console.log(
          `tap audit: ${stage} ${role} ${lang}@${width} in ${Math.round((Date.now() - started) / 1000)}s, ${findings.size} under ${MIN} so far`,
        );
      }
    }
  }
  // The story's phones read English again.
  for (const { page } of phones.values()) await page.reload();
}

function writeReport() {
  mkdirSync(OUT, { recursive: true });
  const rows = [...findings.values()].sort(
    (a, b) =>
      Number(a.inline) - Number(b.inline) ||
      a.view.localeCompare(b.view) ||
      a.label.localeCompare(b.label),
  );
  writeFileSync(
    join(OUT, 'report.json'),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), langs: LANGS, widths: WIDTHS, crawl: CRAWL, measured, under44: rows }, null, 2)}\n`,
  );
  const md = [
    `# Tap targets under ${MIN}×${MIN}`,
    '',
    `${new Date().toISOString()} · languages ${LANGS.join(', ')} · widths ${WIDTHS.join(', ')} · sheets opened at ${CRAWL.join(', ')}`,
    '',
    `${measured} controls measured; ${rows.length} distinct controls under ${MIN} (${rows.filter((r) => r.inline).length} of them inline text links).`,
    '',
    '| role | stage | view | label | element | smallest tap | where |',
    '|---|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.role} | ${r.stage} | ${r.view} | ${r.label.replace(/\|/g, '/')}${r.inline ? ' (inline)' : ''} | ${r.tag}${r.role ? `[${r.role}]` : ''}${r.testId ? ` #${r.testId}` : ''} \`${r.classes.slice(0, 60)}\` | ${r.minTap.w}×${r.minTap.h} | ${Object.keys(r.sizes).join(' ')} |`,
    ),
    '',
  ].join('\n');
  writeFileSync(join(OUT, 'report.md'), md);
  console.log(`tap audit: ${measured} measured, ${rows.length} under ${MIN} → ${OUT}`);
}

// ─────────────────────────────── the story ───────────────────────────────

test('a draft order', async () => {
  const page = await phone('staff');
  await tab(page, 'order').click();
  await addToOrder(page, 'BEEF', 2);
  await addToOrder(page, 'TOMATO', 4);
  await addToOrder(page, 'MILK', 2);
  await audit('draft', ['staff']);
});

test('the order submitted', async () => {
  const page = await phone('staff');
  await expect(mainButton(page)).toHaveText(t('order.action.submitCount', { n: 3 }));
  await mainButton(page).click();
  await expect(main(page).getByRole('status')).toContainText(t('order.status.submitted'));
  await audit('submitted', ['owner', 'manager', 'staff', 'purchaser', 'cashier']);
});

test('the run being bought', async () => {
  const manager = await phone('manager');
  await tab(manager, 'approve').click();
  await reach(
    manager,
    main(manager).getByRole('button', { name: t('approval.approve'), exact: true }),
  );
  await main(manager)
    .getByRole('button', { name: t('approval.approve'), exact: true })
    .click();
  await expect(
    main(manager).getByRole('button', { name: t('approval.approve'), exact: true }),
  ).toHaveCount(0);
  const page = await phone('purchaser');
  await tab(page, 'run').click();
  await reach(page, mainButton(page).getByText(t('run.action.startPurchase')));
  await mainButton(page).click();
  const save = main(page).getByRole('button', {
    name: t('run.action.savePurchaseAriaLabel', { name: skuName('BEEF', 'en') }),
  });
  await save.click();
  await expect(save).toHaveCount(0);
  await audit('buying', ['purchaser', 'owner', 'manager']);
});

test('the run being delivered', async () => {
  const page = await phone('purchaser');
  // As the tutorial does: tomatoes at a new price, milk unavailable.
  await row(page, 'TOMATO').getByRole('button').first().click();
  await row(page, 'TOMATO').getByPlaceholder(t('run.action.unitPriceAriaLabel')).fill('13');
  const saveTomato = row(page, 'TOMATO').getByRole('button', {
    name: t('run.action.savePurchaseAriaLabel', { name: skuName('TOMATO', 'en') }),
  });
  await saveTomato.click();
  await expect(saveTomato).toHaveCount(0);
  await page.waitForLoadState('networkidle').catch(() => {});
  await row(page, 'MILK').getByRole('button').first().click();
  await row(page, 'MILK')
    .getByRole('button', { name: t('run.action.markNa'), exact: true })
    .click();
  const preset = sheet(page)
    .getByRole('radio', { name: t('run.unavailable.preset.soldOut'), exact: true })
    .or(sheet(page).getByRole('button', { name: t('run.unavailable.preset.soldOut'), exact: true }))
    .first();
  await preset.click();
  const confirmNa = sheet(page).getByRole('button', { name: t('run.action.markNa'), exact: true });
  await expect(confirmNa).toBeEnabled();
  await confirmNa.click();
  await expect(sheet(page)).toBeHidden();
  await expect(mainButton(page)).toHaveText(t('run.action.startDelivery'));
  await mainButton(page).click();
  const deliver = main(page).getByRole('button', {
    name: t('run.delivery.deliverTo', { store: STORES.en.central }),
  });
  await deliver.click();
  await expect(deliver).toHaveCount(0);
  await audit('delivering', ['staff', 'purchaser']);
});
