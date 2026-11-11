/**
 * The purchase list on a narrow phone (review RUNWEB1-10, 2026-11-11).
 *
 * 320px wide is a small Android, or a bigger one with the display size
 * turned up. There the open row's qty × price, payment and ✓ did not fit
 * on one line: the ✓ crossed the row's edge and the Russian payment label
 * spilled out of its button. A closed row left a Russian name 24px
 * ("Яб/л…"). This measures what the story leaves (a run in buying, Apple
 * bought in cash, Beef to buy) at 320 and 360px, in English and in
 * Russian, whose "Наличные" is the widest payment label.
 *
 * Runs after main-flow.spec.ts: its project depends on main-flow's
 * (playwright.config.ts), so running this file alone runs that first.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { API_URL } from '../env';

test.describe.configure({ mode: 'serial' });

/** The bought product first, then the one still to buy. */
const NAMES = { en: ['Apple', 'Beef'], ru: ['Яблоко', 'Говядина'] } as const;
type Locale = keyof typeof NAMES;

let page: Page;
let accessToken: string;

const main = (): Locator => page.getByRole('main');
const row = (name: string): Locator => main().locator('li').filter({ hasText: name }).last();

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  // A development build signs the admin straight in, as in the story.
  await page.goto('/');
  await page.getByTestId('nav-run').click();
  await expect(main()).toContainText(/\d+ bought/);
  accessToken = await page.evaluate(
    () => JSON.parse(localStorage.getItem('compass.auth')!).state.accessToken as string,
  );
});

test.afterAll(async () => {
  // render-count.spec.ts reads English.
  await setLocale('en');
  await page.close();
});

/** The account's language: on the server, and in the session this page keeps. */
async function setLocale(locale: Locale): Promise<void> {
  const res = await page.request.post(`${API_URL}/trpc/auth.setLocale`, {
    data: { locale },
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(res.ok()).toBe(true);
  await page.evaluate((l) => {
    const auth = JSON.parse(localStorage.getItem('compass.auth')!);
    auth.state.session.user.locale = l;
    localStorage.setItem('compass.auth', JSON.stringify(auth));
  }, locale);
}

/**
 * What sticks out on the list: the page scrolling sideways, a button or
 * field crossing the edge of its row's content, a label wider than its
 * button.
 */
async function strays(): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const sideways = document.documentElement.scrollWidth - window.innerWidth;
    if (sideways > 0) out.push(`the page scrolls sideways by ${sideways}px`);
    for (const li of document.querySelectorAll('main li')) {
      const box = li.getBoundingClientRect();
      const style = getComputedStyle(li);
      const left = box.left + parseFloat(style.paddingLeft);
      const right = box.right - parseFloat(style.paddingRight);
      for (const el of li.querySelectorAll<HTMLElement>('button, input')) {
        const r = el.getBoundingClientRect();
        // Screen-reader-only controls are 1px and clipped.
        if (r.width <= 1 || r.height <= 1) continue;
        const what = el.getAttribute('aria-label') || el.textContent?.trim() || el.tagName;
        if (r.left < left - 0.5 || r.right > right + 0.5) {
          out.push(`"${what}" crosses its row's edge`);
        }
        if (el.tagName === 'BUTTON' && el.scrollWidth > el.clientWidth + 1) {
          out.push(`"${what}" is narrower than its label`);
        }
      }
    }
    return out;
  });
}

/** How many lines a piece of text takes. */
async function lines(text: Locator): Promise<number> {
  return text.evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    return new Set(Array.from(range.getClientRects(), (r) => Math.round(r.top))).size;
  });
}

for (const locale of ['en', 'ru'] as const) {
  test(`${locale}: the purchase list fits a 320px and a 360px screen`, async () => {
    await setLocale(locale);
    const [bought, toBuy] = NAMES[locale];
    for (const width of [320, 360]) {
      await page.setViewportSize({ width, height: 800 });
      await page.reload();
      await expect(row(bought)).toBeVisible();
      await expect(row(toBuy)).toBeVisible();
      expect(await strays(), `closed rows at ${width}px`).toEqual([]);
      if (width === 320) {
        // Below 360 the quantity moves under the name, so a short name
        // reads on one line, the bought one beside its payment label too.
        // From 360 up the quantity keeps its column.
        for (const name of [bought, toBuy]) {
          expect(await lines(row(name).getByText(name, { exact: true })), name).toBe(1);
        }
      }
      // The open row: qty × price, then payment and ✓, which go under the
      // price when the line has no room for them.
      await row(toBuy).getByRole('button').first().click();
      await expect(row(toBuy).getByRole('textbox').first()).toBeVisible();
      expect(await strays(), `the open row at ${width}px`).toEqual([]);
    }
  });
}
