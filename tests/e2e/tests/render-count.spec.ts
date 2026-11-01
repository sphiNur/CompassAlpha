/**
 * How much React redraws (DX-PFE-5 / DX-PFE-11, 2026-11-01).
 *
 * The purchase screen drew ~1,300 components on its first paint, half of
 * them Radix dialog parts of sheets nobody had opened, and the order list
 * redrew every row on each realtime push. Nothing caught that, because no
 * test counted renders. This one counts them the way React DevTools does:
 * a stand-in `__REACT_DEVTOOLS_GLOBAL_HOOK__` sees every commit and the
 * components that did work in it.
 *
 * Runs after main-flow.spec.ts (files run in name order), which leaves a
 * run in buying with one item bought and one to buy.
 */
import { createHmac } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { ADMIN_TG_ID, API_URL, BOT_TOKEN } from '../env';

test.describe.configure({ mode: 'serial' });

interface Counts {
  commits: number;
  rendered: number;
  byComp: Record<string, number>;
}

function signInitData(tgUserId: string): string {
  const fields: Record<string, string> = {
    auth_date: Math.floor(Date.now() / 1000).toString(),
    user: JSON.stringify({ id: Number(tgUserId), first_name: 'E2E' }),
  };
  const dataCheckString = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const params = new URLSearchParams(fields);
  params.set('hash', createHmac('sha256', secret).update(dataCheckString).digest('hex'));
  return params.toString();
}

/** Radix parts a closed sheet used to render on every parent render. */
const DIALOG_PARTS = ['Dialog', 'DialogProvider', 'DialogPortal', 'DialogPortalProvider', 'Presence'];
const dialogRenders = (c: Counts) => DIALOG_PARTS.reduce((sum, n) => sum + (c.byComp[n] ?? 0), 0);
/** The dev build may suffix a memo'd component's name (`SkuRow2`). */
const rendersOf = (c: Counts, name: string) =>
  Object.entries(c.byComp)
    .filter(([n]) => new RegExp(`^${name}\\d*$`).test(n))
    .reduce((sum, [, v]) => sum + v, 0);

let page: Page;
let accessToken: string;
let storeId: string;

test.beforeAll(async ({ browser, request }) => {
  const login = await request.post(`${API_URL}/trpc/auth.telegramLogin`, {
    data: { initData: signInitData(ADMIN_TG_ID) },
  });
  expect(login.ok()).toBe(true);
  const { tokens, session } = (await login.json()).result.data;
  accessToken = tokens.accessToken;
  storeId = session.stores[0].id;

  const context = await browser.newContext();
  await context.addInitScript(
    ([auth]) => {
      if (!window.localStorage.getItem('compass.auth')) {
        window.localStorage.setItem('compass.auth', auth!);
        window.localStorage.setItem(
          'compass.nav.v1',
          JSON.stringify({ state: { tab: 'run' }, version: 0 }),
        );
      }
      const counts = { commits: 0, rendered: 0, byComp: {} as Record<string, number> };
      (window as unknown as { __renders: typeof counts }).__renders = counts;
      type Fiber = {
        tag: number;
        flags: number;
        type?: { displayName?: string; name?: string; render?: { name?: string } } | null;
        child: Fiber | null;
        sibling: Fiber | null;
      };
      // Function, class, forwardRef and simple-memo fibers that did work
      // (PerformedWork = 1) in this commit.
      const walk = (root: Fiber | null) => {
        const stack: Array<Fiber | null> = [root];
        while (stack.length) {
          const f = stack.pop();
          if (!f) continue;
          if ([0, 1, 11, 15].includes(f.tag) && f.flags & 1) {
            counts.rendered++;
            const name = f.type?.displayName || f.type?.name || f.type?.render?.name || '?';
            counts.byComp[name] = (counts.byComp[name] ?? 0) + 1;
          }
          stack.push(f.sibling, f.child);
        }
      };
      (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        supportsFiber: true,
        renderers: new Map(),
        inject: () => 1,
        onCommitFiberRoot: (_id: number, root: { current: Fiber }) => {
          counts.commits++;
          walk(root.current.child);
        },
        onCommitFiberUnmount: () => {},
        onPostCommitFiberRoot: () => {},
        onScheduleFiberRoot: () => {},
        checkDCE: () => {},
      };
    },
    [
      JSON.stringify({
        state: { accessToken, refreshToken: tokens.refreshToken, session, currentStoreId: null },
        version: 0,
      }),
    ],
  );
  page = await context.newPage();
});

test.afterAll(async () => {
  await page.context().close();
});

/** The counts since the last call. */
async function take(): Promise<Counts> {
  return page.evaluate(() => {
    const w = window as unknown as { __renders: Counts };
    const out = { ...w.__renders, byComp: { ...w.__renders.byComp } };
    w.__renders.commits = 0;
    w.__renders.rendered = 0;
    w.__renders.byComp = {};
    return out;
  });
}

test('the purchase screen mounts no closed sheet and sits still when idle', async () => {
  await page.goto('/');
  const main = page.getByRole('main');
  await expect(main).toContainText(/\d+ bought/);
  await page.waitForTimeout(1_500);
  const load = await take();
  // Every row and the page own sheets; none is open, so none renders.
  expect(dialogRenders(load), JSON.stringify(load.byComp)).toBe(0);

  await page.waitForTimeout(5_000);
  const idle = await take();
  // Nothing changes on an idle screen: at most a stray commit (a timer).
  expect(idle.commits, JSON.stringify(idle.byComp)).toBeLessThanOrEqual(2);
  expect(idle.rendered, JSON.stringify(idle.byComp)).toBeLessThanOrEqual(150);
});

test('a realtime push redraws the order list once, without the closed sheets', async ({ request }) => {
  await page.getByTestId('nav-order').click();
  // Today's order is already in the run: start the next one.
  await page.getByRole('button', { name: 'Place another order' }).click();
  const beef = page.getByRole('main').getByRole('listitem').filter({ hasText: 'Beef' }).last();
  await expect(beef.getByRole('button', { name: /^Quantity/ })).toBeVisible();
  await page.waitForTimeout(1_500);
  const rows = await page.getByRole('main').getByRole('button', { name: /^Quantity/ }).count();
  await take();

  // The same person, from another device: the server pushes the change.
  const skus = await request.get(`${API_URL}/trpc/catalog.skus?input=${encodeURIComponent('{}')}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const beefId = ((await skus.json()).result.data as Array<{ id: string; names: Record<string, string> }>).find(
    (s) => s.names.en === 'Beef',
  )!.id;
  const adjust = (qty: string) =>
    request.post(`${API_URL}/trpc/order.adjustItem`, {
      headers: { authorization: `Bearer ${accessToken}` },
      data: { storeId, skuId: beefId, qty },
    });
  expect((await adjust('1')).ok()).toBe(true);
  await expect(beef.getByRole('button', { name: /^Quantity/ })).toHaveAccessibleName(/^Quantity 1 kg/);
  await page.waitForTimeout(1_000);
  const push = await take();

  expect(dialogRenders(push), JSON.stringify(push.byComp)).toBe(0);
  // One push: the refetch, its pending-state flips and the shell's badge —
  // five commits today. A push storm (a refetch loop) would be dozens.
  expect(push.commits, JSON.stringify(push.byComp)).toBeLessThanOrEqual(8);
  // At most one pass over the list per commit. DX-PFE-4 (order page, its
  // own change) makes the rows memoize properly; once it is in, only the
  // changed row redraws and this can drop to a handful.
  expect(rendersOf(push, 'SkuRow'), JSON.stringify(push.byComp)).toBeLessThanOrEqual(
    rows * push.commits,
  );

  expect((await adjust('0')).ok()).toBe(true);
});
