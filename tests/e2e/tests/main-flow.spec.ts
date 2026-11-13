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
// Rows of the review card's 原提交订单 list (a read-only copy of the
// submitted order) are not the line being worked on.
const item = (sku: string): Locator =>
  main().locator('li:not([data-testid="approval-original"] li)').filter({ hasText: sku }).last();
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

test('the app keeps clear of the phone bars Telegram reports', async () => {
  // COREWEB1-07. Android's Telegram WebView answers env(safe-area-inset-*)
  // with 0, so the app also reads the insets Telegram's SDK writes to
  // --tg-safe-area-inset-*. Set here the way the SDK sets them.
  const report = (insets: Record<string, string> | null) =>
    page.evaluate((i) => {
      for (const side of ['top', 'right', 'bottom', 'left']) {
        const name = `--tg-safe-area-inset-${side}`;
        if (i) document.documentElement.style.setProperty(name, i[side]!);
        else document.documentElement.style.removeProperty(name);
      }
    }, insets);
  /** The four insets the app pads with: top right bottom left. */
  const safeArea = () =>
    page.evaluate(() => {
      const probe = document.createElement('div');
      probe.style.padding =
        'var(--app-safe-top) var(--app-safe-right) var(--app-safe-bottom) var(--app-safe-left)';
      document.body.append(probe);
      const s = getComputedStyle(probe);
      const out = `${s.paddingTop} ${s.paddingRight} ${s.paddingBottom} ${s.paddingLeft}`;
      probe.remove();
      return out;
    });
  const padding = (el: Locator) =>
    el.evaluate((n) => {
      const s = getComputedStyle(n);
      return `${s.paddingTop} ${s.paddingRight} ${s.paddingBottom} ${s.paddingLeft}`;
    });
  const nav = page.getByTestId('primary-nav');

  // Outside Telegram nothing is reported: env() (0 in this browser) and
  // the floors.
  expect(await safeArea()).toBe('16px 0px 8px 0px');

  // Android in fullscreen: the status bar, the three-button navigation
  // bar and, on its side, a cutout.
  await report({ top: '32px', right: '20px', bottom: '48px', left: '30px' });
  expect(await safeArea()).toBe('32px 20px 48px 30px');
  expect(await padding(nav)).toBe('0px 20px 48px 30px');
  expect(await padding(main())).toBe('0px 20px 0px 30px');
  await report(null);
  expect(await padding(nav)).toBe('0px 0px 8px 0px');
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
  await expect(sheet().getByRole('button', { name: 'Set 1,000 kg' })).toBeEnabled();
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
  // 2026-11-05: the review is editable — each line has the list's stepper.
  const reviewLine = (sku: string) => sheet().getByRole('listitem').filter({ hasText: sku }).last();
  await expect(reviewLine('Apple').getByRole('button', { name: /^Quantity/ })).toHaveAccessibleName(
    'Quantity 2 kg — tap to choose',
  );
  const reviewSaved = page.waitForResponse((res) => res.url().includes('order.adjustItem'));
  await reviewLine('Apple').getByRole('button', { name: 'Increase' }).click();
  await reviewSaved;
  await expect(reviewLine('Apple').getByRole('button', { name: /^Quantity/ })).toHaveAccessibleName(
    'Quantity 2.5 kg — tap to choose',
  );
  const reviewSaved2 = page.waitForResponse((res) => res.url().includes('order.adjustItem'));
  await reviewLine('Apple').getByRole('button', { name: 'Decrease' }).click();
  await reviewSaved2;
  await expect(reviewLine('Apple').getByRole('button', { name: /^Quantity/ })).toHaveAccessibleName(
    'Quantity 2 kg — tap to choose',
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
  // The card also lists the order as submitted (原提交订单, no stepper);
  // the editable line is the one with the quantity control.
  const editable = main()
    .getByRole('listitem')
    .filter({ hasText: 'Apple' })
    .filter({ has: page.getByRole('button', { name: /^Quantity/ }) })
    .last();
  await expect(editable.getByRole('button', { name: /^Quantity/ })).toHaveAccessibleName(
    /^Quantity 2 kg/,
  );
  await expect(main().getByTestId('approval-original')).toContainText(/Apple\s*2 kg/);
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
  // 2026-11-13: no confirm (Back to purchase undoes it).
  await mainButton().click();
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

  // 2026-11-13: no confirm (Recall undoes it).
  await main().getByRole('button', { name: 'Mark delivered to Central Kitchen' }).click();
  await expect(
    main().getByRole('button', { name: /Central Kitchen.*Awaiting confirm/ }),
  ).toBeVisible();
  await evidence('run-delivered');
});

test('receive the delivery at the store', async () => {
  await tab('confirm').click();
  await expect(main()).toContainText(/Checked\s*0\/2/);
  await evidence('receiving-unchecked');
  await main().getByRole('button', { name: 'All OK' }).click();
  await sheet()
    .getByRole('button', { name: /Mark 2 items OK/ })
    .click();
  await expect(main()).toContainText(/Checked\s*2\/2/);
  await expect(item('Apple').getByRole('radio', { name: 'OK' })).toBeChecked();
  await evidence('receiving-checked');
  await expect(mainButton()).toHaveText('Confirm receipt');
  await mainButton().click();
  // U4: the irreversible confirmation goes through a summary sheet.
  // CONF-20: only the verdicts given.
  await expect(sheet().getByTestId('confirm-final-summary')).toHaveText('OK: 2');
  await sheet().getByRole('button', { name: 'Confirm receipt' }).click();
  await expect(mainButton()).toBeHidden();
});

test('finish the run and find it in history', async () => {
  await tab('run').click();
  await expect(main()).toContainText(/Stores\s*1\/1 confirmed/);
  await mainButton().click();
  // The split by payment method is what the purchaser signs off on.
  // RUNWEB1-08: the figures are rows (label, then amount), the total once.
  const figures = sheet().getByTestId('run-confirm-summary');
  await expect(figures).toContainText(/2 items · 1 store\s*114,000 UZS/);
  await expect(figures).toContainText(/Cash\s*24,000/);
  await expect(figures).toContainText(/Transfer\s*90,000/);
  await evidence('run-finish-summary');
  await sheet().getByRole('button', { name: 'Finish run' }).click();
  await expect(main().getByRole('heading', { name: 'No approved orders yet' })).toBeVisible();

  await tab('history').click();
  await expect(main().getByRole('heading', { level: 1 })).toHaveText(/History\s*1 run · 114,000 UZS/);
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

test('a close corrected on another phone reaches the open form', async ({ browser }) => {
  // Review CONF-26: the other phone's save is pushed. With nothing typed
  // here the form follows it; with unsaved input it says the close changed
  // elsewhere, and Refresh keeps what was typed.
  const other = await browser.newPage();
  await other.goto('/');
  await other.getByTestId('nav-settlement').click();
  const otherMain = other.getByRole('main');
  const correctOnOther = async (version: number, invoicedCash: string) => {
    await expect(otherMain.getByRole('button', { name: `Version ${version}` })).toBeVisible();
    await otherMain.getByRole('textbox', { name: 'Invoiced cash revenue' }).fill(invoicedCash);
    await otherMain.getByRole('textbox', { name: /Reason for correction/ }).fill('Recounted');
    await other.getByTestId('page-main-button').click();
  };
  const field = (name: string): Locator => main().getByRole('textbox', { name, exact: true });
  const changedElsewhere = main().getByText('This daily close was changed elsewhere.');

  await correctOnOther(1, '600000');
  await expect(main().getByRole('button', { name: /Version 2 · / })).toBeVisible();
  await expect(field('Invoiced cash revenue')).toHaveValue('600000');

  await field('Online / transfer revenue').fill('260000');
  await correctOnOther(2, '650000');
  await expect(changedElsewhere).toBeVisible();
  await expect(field('Online / transfer revenue')).toHaveValue('260000');
  await evidence('daily-close-changed-elsewhere');
  await main().getByRole('button', { name: 'Refresh record' }).click();
  await expect(page.getByText(/kept the amounts and note you changed/)).toBeVisible();
  await expect(main().getByRole('button', { name: /Version 3 · / })).toBeVisible();
  await expect(field('Invoiced cash revenue')).toHaveValue('650000');
  await expect(field('Online / transfer revenue')).toHaveValue('260000');
  await expect(changedElsewhere).toHaveCount(0);

  // Typed back, the form has nothing unsaved for the steps after this one.
  await field('Online / transfer revenue').fill('250000');
  await expect(main().getByRole('textbox', { name: /Reason for correction/ })).toHaveCount(0);
  await other.close();
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

test('a store that cannot be loaded, or is gone, says so', async ({ browser }) => {
  const row = (name: RegExp): Locator => main().getByRole('button', { name });
  // The app reopens on the store that was open when it closed.
  await tab('admin').click();
  await row(/^Stores/).click();
  await row(/Central Kitchen/).click();
  await main().getByRole('radio', { name: 'Settings' }).click();
  await expect(main().getByRole('textbox', { name: /^Name/ })).toHaveValue('Central Kitchen');
  const nav = await page.evaluate(() => localStorage.getItem('compass.nav.v1'));
  expect(nav).toContain('"storeSub":"settings"');

  // ADM2-22: both spun on "Loading store…" for good. A new browser each
  // time, so nothing comes from the saved copy of the list.
  async function reopen(): Promise<Page> {
    const later = await browser.newPage();
    // Same origin, no app code: a place to seed storage before the app boots.
    await later.goto('/boot.css');
    await later.evaluate((saved) => localStorage.setItem('compass.nav.v1', saved), nav ?? '');
    return later;
  }

  // The store list does not load: the error, and a retry that recovers.
  const offline = await reopen();
  await offline.route(/admin\.storeList/, (route) => route.abort('failed'));
  await offline.goto('/');
  const retry = offline.getByRole('main').getByRole('button', { name: 'Retry' });
  await expect(retry).toBeVisible({ timeout: 20_000 });
  await offline.unroute(/admin\.storeList/);
  await retry.click();
  await expect(offline.getByRole('main').getByRole('textbox', { name: /^Name/ })).toHaveValue(
    'Central Kitchen',
  );
  await offline.close();

  // The store is no longer in the list (archived, or no longer theirs).
  const gone = await reopen();
  await gone.route(/admin\.storeList/, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { result: { data: { name: string }[] } };
    body.result.data = body.result.data.filter((s) => s.name !== 'Central Kitchen');
    await route.fulfill({ response: res, json: body });
  });
  await gone.goto('/');
  const goneMain = gone.getByRole('main');
  await expect(goneMain.getByText('Store not available')).toBeVisible();
  await goneMain.getByRole('button', { name: 'Back to stores' }).click();
  await expect(goneMain.getByRole('button', { name: /Riverside Hotel/ })).toBeVisible();
  await expect(goneMain.getByRole('button', { name: /Central Kitchen/ })).toHaveCount(0);
  await gone.close();
});

test('nothing went wrong along the way', () => {
  expect(problems).toEqual([]);
});
