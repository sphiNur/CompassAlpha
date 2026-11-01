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
import { expectTappable } from './tap-area';

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
// The innermost matching list item: an approval card is itself an item of
// the order list (A11Y-14), with the product rows nested inside it.
const item = (sku: string): Locator =>
  main().getByRole('listitem').filter({ hasText: sku }).last();
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
  await page.getByRole('button', { name: 'Save name' }).click();
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

  // A typed quantity, one key at a time (R2-ORD-1 / R2-ORD-2): "1,000"
  // used to pass through "1," and land as 1; "0.0004" offered "Set 0".
  await item('Apple').getByRole('button', { name: /^Quantity/ }).click();
  const custom = sheet().getByRole('textbox');
  await custom.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('1,000');
  await expect(custom).toHaveValue('1,000');
  await expect(sheet().getByRole('button', { name: 'Set 1000 kg' })).toBeEnabled();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('0.0004');
  await expect(sheet().getByRole('alert')).toHaveText('At most 3 decimals');
  await expect(sheet().getByRole('button', { name: /^Set/ })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(item('Apple').getByRole('button', { name: /^Quantity/ })).toHaveAccessibleName(
    'Quantity 2 kg — tap to choose',
  );

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
  await tab('approve').click();
  await expect(main().getByRole('heading', { name: 'E2E Admin' })).toBeVisible();
  await main().getByRole('button', { name: "I'll review" }).click();
  await expect(item('Apple').getByRole('button', { name: /^Quantity/ })).toHaveAccessibleName(
    /^Quantity 2 kg/,
  );
  await evidence('approval-claimed');
  await main().getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(main().getByRole('heading', { name: 'No orders waiting for review' })).toBeVisible();
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
      .getByRole('button', { name: new RegExp(`^Enter price ${sku}`) })
      .click();
    await item(sku).getByRole('textbox', { name: 'unit price' }).fill(price);
    // The row writes the price out in full: "12" is twelve thousand.
    await expect(item(sku).getByTestId('price-in-full')).toContainText(`${price},000 UZS`);
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

  // The purchaser's most-tapped controls take a tap across 44×44, not
  // just look that big: nothing clips or covers them (R2-VIS-2, V4).
  await main()
    .getByRole('button', { name: /^Enter price Beef/ })
    .click();
  await expectTappable({
    'bought row: payment method': item('Apple').getByRole('button', {
      name: 'Payment method: Cash',
    }),
    'open row: payment method': item('Beef').getByRole('button', {
      name: 'Payment method: Cash',
    }),
    'open row: save': item('Beef').getByRole('button', { name: 'Save purchase: Beef' }),
    '+ Add product': main().getByRole('button', { name: '+ Add product', exact: true }),
    '+ Add expense': main().getByRole('button', { name: '+ Add expense', exact: true }),
    'nav: Buying': tab('run'),
  });
  await item('Beef').getByRole('textbox', { name: 'unit price' }).fill('90');
  await item('Beef').getByRole('button', { name: 'Payment method: Cash' }).click();
  await item('Beef').getByRole('button', { name: 'Save purchase: Beef' }).click();
  await expect(item('Beef').getByRole('button', { name: /^Bought Beef/ })).toBeVisible();
  await expect(item('Beef').getByRole('button', { name: 'Payment method: Transfer' })).toBeVisible();

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
  // The rows that open the price editor and the store rows (R2-DLV-4).
  await expectTappable({
    // DX-DLV-17: every price is in, so the price card is one line.
    'prices complete': main().getByRole('button', { name: /^All prices are in/ }),
    'store row': main().getByRole('button', { name: /Central Kitchen.*Not delivered/ }),
    // DX-DLV-10: the row opens the pick list; delivering is its own button.
    'deliver button': main().getByRole('button', { name: 'Mark delivered to Central Kitchen' }),
  });

  await main().getByRole('button', { name: 'Mark delivered to Central Kitchen' }).click();
  await sheet().getByRole('button', { name: 'Mark delivered' }).click();
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
  await sheet()
    .getByRole('button', { name: /Mark 2 items correct/ })
    .click();
  await expect(main()).toContainText(/Checked\s*2\/2/);
  await expect(item('Apple').getByRole('radio', { name: 'OK' })).toBeChecked();
  await evidence('receiving-checked');
  await expect(mainButton()).toHaveText('Confirm receipt');
  await mainButton().click();
  // U4: the irreversible confirmation goes through a summary sheet.
  await expect(sheet()).toContainText('OK: 2 · short: 0 · wrong or damaged: 0');
  await sheet().getByRole('button', { name: 'Confirm receipt' }).click();
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
  await expect(main().getByRole('heading', { name: 'No approved orders yet' })).toBeVisible();

  await tab('history').click();
  await expect(main().getByRole('heading', { level: 1 })).toHaveText(/History\s*1 trip · 114,000 UZS/);
  await expect(
    main().getByRole('button', { name: /Central Kitchen 2 items 114,000/ }),
  ).toBeVisible();
  await evidence('history');

  // Every bought line says how it was paid.
  await main()
    .getByRole('button', { name: /Central Kitchen 2 items 114,000/ })
    .click();
  const paid = page.getByTestId('history-line-payment');
  await expect(paid).toHaveCount(2);
  await expect(
    page.getByRole('listitem').filter({ hasText: 'Beef' }).getByTestId('history-line-payment'),
  ).toHaveText('Transfer');
  await expect(
    page.getByRole('listitem').filter({ hasText: 'Apple' }).getByTestId('history-line-payment'),
  ).toHaveText('Cash');
  await evidence('history-detail');
  await page.keyboard.press('Escape');
});

test('close the day', async () => {
  await tab('settlement').click();
  await evidence('daily-close-empty');
  await page.getByRole('textbox', { name: 'Invoiced cash revenue' }).fill('500000');
  await page.getByRole('textbox', { name: 'Online / transfer revenue' }).fill('250000');
  await expect(main()).toContainText(/Total recorded revenue\s*750,000 UZS/);
  await expect(mainButton()).toHaveText('Save daily close');
  await mainButton().click();

  await expect(
    main().getByRole('button', { name: /Version 1 · Updated by E2E Admin/ }),
  ).toBeVisible();
  await expect(main().getByRole('status').first()).toContainText('Editing an existing daily close');
  await evidence('daily-close-saved');
});

test('the next order shows what it should cost, and how it is usually paid', async () => {
  // Apple was bought in cash and Beef by transfer, so an order for both
  // can now be budgeted by payment method before anyone approves it.
  // Prices are remembered for a minute, and a minute ago nothing had
  // been bought. Opening the app again is what a later order amounts to.
  await page.reload();
  await tab('order').click();
  const add = async (sku: string, taps: number) => {
    const saved = page.waitForResponse((res) => res.url().includes('order.adjustItem'));
    for (let i = 0; i < taps; i++) {
      await item(sku).getByRole('button', { name: 'Increase' }).click();
    }
    await saved;
  };
  await add('Apple', 2);
  await add('Beef', 2);
  await mainButton().click();
  await sheet().getByRole('button', { name: 'Submit order' }).click();
  await expect(main().getByRole('status')).toContainText('Submitted · awaiting review');

  await tab('approve').click();
  await expect(main().getByTestId('approval-payment-budget')).toHaveText(
    /Cash ~12,000\s*Transfer ~90,000/,
  );
  await main().getByRole('button', { name: 'View items' }).click();
  await expect(item('Apple').getByTestId('approval-line-price')).toHaveText(
    /~12,000 \/ kg · Cash\s*~12,000/,
  );
  await expect(item('Beef').getByTestId('approval-line-price')).toHaveText(
    /~90,000 \/ kg · Transfer\s*~90,000/,
  );
  await evidence('approval-budget');
});

test('a price typed in the wrong unit is asked about before it is saved', async () => {
  // The order from the last test is approved and bought. Apple cost
  // 12,000 last time; typing the full "12000" while the unit is
  // thousands would record twelve million.
  await main().getByRole('button', { name: "I'll review" }).click();
  await main().getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(main().getByRole('heading', { name: 'No orders waiting for review' })).toBeVisible();
  await tab('run').click();
  await mainButton().click();
  await expect(main()).toContainText('0 bought · 0 n/a · 2 left');

  // The row carries last time's price; opening it is how a new one is typed.
  await item('Apple').getByRole('button').first().click();
  const price = item('Apple').getByRole('textbox', { name: 'unit price' });
  await price.fill('12000');
  await expect(item('Apple').getByTestId('price-in-full')).toContainText('12,000,000 UZS');
  await item('Apple').getByRole('button', { name: 'Save purchase: Apple' }).click();
  await expect(sheet()).toContainText('Is this price right?');
  await expect(sheet()).toContainText('last time 12,000 UZS, this time 12,000,000 UZS');
  await evidence('price-check');
  await sheet().getByRole('button', { name: 'Change the price' }).click();
  await expect(main()).toContainText('0 bought · 0 n/a · 2 left');

  // The unit can be switched where the price is typed, and the figure
  // keeps meaning the same money.
  await item('Apple').getByTestId('price-unit-switch').click();
  await expect(price).toHaveValue('12000000');
  await item('Apple').getByTestId('price-unit-switch').click();
  await expect(price).toHaveValue('12000');

  await price.fill('13');
  await item('Apple').getByRole('button', { name: 'Save purchase: Apple' }).click();
  await expect(item('Apple').getByRole('button', { name: /^Bought Apple/ })).toBeVisible();
  await expect(main()).toContainText('1 bought · 0 n/a · 1 left');
});

test('nothing went wrong along the way', () => {
  expect(problems).toEqual([]);
});
