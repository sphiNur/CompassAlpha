/**
 * The whole procurement day, walked the way a person walks it:
 *
 *   sign in → order → approve → buy → deliver → receive → finish → close
 *
 * One super admin plays every role, which keeps this about the flow
 * itself; who may do what is covered by the API integration tests.
 *
 * Each step saves a screenshot to the report, so a run is also a record
 * of what every screen looked like.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { DATABASE_URL } from '../env';

test.describe.configure({ mode: 'serial' });

let page: Page;
const problems: string[] = [];

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  // Only to say where a picture was tapped next; see evidence().
  if (process.env.E2E_SHOTS_DIR) {
    await page.addInitScript(() => {
      const w = window as unknown as {
        __fineTap?: unknown;
        __fineTapFor?: string | null;
        __fineMoved?: boolean;
      };
      // A tap after the page scrolled is not where the picture shows it.
      document.addEventListener('scroll', () => (w.__fineMoved = true), true);
      document.addEventListener(
        'pointerdown',
        (e) => {
          if (!w.__fineTapFor) return;
          const el = (e.target as Element).closest('button, a, [role="tab"], label, input');
          const r = (el ?? (e.target as Element)).getBoundingClientRect();
          w.__fineTap = {
            shot: w.__fineTapFor,
            moved: !!w.__fineMoved,
            x: r.left / window.innerWidth,
            y: r.top / window.innerHeight,
            w: r.width / window.innerWidth,
            h: r.height / window.innerHeight,
          };
          w.__fineTapFor = null;
        },
        true,
      );
    });
  }
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
  });
});

test.afterAll(async () => {
  await page.close();
});

// The four places to go. Tasks are opened from them and take the whole
// screen; `leave` is the way back out of one.
const tab = (name: 'menu' | 'orders' | 'purchasing' | 'admin'): Locator =>
  page.getByTestId(`nav-${name}`);
const leave = async (): Promise<void> => {
  await page.getByTestId('task-back').click();
  await expect(page.getByTestId('primary-nav')).toBeVisible();
};
const mainButton = (): Locator => page.getByTestId('page-main-button');
const main = (): Locator => page.getByRole('main');
const item = (sku: string): Locator => main().getByRole('listitem').filter({ hasText: sku });
const sheet = (): Locator => page.getByRole('dialog');

let shot = 0;
const LOCALES = (process.env.E2E_SHOTS_LOCALES ?? 'zh,ru').split(',').filter(Boolean);
const taps: Record<string, unknown> = {};

/**
 * A picture of the screen as it is now, attached to the report.
 *
 * E2E_SHOTS_DIR=<dir> also keeps the pictures on disk, numbered in the
 * order they were taken, for the people who review the design: the same
 * screen again in each of E2E_SHOTS_LOCALES under <dir>/<locale>/, and in
 * <dir>/taps.json where on each picture the flow tapped next, which is
 * what turns the pictures into something that can be clicked through.
 *
 * None of that changes what the flow does: the language is switched on
 * the page only, for the length of a picture, with no reload.
 */
async function evidence(name: string): Promise<void> {
  const body = await page.screenshot({ fullPage: true });
  await test.info().attach(name, { body, contentType: 'image/png' });
  const dir = process.env.E2E_SHOTS_DIR;
  if (!dir) return;
  const file = `${String(++shot).padStart(2, '0')}-${name}.png`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), body);
  const showIn = (locale: string) =>
    page.evaluate((l) => {
      (window as unknown as { __fineShowIn?: (locale: string) => void }).__fineShowIn?.(l);
    }, locale);
  for (const locale of LOCALES) {
    await showIn(locale);
    // The catalogue for a language is fetched the first time it is shown.
    await page.waitForTimeout(250);
    mkdirSync(join(dir, locale), { recursive: true });
    writeFileSync(join(dir, locale, file), await page.screenshot({ fullPage: true }));
  }
  await showIn('en');
  await page.waitForTimeout(150);
  // Where the previous picture was tapped, now that it is known; then
  // listen for the tap that follows this one.
  const tapped = await page.evaluate((next) => {
    const w = window as unknown as { __fineTap?: unknown; __fineTapFor?: string | null };
    const last = w.__fineTap ?? null;
    w.__fineTap = null;
    w.__fineTapFor = next;
    (w as { __fineMoved?: boolean }).__fineMoved = false;
    return last;
  }, file);
  if (tapped) taps[(tapped as { shot: string }).shot] = tapped;
  writeFileSync(join(dir, 'taps.json'), JSON.stringify(taps, null, 1));
}

test('sign in and confirm a display name', async () => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to Fine' })).toBeVisible();
  await page.getByRole('textbox').fill('E2E Admin');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('primary-nav')).toBeVisible();
  // Someone with several jobs lands on Today, which counts what is waiting.
  await expect(tab('menu')).toHaveAttribute('aria-current', 'page');
  await expect(main().getByRole('heading', { level: 1 })).toHaveText('Today');
  // The card is about the day: nothing spent, nothing being bought.
  await expect(page.getByTestId('today-spend')).toHaveText(/Spent today\s*0\s*UZS/);
  await expect(page.getByTestId('today-buying')).toHaveText('No purchase today yet');
  // One thing is waiting, the day to close: a number on that job, and the prompt.
  await expect(page.getByTestId('quick-close')).toHaveAttribute('data-count', '1');
  await expect(page.getByTestId('quick-approve')).toHaveAttribute('data-count', '0');
  await expect(page.getByTestId('do-close')).toBeVisible();
  await evidence('signed-in');
});

test('place an order', async () => {
  await tab('orders').click();
  // What can be started is the card at the top; nothing has been ordered yet.
  await expect(main().getByRole('heading', { level: 1 })).toHaveText('Orders');
  await expect(main()).toContainText('No orders today');
  await evidence('orders-empty');
  await page.getByTestId('orders-new').click();
  // A task has the whole screen: the navigation is gone, there is a way back.
  await expect(page.getByTestId('primary-nav')).toBeHidden();
  await expect(main().getByRole('heading', { level: 1 })).toHaveText('Order');

  // Every product has its quantity control, at nothing to begin with and
  // unable to go below it. Weighed goods step by half a kilo per tap.
  await expect(item('Apple').locator('[data-step="value"]')).toHaveText(/0\s*kg/);
  await expect(item('Apple').getByRole('button', { name: 'Decrease' })).toBeDisabled();
  const add = async (sku: string, times: number, expected: string) => {
    // Taps are debounced into one write. Wait for it to land: while it
    // is in flight the page's main button is disabled, and a tap that
    // arrives in that instant does nothing.
    const saved = page.waitForResponse((res) => res.url().includes('order.adjustItem'));
    for (let i = 0; i < times; i++) {
      await item(sku).getByRole('button', { name: 'Increase' }).click();
    }
    await saved;
    await expect(item(sku).locator('[data-step="value"]')).toHaveText(expected);
  };
  await add('Apple', 4, /2\s*kg/ as unknown as string);
  await add('Beef', 2, /1\s*kg/ as unknown as string);
  await evidence('order-picking');

  // The exact amount can be typed instead of tapped.
  const typed = page.waitForResponse((res) => res.url().includes('order.adjustItem'));
  await item('Apple').locator('[data-step="value"]').click();
  await sheet().getByRole('textbox', { name: 'Quantity' }).fill('2');
  await sheet().getByTestId('order-qty-save').click();
  await typed;
  await expect(sheet()).toBeHidden();

  await expect(mainButton()).toHaveText('Review order (2)');
  await mainButton().click();
  const lines = sheet().getByTestId('order-line');
  await expect(lines).toHaveCount(2);
  await expect(lines.filter({ hasText: 'Apple' })).toHaveText(/Apple\s*2 kg/);
  await evidence('order-review');
  await sheet().getByTestId('order-submit').click();

  // Sent: the catalogue gives way to what was sent and where it has got to.
  await expect(main().getByRole('status')).toContainText('Submitted · awaiting review');
  await expect(main().getByTestId('order-line')).toHaveCount(2);
  await expect(main().getByTestId('order-withdraw')).toBeVisible();
  await evidence('order-submitted');
});

test('approve it', async () => {
  // The navigation says how many orders are waiting before the tab is opened.
  await leave();
  await tab('orders').click();
  // The order is listed where orders are, with its state.
  await expect(main().getByTestId('orders-batch')).toContainText('Submitted');
  await expect(main().getByTestId('orders-pending')).toContainText('2 items');
  await evidence('orders-with-work');
  // And Today says it is waiting, with the button that deals with it.
  await tab('menu').click();
  await expect(page.getByTestId('quick-approve')).toHaveText(/Approve\s*1/);
  await evidence('today-with-work');
  await page.getByTestId('do-approve').click();
  // The only order waiting opens by itself, and opening it is claiming it:
  // the quantities become changeable without a button for that.
  await expect(main().getByRole('heading', { name: 'E2E Admin' })).toBeVisible();
  await expect(item('Apple').locator('[data-step="value"]')).toHaveText(/2\s*kg/);
  await expect(mainButton()).toHaveText('Approve');
  await evidence('approval-order');
  await expect(item('Apple').locator('[data-step="value"]')).toHaveText(/2\s*kg/);
  await mainButton().click();
  await evidence('approval-empty');
  await expect(main().getByRole('heading', { name: 'Inbox is empty' })).toBeVisible();
});

test('buy everything, one item in cash and one by transfer', async () => {
  await leave();
  await expect(page.getByTestId('quick-run')).toHaveText(/Buy\s*1/);
  await tab('purchasing').click();
  await evidence('purchasing');
  await page.getByTestId('open-run').click();
  await expect(main().getByRole('heading', { name: 'Ready to plan' })).toBeVisible();
  await evidence('run-preview');
  // A store's row opens to what that store is getting.
  await main().getByTestId('preview-group').filter({ hasText: 'Central Kitchen' }).click();
  await expect(sheet().getByTestId('preview-line')).toHaveCount(2);
  await expect(sheet().getByRole('button', { name: 'Send list' })).toBeVisible();
  await evidence('run-preview-store');
  await page.keyboard.press('Escape');
  await expect(sheet()).toBeHidden();
  await mainButton().click();
  const toBuy = main().getByTestId('buy-row');
  const bought = main().getByTestId('bought-row');
  await expect(toBuy).toHaveCount(2);

  // Prices are typed in thousands of UZS. Nothing has a last price yet,
  // so each line is opened and priced; the payment method is chosen here
  // and nowhere earlier.
  const buy = async (sku: string, price: string, method: 'Cash' | 'Transfer', total: string) => {
    await toBuy.filter({ hasText: sku }).getByRole('button', { name: 'Set price' }).click();
    await expect(sheet().getByRole('heading', { name: sku })).toBeVisible();
    await sheet()
      .getByRole('textbox', { name: /^Price per/ })
      .fill(price);
    await sheet().getByRole('radio', { name: method }).click();
    await expect(sheet()).toContainText(new RegExp(`Total\\s*${total}`));
    if (method === 'Transfer') await evidence('run-price-sheet');
    await sheet().getByTestId('save-purchase').click();
    await expect(sheet()).toBeHidden();
    const row = bought.filter({ hasText: sku });
    await expect(row.locator('[data-money]')).toHaveText(total);
    await expect(row.locator('[data-payment-method]')).toHaveText(method);
  };
  await buy('Apple', '12', 'Cash', '24,000');
  await evidence('run-buying');
  await buy('Beef', '90', 'Transfer', '90,000');

  await expect(toBuy).toHaveCount(0);
  // The amount and, under it, how it was paid: one right edge for both.
  const edges = await bought.evaluateAll((rows) =>
    rows.map((row) => [
      Math.round(row.querySelector('[data-money]')!.getBoundingClientRect().right),
      Math.round(row.querySelector('[data-payment-method]')!.getBoundingClientRect().right),
    ]),
  );
  expect(new Set(edges.flat()).size).toBe(1);
  await expect(main().getByRole('heading', { name: 'Bought' }).locator('..')).toContainText(
    '114,000',
  );
  // The bar over the main button keeps the running split in view.
  const bar = page.getByTestId('action-bar');
  await expect(bar).toContainText('24,000 cash · 90,000 transfer');
  await expect(bar.locator('[data-money]')).toHaveText(/114,000\s*UZS/);
  await evidence('run-purchased');

  // A line recorded as cash by mistake is switched where it is shown.
  const apple = bought.filter({ hasText: 'Apple' });
  const pay = async (method: 'Cash' | 'Transfer') => {
    await apple.click();
    await sheet().getByRole('radio', { name: method }).click();
    await expect(sheet().getByRole('radio', { name: method })).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(sheet()).toBeHidden();
    await expect(apple.locator('[data-payment-method]')).toHaveText(method);
  };
  await pay('Transfer');
  await expect(bar).toContainText('0 cash · 114,000 transfer');
  await evidence('run-bought-sheet-after');
  await pay('Cash');
  await expect(bar).toContainText('24,000 cash · 90,000 transfer');
});

test('spending that is not a product, and correcting a purchase', async () => {
  const bar = page.getByTestId('action-bar');

  // A porter: named, shared between the run's stores, paid in cash.
  await main().getByTestId('add-expense').click();
  await sheet().getByRole('textbox', { name: 'What is it?' }).fill('Porter');
  await sheet().getByRole('textbox', { name: 'Quantity' }).fill('1');
  await sheet()
    .getByRole('textbox', { name: /^Price per/ })
    .fill('10');
  await sheet().getByRole('textbox', { name: 'Why was this added?' }).fill('Carried the beef');
  await expect(sheet()).toContainText(/Total\s*10,000/);
  await evidence('run-add-spending');
  await sheet().getByTestId('save-added').click();
  await expect(sheet()).toBeHidden();
  const porter = main().getByTestId('spending-row').filter({ hasText: 'Porter' });
  await expect(porter.locator('[data-money]')).toHaveText('10,000');
  await expect(porter.locator('[data-payment-method]')).toHaveText('Cash');
  await expect(bar).toContainText('34,000 cash · 90,000 transfer');
  await evidence('run-with-spending');

  // Removing it asks first.
  await porter.click();
  await sheet().getByRole('button', { name: 'Remove' }).click();
  await expect(porter).toHaveCount(0);
  await expect(bar).toContainText('24,000 cash · 90,000 transfer');

  // The full editor: a recorded purchase can only be changed with a reason.
  await main().getByTestId('bought-row').filter({ hasText: 'Apple' }).click();
  await sheet().getByRole('button', { name: 'Change quantity or price' }).click();
  await expect(sheet().getByRole('heading', { name: 'Apple' })).toBeVisible();
  await expect(sheet().getByTestId('save-full-purchase')).toBeDisabled();
  await evidence('run-full-editor');
  await page.keyboard.press('Escape');
  await expect(sheet()).toBeHidden();
});

test('deliver to the store', async () => {
  await expect(mainButton()).toHaveText('Start delivery');
  // Starting delivery asks nothing: it can be taken back from this screen
  // until a store has checked its goods in.
  await mainButton().click();
  await expect(main()).toContainText(/Stores\s*0\/1 confirmed/);
  await expect(main().getByTestId('run-back-to-buying')).toBeVisible();
  await evidence('run-delivering');

  // One tap per store.
  await main().getByRole('button', { name: 'Delivered to Central Kitchen' }).click();
  await expect(
    main().getByRole('button', { name: /Central Kitchen.*Awaiting confirm/ }),
  ).toBeVisible();
  await evidence('run-delivered');
});

test('receive the delivery at the store', async () => {
  // Today says there is something to check in, and how much.
  await leave();
  await tab('menu').click();
  await expect(page.getByTestId('quick-confirm')).toHaveText(/Receive\s*2/);
  // The card has the money that went out, by how it was paid, and where
  // the purchase stands.
  await expect(page.getByTestId('today-spend')).toContainText('Cash');
  await expect(page.getByTestId('today-spend')).toContainText('Transfer');
  await expect(page.getByTestId('today-spend')).not.toHaveText(/Spent today\s*0\s*UZS/);
  await expect(page.getByTestId('today-progress')).toContainText('Delivering');
  await evidence('today-delivering');
  await page.getByTestId('do-receive').click();
  await expect(main().getByRole('heading', { level: 1 })).toHaveText('Receiving');
  const rows = main().getByTestId('receive-row');
  await expect(rows).toHaveCount(2);
  await evidence('receiving-unchecked');

  // Something is wrong with one line: open it, say what, and the main
  // button says so before anything is confirmed.
  await rows.filter({ hasText: 'Beef' }).click();
  await sheet().getByTestId('verdict-short').click();
  await expect(sheet().getByTestId('save-verdict')).toBeDisabled();
  await sheet().getByRole('textbox', { name: 'What is wrong' }).fill('Only 800 g');
  await evidence('receiving-problem-sheet');
  await sheet().getByTestId('save-verdict').click();
  await expect(sheet()).toBeHidden();
  await expect(rows.filter({ hasText: 'Beef' })).toContainText('Short qty');
  await expect(mainButton()).toHaveText('Confirm, 1 with a problem');

  // It was fine after all.
  await rows.filter({ hasText: 'Beef' }).click();
  await sheet().getByTestId('verdict-ok').click();
  await sheet().getByTestId('save-verdict').click();
  await expect(sheet()).toBeHidden();

  // One tap: the line nobody opened is recorded as fine, and the store
  // is confirmed.
  await expect(mainButton()).toHaveText('Everything arrived');
  await mainButton().click();
  await expect(mainButton()).toBeHidden();
  await expect(main()).toContainText('Received');
  await expect(rows.filter({ hasText: 'Apple' })).toContainText('OK');
  await evidence('receiving-checked');
});

test('finish the run and find it in history', async () => {
  await leave();
  await expect(page.getByTestId('today-progress')).toContainText('Delivering');
  await page.getByTestId('do-run').click();
  await expect(main()).toContainText(/Stores\s*1\/1 confirmed/);
  await mainButton().click();
  // The split by payment method is what the purchaser signs off on.
  await expect(sheet()).toContainText('total 114,000 UZS');
  await expect(sheet()).toContainText('cash 24,000');
  await expect(sheet()).toContainText('transfer 90,000');
  await evidence('run-finish-summary');
  await sheet().getByRole('button', { name: 'Finish run' }).click();
  await expect(main().getByRole('heading', { name: 'No approved sessions to plan' })).toBeVisible();

  // What earlier trips bought sits under Purchasing.
  await leave();
  await tab('purchasing').click();
  await expect(main().getByRole('heading', { level: 1 }).first()).toHaveText('Purchasing');
  // A day, and under it a row per store: what it bought and how it was paid.
  const bought = main().getByTestId('history-store');
  await expect(bought).toHaveText(
    /Central Kitchen\s*2 items · Cash 24,000 · Transfer 90,000\s*114,000/,
  );
  await expect(main().getByTestId('history-total')).toHaveText(/114,000\s*UZS/);
  await evidence('history');
  // It was paid both ways, so it is not among the cash-only ones; a second
  // tap takes the filter off. A search for something never bought empties
  // the list too.
  await main().getByTestId('history-payment').filter({ hasText: 'Cash' }).click();
  await expect(main()).toContainText('No purchases match these filters.');
  await main().getByTestId('history-payment').filter({ hasText: 'Mixed' }).click();
  await expect(bought).toBeVisible();
  await main().getByTestId('history-payment').filter({ hasText: 'Mixed' }).click();
  await main().getByRole('searchbox').fill('zzzz');
  await expect(main()).toContainText('No purchases match these filters.');
  await main().getByRole('searchbox').fill('');
  await expect(bought).toBeVisible();
  // The row opens that store's purchase.
  await bought.click();
  await expect(sheet().getByTestId('purchase-total')).toHaveText(
    /Central Kitchen · Total spent\s*114,000\s*UZS\s*Cash 24,000 · Transfer 90,000/,
  );
  const boughtLines = sheet().getByTestId('purchase-line');
  await expect(boughtLines).toHaveCount(2);
  await expect(boughtLines.filter({ hasText: 'Beef' })).toHaveText(/1 kg × 90,000\s*90,000/);
  await expect(boughtLines.filter({ hasText: 'Apple' })).toHaveText(/2 kg × 12,000\s*24,000/);
  await evidence('history-detail');
  // The two corrections are offered to someone who may make them, and
  // ask for what they need before doing anything.
  await sheet().getByTestId('purchase-fix-date').click();
  await expect(sheet().getByTestId('purchase-date-save')).toBeDisabled();
  await evidence('history-detail-date');
  await page.keyboard.press('Escape');
  await expect(sheet()).toBeHidden();
});

test('everything that is set up is one tap from Manage', async () => {
  await tab('admin').click();
  await expect(main().getByRole('heading', { level: 1 })).toHaveText('Manage');
  await evidence('manage');
  // Each row goes straight to its screen, and back from it is back here:
  // no page in between that only lists other pages.
  for (const [row, title, picture] of [
    ['skus', 'SKUs', 'manage-products'],
    ['stores', 'Stores', 'manage-stores'],
    ['permissions', 'Roles & Permissions', 'manage-roles'],
    ['finance', 'Finance', 'manage-finance'],
  ] as const) {
    await page.getByTestId(`manage-${row}`).click();
    await expect(main().getByRole('heading', { level: 1 })).toHaveText(title);
    await expect(page.getByTestId('primary-nav')).toBeVisible();
    await evidence(picture);
    await page.getByTestId('manage-back').click();
    await expect(main().getByRole('heading', { level: 1 })).toHaveText('Manage');
  }
});

test('add a product with one name, then archive it', async () => {
  await page.getByTestId('manage-skus').click();
  // Products sit under their category, as on the ordering screen.
  await expect(main().getByTestId('product-row').filter({ hasText: 'Beef' })).toHaveText(
    /Beef\s*kg · 0\.5 at a time/,
  );
  await evidence('products');

  await page.getByTestId('product-new').click();
  await expect(sheet().getByTestId('product-save')).toBeDisabled();
  // One name is enough; the other three languages are saved with it.
  await sheet().getByRole('textbox', { name: 'Name — English' }).fill('Saffron');
  await sheet().getByTestId('product-unit').filter({ hasText: 'kg' }).click();
  await evidence('product-new');
  const created = page.waitForResponse((res) => res.url().includes('admin.skuCreate'));
  await sheet().getByTestId('product-save').click();
  expect((await created).ok()).toBe(true);
  await expect(sheet()).toBeHidden();
  const saffron = main().getByTestId('product-row').filter({ hasText: 'Saffron' });
  await expect(saffron).toBeVisible();

  // The row opens the product, with all four names filled in.
  await saffron.click();
  await expect(sheet().getByRole('textbox', { name: 'Name — Русский' })).toHaveValue('Saffron');
  await evidence('product-edit');
  // Archiving asks first; then the product is gone from the list, and
  // back when archived ones are asked for.
  page.once('dialog', (dialog) => void dialog.accept());
  await sheet().getByTestId('product-archive').click();
  await expect(sheet()).toBeHidden();
  await expect(saffron).toHaveCount(0);
  await main().getByTestId('product-archived').click();
  await expect(saffron).toContainText('archived');

  await page.getByTestId('manage-back').click();
  await expect(main().getByRole('heading', { level: 1 })).toHaveText('Manage');
});

test('stores and the people in them', async () => {
  await page.getByTestId('manage-stores').click();
  await expect(
    main().getByTestId('store-row').filter({ hasText: 'Central Kitchen' }),
  ).toBeVisible();
  await evidence('stores');

  // A new store needs a name and nothing else.
  await page.getByTestId('store-new').click();
  await expect(sheet().getByTestId('store-save')).toBeDisabled();
  await sheet().getByRole('textbox', { name: 'Name' }).fill('Night Market');
  await evidence('store-new');
  await sheet().getByTestId('store-save').click();
  await expect(sheet()).toBeHidden();
  const market = main().getByTestId('store-row').filter({ hasText: 'Night Market' });
  await expect(market).toContainText('0 members');

  // A store opens on its people; nobody works at the new one yet.
  await market.click();
  await expect(main().getByRole('heading', { level: 1 })).toHaveText('Night Market');
  await expect(page.getByTestId('store-tab-team')).toHaveAttribute('aria-selected', 'true');
  await expect(main().getByTestId('member-row')).toHaveCount(0);
  await evidence('store-people-empty');
  await page.getByTestId('manage-back').click();

  // The people who belong to no store are the first row. One person
  // opens to what they hold and what can be done about them; nothing
  // can be done to oneself beyond roles.
  await page.getByTestId('store-row-org').click();
  const me = main().getByTestId('member-row').filter({ hasText: 'E2E Admin' });
  await expect(me).toContainText('you');
  await evidence('people');
  await me.click();
  await expect(sheet()).toContainText('Every store');
  await expect(sheet().getByTestId('member-grant')).toBeVisible();
  await expect(sheet().getByTestId('member-remove')).toHaveCount(0);
  await evidence('person');
  await page.keyboard.press('Escape');
  await expect(sheet()).toBeHidden();
  await page.getByTestId('manage-back').click();

  // Someone new at a store: by their Telegram number, with a role there.
  await main().getByTestId('store-row').filter({ hasText: 'Central Kitchen' }).click();
  await page.getByTestId('member-invite').click();
  await evidence('invite-ways');
  await sheet().getByTestId('invite-manual').click();
  await expect(sheet().getByTestId('invite-submit')).toBeDisabled();
  await sheet().getByRole('textbox', { name: 'Telegram user ID' }).fill('700100200');
  await sheet().getByRole('textbox', { name: 'Display name' }).fill('Dilnoza');
  await sheet().getByTestId('invite-role').filter({ hasText: 'Store Staff' }).click();
  await sheet().getByTestId('invite-store').filter({ hasText: 'Central Kitchen' }).click();
  await evidence('invite-by-id');
  await sheet().getByTestId('invite-submit').click();
  await expect(sheet()).toBeHidden();
  const dilnoza = main().getByTestId('member-row').filter({ hasText: 'Dilnoza' });
  await expect(dilnoza).toContainText('Store Staff');

  // A second role, at the store being looked at, in two taps.
  await dilnoza.click();
  await sheet().getByTestId('member-grant').click();
  await expect(
    sheet().getByTestId('grant-store').filter({ hasText: 'Central Kitchen' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await evidence('grant-role');
  await sheet().getByTestId('grant-role').filter({ hasText: 'Purchaser' }).click();
  await expect(sheet()).toBeHidden();
  await expect(dilnoza).toContainText('Purchaser');

  // Revoking one asks first, and the person's sheet shows it gone.
  await dilnoza.click();
  await expect(sheet().getByTestId('member-revoke')).toHaveCount(2);
  await evidence('person-with-roles');
  page.once('dialog', (dialog) => void dialog.accept());
  await sheet().getByTestId('member-revoke').first().click();
  await expect(sheet().getByTestId('member-revoke')).toHaveCount(1);
  // And out of the organisation altogether.
  page.once('dialog', (dialog) => void dialog.accept());
  await sheet().getByTestId('member-remove').click();
  await expect(sheet()).toBeHidden();
  await expect(dilnoza).toHaveCount(0);

  await page.getByTestId('manage-back').click();
  await page.getByTestId('manage-back').click();
  await expect(main().getByRole('heading', { level: 1 })).toHaveText('Manage');
});

test('close the day', async () => {
  await tab('admin').click();
  await page.getByTestId('manage-close').click();
  await expect(main().getByRole('heading', { level: 1 })).toHaveText('Daily close');
  await evidence('daily-close-empty');
  await page.getByRole('textbox', { name: 'Invoiced cash revenue' }).fill('500000');
  await page.getByRole('textbox', { name: 'Online / transfer revenue' }).fill('250000');

  // An expense is a line with an amount and what it was for.
  await main().getByTestId('close-add-expense').click();
  await sheet().getByRole('textbox', { name: 'Amount' }).fill('30000');
  await sheet().getByRole('textbox', { name: 'Reason for expense' }).fill('Gas cylinder');
  await evidence('daily-close-expense');
  await sheet().getByTestId('close-expense-done').click();
  await expect(sheet()).toBeHidden();
  const expense = main().getByTestId('close-expense');
  await expect(expense).toContainText('Gas cylinder');
  await expect(expense.locator('[data-money]')).toHaveText('30,000');

  // The bar over the button says what the day comes to.
  const bar = page.getByTestId('action-bar');
  await expect(bar).toContainText('Total recorded revenue');
  await expect(bar.locator('[data-money]')).toHaveText(/750,000\s*UZS/);
  await expect(mainButton()).toHaveText('Save daily close');
  await mainButton().click();

  // Saved: it is now a record with a version, and changing it is a correction.
  await expect(main().getByTestId('close-recent')).toContainText(
    /Version 1 · Updated by E2E Admin/,
  );
  await expect(main().locator('header [data-status]')).toHaveText('Version 1');
  await expect(mainButton()).toHaveText('Save correction');
  await expect(mainButton()).toBeDisabled();
  await evidence('daily-close-saved');

  // Today no longer says the day is waiting to be closed.
  await leave();
  await tab('menu').click();
  await expect(page.getByTestId('quick-close')).toHaveAttribute('data-count', '0');
  await expect(page.getByTestId('today-buying')).toHaveText('1 purchase finished');
  await evidence('today-all-done');
});

test('an organisation that does not use the daily close is not shown it', async () => {
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await sql`
      UPDATE auth.organizations
      SET feature_flags = jsonb_set(feature_flags, '{dailyClose}', 'false'::jsonb)
      WHERE slug = 'default'
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
  await page.reload();
  await expect(page.getByTestId('primary-nav')).toBeVisible();
  // Not under Manage, and not on Today.
  await tab('admin').click();
  await expect(page.getByTestId('manage-settings')).toBeVisible();
  await expect(page.getByTestId('manage-close')).toHaveCount(0);
  await tab('menu').click();
  await expect(page.getByTestId('today-hero')).toBeVisible();
  await expect(page.getByTestId('quick-close')).toHaveCount(0);
  await evidence('today-without-daily-close');
});

test('nothing went wrong along the way', () => {
  expect(problems).toEqual([]);
});
