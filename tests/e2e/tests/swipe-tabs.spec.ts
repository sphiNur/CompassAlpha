/**
 * Swiping between the bottom bar's tabs (owner, 2026-11-14, step 2 of the
 * nav redesign; apps/web/src/app/shell/SwipePager.tsx).
 *
 * A store manager at 390 px: Order and Review sit next to each other in
 * the bar. A sideways drag on the page moves between them; the same drag
 * started on the category chips or the review state switch does not.
 *
 * The drags are touches sent through the DevTools protocol, which go
 * through the browser's own touch handling (touch-action, pointer events)
 * as a finger would. The pager ignores the mouse: on a desktop a mouse
 * drag selects text.
 *
 * Standalone: it adds its own manager to the development seed.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import postgres from 'postgres';
import { API_URL, DATABASE_URL } from '../env';
import { pnpmAtRoot } from '../global-setup';
import { signInitData } from './initData';
import { openTab } from './nav';

const MANAGER_TG_ID = '900000077';
const WIDTH = 390;

test.use({ viewport: { width: WIDTH, height: 844 } });

let page: Page;

const nav = (): Locator => page.getByTestId('primary-nav');
const active = (key: string) =>
  expect(nav().getByTestId(`nav-${key}`)).toHaveAttribute('aria-current', 'page');

test.beforeAll(async ({ browser }) => {
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  let storeId: string;
  try {
    const rows = await sql<{ id: string }[]>`
      select id from inventory.stores where code = 'KITCHEN' limit 1`;
    storeId = rows[0]!.id;
  } finally {
    await sql.end({ timeout: 5 });
  }
  pnpmAtRoot([
    'compass',
    'user',
    'grant',
    MANAGER_TG_ID,
    '--role',
    'manager',
    '--org',
    'default',
    '--scope',
    'store',
    '--scope-id',
    storeId,
    '--new-user',
  ]);

  page = await browser.newPage({ hasTouch: true });
  const login = await page.request.post(`${API_URL}/trpc/auth.telegramLogin`, {
    data: { initData: signInitData(MANAGER_TG_ID) },
  });
  expect(login.ok()).toBe(true);
  const { tokens, session } = (await login.json()).result.data;
  // Same origin, no app code: a place to seed storage before the app boots.
  await page.goto('/boot.css');
  await page.evaluate(
    ([accessToken, refreshToken, sessionJson, store]) => {
      window.localStorage.setItem(
        'compass.auth',
        JSON.stringify({
          state: {
            accessToken,
            refreshToken,
            session: JSON.parse(sessionJson!),
            currentStoreId: store,
          },
          version: 0,
        }),
      );
    },
    [tokens.accessToken as string, tokens.refreshToken as string, JSON.stringify(session), storeId],
  );
  await page.goto('/');
  const welcome = page.getByRole('heading', { name: 'Welcome to Compass' });
  await expect(nav().or(welcome)).toBeVisible();
  if (await welcome.isVisible()) {
    await page.getByRole('textbox').fill('E2E Manager');
    await page.getByRole('button', { name: 'Save name' }).click();
  }
  await nav().waitFor();
  // Past the cold-start landing on Review (landingVerdict.ts), then Order.
  await page.waitForTimeout(2_500);
  await openTab(page, 'order');
  await active('order');
});

test.afterAll(async () => {
  await page.close();
});

/** A finger dragged from `from` to `to` in small moves. */
async function touchDrag(
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 12,
): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: from.x, y: from.y }],
    });
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          {
            x: from.x + ((to.x - from.x) * i) / steps,
            y: from.y + ((to.y - from.y) * i) / steps,
          },
        ],
      });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await cdp.detach();
  }
}

/**
 * A height on the open page where a touch at `x` lands on plain content:
 * inside <main>, not on a control marked data-no-swipe, a field or
 * something that scrolls sideways.
 */
async function plainY(x: number): Promise<number> {
  const y = await page.evaluate((px) => {
    const main = document.querySelector('main')!;
    const box = main.getBoundingClientRect();
    const plain = (cx: number, cy: number): boolean => {
      const el = document.elementFromPoint(cx, cy);
      if (!el || !main.contains(el)) return false;
      // Chrome's touch adjustment snaps a touch to a nearby control, so
      // nothing pressable may sit near the start point either.
      if (
        el.closest(
          '[data-no-swipe], input, textarea, select, button, a, label, [role="search"], [contenteditable="true"]',
        )
      )
        return false;
      for (let a: Element | null = el; a && a !== main; a = a.parentElement) {
        const ox = getComputedStyle(a).overflowX;
        if ((ox === 'auto' || ox === 'scroll') && a.scrollWidth > a.clientWidth) return false;
      }
      return true;
    };
    for (let py = Math.round(box.top) + 40; py < box.bottom - 140; py += 12) {
      const around = [
        [0, 0],
        [0, -20],
        [0, 20],
        [-20, 0],
        [20, 0],
      ];
      if (around.every(([dx, dy]) => plain(px + dx!, py + dy!))) return py;
    }
    return null;
  }, x);
  expect(y, 'a plain spot on the page to drag from').not.toBeNull();
  return y!;
}

/** The middle of `el`, to start a drag on it. */
async function middleOf(el: Locator): Promise<{ x: number; y: number }> {
  await el.scrollIntoViewIfNeeded();
  const box = (await el.boundingBox())!;
  return { x: Math.min(box.x + box.width / 2, WIDTH * 0.7), y: box.y + box.height / 2 };
}

test('a sideways drag on the page moves to the next tab and back', async () => {
  const startX = WIDTH * 0.8;
  const endX = WIDTH * 0.15;
  let y = await plainY(startX);
  await touchDrag({ x: startX, y }, { x: endX, y: y + 4 });
  await active('approve');
  await expect(page.locator('[data-swipe-pager] [aria-hidden][inert]')).toHaveCount(0);

  y = await plainY(endX);
  await touchDrag({ x: endX, y }, { x: startX, y: y - 4 });
  await active('order');
});

test('a drag on the category chips or the state switch does not switch tabs', async () => {
  await active('order');
  const chips = page.getByRole('main').getByRole('radiogroup', { name: 'Product categories' });
  const from = await middleOf(chips);
  await touchDrag(from, { x: WIDTH * 0.1, y: from.y });
  await page.waitForTimeout(600);
  await active('order');

  await openTab(page, 'approve');
  await active('approve');
  const states = page.getByRole('main').getByRole('radiogroup', { name: 'Approval status filter' });
  const start = await middleOf(states);
  await touchDrag(start, { x: WIDTH * 0.1, y: start.y });
  await page.waitForTimeout(600);
  await active('approve');
});
