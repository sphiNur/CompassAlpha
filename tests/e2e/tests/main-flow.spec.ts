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
  await mainButton().click();
  await expect(main()).toContainText('0 bought · 0 n/a · 2 left');

  // Prices are entered in thousands of UZS.
  const buy = async (sku: string, price: string, method: 'Cash' | 'Transfer') => {
    await main()
      .getByRole('button', { name: new RegExp(`^Set price ${sku}`) })
      .click();
    await item(sku).getByRole('spinbutton', { name: 'unit price' }).fill(price);
    if (method === 'Transfer') {
      await item(sku).getByRole('button', { name: 'Payment method: Cash' }).click();
    }
    await item(sku)
      .getByRole('button', { name: `Save purchase: ${sku}` })
      .click();
    await expect(
      item(sku).getByRole('button', { name: new RegExp(`^Bought ${sku}`) }),
    ).toBeVisible();
    await expect(
      item(sku).getByRole('button', { name: `Payment method: ${method}` }),
    ).toBeVisible();
  };
  await buy('Apple', '12', 'Cash');
  await evidence('run-buying');
  await buy('Beef', '90', 'Transfer');

  await expect(main()).toContainText('2 bought · 0 n/a · 0 left');
  await expect(item('Apple')).toContainText('24,000 UZS');
  await expect(item('Beef')).toContainText('90,000 UZS');
  await evidence('run-purchased');
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
