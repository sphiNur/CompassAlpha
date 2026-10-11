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

test.describe.configure({ mode: 'serial' });

let page: Page;
const problems: string[] = [];

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`);
  });
});

test.afterAll(async () => {
  await page.close();
});

const tab = (name: string): Locator => page.getByTestId(`nav-${name}`);
const mainButton = (): Locator => page.getByTestId('page-main-button');
const main = (): Locator => page.getByRole('main');
const item = (sku: string): Locator => main().getByRole('listitem').filter({ hasText: sku });
const sheet = (): Locator => page.getByRole('dialog');

let shot = 0;
async function evidence(name: string): Promise<void> {
  const body = await page.screenshot({ fullPage: true });
  await test.info().attach(name, { body, contentType: 'image/png' });
  // E2E_SHOTS_DIR=<dir> also keeps the pictures on disk, numbered in the
  // order they were taken: a record of every screen for a design review.
  const dir = process.env.E2E_SHOTS_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${String(++shot).padStart(2, '0')}-${name}.png`), body);
  }
}

test('sign in and confirm a display name', async () => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to Compass' })).toBeVisible();
  await page.getByRole('textbox').fill('E2E Admin');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('primary-nav')).toBeVisible();
  // Someone with several jobs lands on Today, which counts what is waiting.
  await expect(tab('menu')).toHaveAttribute('aria-current', 'page');
  await expect(main().getByRole('heading', { level: 1 })).toHaveText('Today');
  await expect(page.getByTestId('tile-approve')).toHaveText(/0\s*Waiting for approval/);
  await expect(page.getByTestId('tile-close')).toHaveText(/1\s*Day to close/);
  await evidence('signed-in');
});

test('place an order', async () => {
  await tab('order').click();
  // Weighed goods step by half a kilo per tap.

  const add = async (sku: string, taps: number, expected: string) => {
    // Taps are debounced into one write. Wait for it to land: while it
    // is in flight the page's main button is disabled, and a tap that
    // arrives in that instant does nothing.
    const saved = page.waitForResponse((res) => res.url().includes('order.adjustItem'));
    for (let i = 0; i < taps; i++) {
      await item(sku).getByRole('button', { name: 'Increase' }).click();
    }
    await saved;
    await expect(item(sku).getByRole('button', { name: /^Quantity/ })).toHaveAccessibleName(
      `Quantity ${expected} — tap to choose`,
    );
  };
  await add('Apple', 4, '2 kg');
  await add('Beef', 2, '1 kg');
  await evidence('order-picking');

  await expect(mainButton()).toHaveText('Review order (2)');
  await mainButton().click();
  await expect(sheet().getByRole('listitem').filter({ hasText: 'Apple' }).last()).toHaveText(
    /Apple\s*2 kg/,
  );
  await evidence('order-review');
  await sheet().getByRole('button', { name: 'Submit order' }).click();

  await expect(main().getByRole('status')).toContainText('Submitted · awaiting review');
  await evidence('order-submitted');
});

test('approve it', async () => {
  // The navigation says how many orders are waiting before the tab is opened.
  await expect(tab('approve')).toHaveText(/Approve\s*1/);
  await tab('approve').click();
  await expect(main().getByRole('heading', { name: 'E2E Admin' })).toBeVisible();
  await main().getByRole('button', { name: 'Claim' }).click();
  await expect(item('Apple').getByRole('button', { name: /^Quantity/ })).toHaveAccessibleName(
    /^Quantity 2 kg/,
  );
  await evidence('approval-claimed');
  await main().getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(main().getByRole('heading', { name: 'Inbox is empty' })).toBeVisible();
  await expect(tab('approve')).toHaveText('Approve');
});

test('buy everything, one item in cash and one by transfer', async () => {
  await tab('run').click();
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

test('deliver to the store', async () => {
  await expect(mainButton()).toHaveText('Start delivery');
  await mainButton().click();
  await sheet().getByRole('button', { name: 'Start delivery' }).click();
  await expect(main()).toContainText(/Stores\s*0\/1 confirmed/);
  await evidence('run-delivering');

  await main()
    .getByRole('button', { name: /Central Kitchen.*Not delivered/ })
    .click();
  await sheet().getByRole('button', { name: 'Confirm delivery' }).click();
  await expect(
    main().getByRole('button', { name: /Central Kitchen.*Awaiting confirm/ }),
  ).toBeVisible();
  await evidence('run-delivered');
});

test('receive the delivery at the store', async () => {
  await tab('confirm').click();
  await expect(main()).toContainText(/Checked\s*0\/2/);
  await evidence('receiving-unchecked');
  await main().getByRole('button', { name: 'All arrived fine' }).click();
  await expect(main()).toContainText(/Checked\s*2\/2/);
  await expect(item('Apple').getByRole('radio', { name: 'OK' })).toBeChecked();
  await evidence('receiving-checked');
  await expect(mainButton()).toHaveText('Confirm store');
  await mainButton().click();
  await expect(mainButton()).toBeHidden();
});

test('finish the run and find it in history', async () => {
  await tab('run').click();
  await expect(main()).toContainText(/Stores\s*1\/1 confirmed/);
  await mainButton().click();
  // The split by payment method is what the purchaser signs off on.
  await expect(sheet()).toContainText('total 114,000 UZS');
  await expect(sheet()).toContainText('cash 24,000');
  await expect(sheet()).toContainText('transfer 90,000');
  await evidence('run-finish-summary');
  await sheet().getByRole('button', { name: 'Finish run' }).click();
  await expect(main().getByRole('heading', { name: 'No approved sessions to plan' })).toBeVisible();

  // Records are not a daily task: they sit behind the menu.
  await tab('menu').click();
  // What is waiting is counted at the top; by now, nothing.
  await expect(page.getByTestId('tile-approve')).toHaveText(/0\s*Waiting for approval/);
  await expect(page.getByTestId('tile-buy')).toHaveText(/0\s*Orders to buy/);
  await expect(page.getByTestId('tile-receive')).toHaveText(/0\s*Lines to receive/);
  await evidence('menu');
  await page.getByTestId('menu-history').click();
  await expect(tab('menu')).toHaveAttribute('aria-current', 'page');
  await expect(main().getByRole('heading', { level: 1 })).toHaveText(/History\s*1 · 114,000 UZS/);
  await expect(
    main().getByRole('button', { name: /Central Kitchen 2 items 114,000/ }),
  ).toBeVisible();
  await evidence('history');
});

test('close the day', async () => {
  await tab('settlement').click();
  await evidence('daily-close-empty');
  await page.getByRole('spinbutton', { name: 'Invoiced cash revenue' }).fill('500000');
  await page.getByRole('spinbutton', { name: 'Online / transfer revenue' }).fill('250000');
  await expect(main()).toContainText(/Total recorded revenue\s*750,000 UZS/);
  await expect(mainButton()).toHaveText('Save daily close');
  await mainButton().click();

  await expect(
    main().getByRole('button', { name: /Version 1 · Updated by E2E Admin/ }),
  ).toBeVisible();
  await expect(main().getByRole('status').first()).toContainText('Editing an existing close');
  await evidence('daily-close-saved');
});

test('nothing went wrong along the way', () => {
  expect(problems).toEqual([]);
});
