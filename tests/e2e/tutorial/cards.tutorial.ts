/**
 * The tutorial cards, walked in order on one demo workspace: each daily
 * task as the person who does it, one screenshot per step with the
 * control to tap ringed. The walk is a story (an order is submitted,
 * reviewed, bought, delivered and received; the day is closed), so the
 * cards run serially and each starts where the one before left off.
 */
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test';
import { seedDemo, type Demo } from './seed';
import { Card, clearLang, dump, openAs, writePart, type CardRecord } from './shots';
import { tutorialLang } from './lang';
import { translator, type T } from './i18n';
import { LANGUAGE_NATIVE_NAMES } from '@compass/i18n';
import {
  CATEGORIES,
  EXPENSE_TEMPLATES,
  INVITEE,
  INVITEE_TG,
  NEW_PRODUCT,
  PEOPLE,
  STORES,
  skuName,
  type Role,
} from './demo';

test.describe.configure({ mode: 'serial' });

const lang = tutorialLang();
let t: T;
let demo: Demo;
let browser: Browser;
const cards: CardRecord[] = [];
const phones = new Map<Role, { context: BrowserContext; page: Page }>();

test.beforeAll(async ({ browser: b }) => {
  browser = b;
  clearLang(lang);
  t = await translator(lang);
  demo = await seedDemo(lang, browser);
});

test.afterAll(async () => {
  writePart(lang, cards);
  for (const { context } of phones.values()) await context.close();
});

/** The phone of `who`, opened once and kept for the walk. */
async function phone(who: Role): Promise<Page> {
  let p = phones.get(who);
  if (!p) {
    p = await openAs(browser, demo.logins[who]);
    phones.set(who, p);
  }
  return p.page;
}

function card(page: Page, id: string, role: Role, title: string): Card {
  return new Card(lang, page, id, role, title, cards);
}

const main = (page: Page): Locator => page.getByRole('main');
const sheet = (page: Page): Locator => page.getByRole('dialog');
/**
 * Opens a tab: in the bottom bar, or through More when this role has more
 * than five tabs and the tab is not one of the four in the bar (2026-11-14).
 */
async function tapTab(c: Card, page: Page, stepId: string, name: string): Promise<void> {
  const nav = page.getByTestId('primary-nav');
  await nav.waitFor();
  const inBar = nav.getByTestId(`nav-${name}`);
  if (await inBar.isVisible()) return c.tap(stepId, inBar);
  await c.tap('open-more', page.getByTestId('nav-more'));
  await c.tap(stepId, sheet(page).getByTestId(`nav-${name}`));
}
const mainButton = (page: Page): Locator => page.getByTestId('page-main-button');
/** The innermost list item naming the product. */
const row = (page: Page, code: string): Locator =>
  main(page)
    .getByRole('listitem')
    .filter({ hasText: skuName(code, lang) })
    .last();
/** A chip or button by its exact text. */
const choice = (scope: Locator, text: string): Locator =>
  scope
    .getByRole('button', { name: text, exact: true })
    .or(scope.getByRole('radio', { name: text, exact: true }))
    .or(scope.getByRole('checkbox', { name: text, exact: true }))
    .first();

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Wait for what another phone did to show here: pushed over realtime,
 * or else on reopening the app.
 */
async function reach(page: Page, sign: Locator): Promise<void> {
  try {
    await expect(sign.first()).toBeVisible({ timeout: 8_000 });
  } catch {
    await page.reload();
    await expect(sign.first()).toBeVisible({ timeout: 15_000 });
  }
}

/** Tap `+` on a product `n` times and wait for the order to save. */
async function addToOrder(page: Page, code: string, n: number): Promise<void> {
  const saved = page.waitForResponse((res) => res.url().includes('order.adjustItem'));
  for (let i = 0; i < n; i++) {
    await row(page, code)
      .getByRole('button', { name: t('qty.increment') })
      .click();
  }
  await saved;
}

// ───────────────────────────── staff: orders ─────────────────────────────

test("staff: submit today's order", async () => {
  const page = await phone('staff');
  const c = card(page, 'staff-submit-order', 'staff', "Submit today's order");
  await tapTab(c, page, 'open-order', 'order');
  const plus = (code: string) => row(page, code).getByRole('button', { name: t('qty.increment') });
  await c.shot('add-beef', plus('BEEF'), { taps: 2, note: 'each + adds one step (0.5 kg)' });
  await addToOrder(page, 'BEEF', 2);
  await c.shot('add-tomato', plus('TOMATO'), { taps: 4 });
  await addToOrder(page, 'TOMATO', 4);
  await c.shot('add-milk', plus('MILK'), { taps: 2 });
  await addToOrder(page, 'MILK', 2);
  await expect(mainButton(page)).toHaveText(t('order.action.submitCount', { n: 3 }));
  await c.tap('submit', mainButton(page));
  await expect(main(page).getByRole('status')).toContainText(t('order.status.submitted'));
  await c.shot('submitted', null);
});

test('staff: withdraw an order', async () => {
  const page = await phone('staff');
  const c = card(page, 'staff-withdraw-order', 'staff', 'Withdraw an order');
  const withdraw = main(page).getByRole('button', { name: t('order.withdraw'), exact: true });
  await c.tap('withdraw', withdraw);
  await expect(mainButton(page)).toHaveText(t('order.action.submitCount', { n: 3 }));
  // The "submitted" toast from a moment ago would say the opposite.
  await c.shot('back-to-draft', null, { toasts: false });
  // Sent again for the manager's cards.
  await mainButton(page).click();
  await expect(main(page).getByRole('status')).toContainText(t('order.status.submitted'));
  await dump(page, 'staff-resubmitted');
});

// ──────────────────────────── manager: review ────────────────────────────

test('manager: reject an order with a preset reason', async () => {
  const page = await phone('manager');
  const c = card(page, 'manager-reject-order', 'manager', 'Reject an order');
  await tapTab(c, page, 'open-review', 'approve');
  await c.tap(
    'reject',
    main(page).getByRole('button', { name: t('approval.reject'), exact: true }),
  );
  await c.tap('pick-reason', choice(sheet(page), t('approval.rejectPreset.wrongQty')));
  await c.tap(
    'confirm-reject',
    sheet(page).getByRole('button', { name: t('approval.reject'), exact: true }),
  );
  await expect(sheet(page)).toBeHidden();
  await c.shot('rejected', null);
  await dump(page, 'manager-after-reject');
});

test('staff: fix a rejected order and send it again', async () => {
  const page = await phone('staff');
  const c = card(page, 'staff-fix-rejected', 'staff', 'Fix a rejected order');
  await reach(page, main(page).getByText(t('order.status.rejectedTitle')));
  await c.shot('see-reason', row(page, 'BEEF').getByRole('button', { name: t('qty.increment') }), {
    note: 'the reason is on the red banner; change the quantities',
  });
  await addToOrder(page, 'BEEF', 1);
  await c.tap('submit-again', mainButton(page));
  await expect(main(page).getByRole('status')).toContainText(t('order.status.submitted'));
  await c.shot('submitted', null);
});

test('manager: approve an order', async () => {
  const page = await phone('manager');
  const c = card(page, 'manager-approve-order', 'manager', 'Approve an order');
  await tapTab(c, page, 'open-review', 'approve');
  await c.tap('view-items', main(page).getByRole('button', { name: t('approval.viewItems') }), {
    note: 'optional: check the lines first',
  });
  await c.tap(
    'approve',
    main(page).getByRole('button', { name: t('approval.approve'), exact: true }),
  );
  await expect(
    main(page).getByRole('button', { name: t('approval.approve'), exact: true }),
  ).toHaveCount(0);
  await c.shot('approved', null);
});

// ─────────────────────────────── purchaser ───────────────────────────────

test('purchaser: start purchase', async () => {
  const page = await phone('purchaser');
  const c = card(page, 'purchaser-start-purchase', 'purchaser', 'Start purchase');
  await tapTab(c, page, 'open-run', 'run');
  await expect(mainButton(page)).toHaveText(t('run.action.startPurchase'));
  await c.tap('start-purchase', mainButton(page));
  await expect(
    main(page).getByRole('button', {
      name: t('run.action.savePurchaseAriaLabel', { name: skuName('BEEF', lang) }),
    }),
  ).toBeVisible();
  await c.shot('buying', null);
});

const save = (page: Page, code: string): Locator =>
  main(page).getByRole('button', {
    name: t('run.action.savePurchaseAriaLabel', { name: skuName(code, lang) }),
  });

test('purchaser: record a purchase with one tap', async () => {
  const page = await phone('purchaser');
  const c = card(page, 'purchaser-record-one-tap', 'purchaser', 'Record a purchase (one tap)');
  await c.tap('tick', save(page, 'BEEF'), {
    note: "the ✓ records last time's price and the payment method used last",
  });
  await expect(save(page, 'BEEF')).toHaveCount(0);
  await c.shot('bought', null);
  await dump(page, 'purchaser-after-tick');
});

test('purchaser: record a purchase with a new price', async () => {
  const page = await phone('purchaser');
  const c = card(page, 'purchaser-record-price', 'purchaser', 'Record a purchase with its price');
  await c.tap('open-row', row(page, 'TOMATO').getByRole('button').first());
  await dump(page, 'purchaser-row-open');
  const price = row(page, 'TOMATO').getByPlaceholder(t('run.action.unitPriceAriaLabel'));
  await c.shot('type-price', price, { note: 'prices are typed in thousands: 13 is 13,000' });
  await price.fill('13');
  await c.tap(
    'save',
    row(page, 'TOMATO').getByRole('button', {
      name: t('run.action.savePurchaseAriaLabel', { name: skuName('TOMATO', lang) }),
    }),
  );
  await c.shot('bought', null);
  await dump(page, 'purchaser-after-price');
});

test('purchaser: mark an item unavailable', async () => {
  const page = await phone('purchaser');
  const c = card(page, 'purchaser-mark-unavailable', 'purchaser', 'Mark an item unavailable');
  await c.tap('open-row', row(page, 'MILK').getByRole('button').first());
  await c.tap(
    'na',
    row(page, 'MILK').getByRole('button', { name: t('run.action.markNa'), exact: true }),
  );
  // A preset reason marks the item at once (#470); there is no second tap.
  await c.tap('pick-reason', choice(sheet(page), t('run.unavailable.preset.soldOut')));
  await expect(sheet(page)).toBeHidden();
  await expect(row(page, 'MILK')).toContainText(t('run.unavailable.preset.soldOut'));
  await expect(row(page, 'MILK').getByRole('textbox')).toHaveCount(0);
  await c.shot('marked', null);
});

test('purchaser: start delivery', async () => {
  const page = await phone('purchaser');
  const c = card(page, 'purchaser-start-delivery', 'purchaser', 'Start delivery');
  await expect(mainButton(page)).toHaveText(t('run.action.startDelivery'));
  await c.tap('start-delivery', mainButton(page));
  const deliver = main(page).getByRole('button', {
    name: t('run.delivery.deliverTo', { store: STORES[lang].central }),
  });
  await expect(deliver).toBeVisible();
  await c.shot('delivering', null);
});

test('purchaser: mark a store delivered', async () => {
  const page = await phone('purchaser');
  const c = card(page, 'purchaser-mark-delivered', 'purchaser', 'Mark a store delivered');
  const deliver = main(page).getByRole('button', {
    name: t('run.delivery.deliverTo', { store: STORES[lang].central }),
  });
  await c.tap('delivered', deliver, { label: await deliver.innerText() });
  await expect(deliver).toHaveCount(0);
  await c.shot('awaiting-confirm', null);
});

// ───────────────────────────── staff: receive ─────────────────────────────

const verdict = (page: Page, code: string, key: 'confirm.status.ok' | 'confirm.status.short') =>
  row(page, code).getByRole('radio', { name: t(key), exact: true });

test('staff: report a short line', async () => {
  const page = await phone('staff');
  const c = card(page, 'staff-report-short', 'staff', 'Report a short line');
  await tapTab(c, page, 'open-receive', 'confirm');
  await reach(page, verdict(page, 'TOMATO', 'confirm.status.short'));
  await c.tap('short', verdict(page, 'TOMATO', 'confirm.status.short'));
  await dump(page, 'staff-short-sheet');
  const qty = sheet(page).getByRole('textbox').first();
  await c.shot('received-qty', qty);
  await qty.fill('1.5');
  await c.tap(
    'save',
    sheet(page).getByRole('button', { name: t('confirm.issue.save'), exact: true }),
  );
  await expect(sheet(page)).toBeHidden();
  await c.shot('reported', null);
});

test('staff: confirm a receipt (All OK)', async () => {
  const page = await phone('staff');
  const c = card(page, 'staff-confirm-receipt', 'staff', 'Confirm a receipt');
  // UX-01: exact, the main button reads "All OK · Confirm receipt" until then.
  await c.tap(
    'all-ok',
    main(page).getByRole('button', { name: t('confirm.markAllOk'), exact: true }),
  );
  await expect(verdict(page, 'BEEF', 'confirm.status.ok')).toBeChecked();
  await c.tap('confirm-receipt', mainButton(page));
  await c.tap(
    'confirm-final',
    sheet(page).getByRole('button', { name: t('confirm.final.submit') }),
  );
  await expect(mainButton(page)).toBeHidden();
  await c.shot('confirmed', null);
});

// ───────────────────────────── purchaser: finish ─────────────────────────────

test('purchaser: finish the run', async () => {
  const page = await phone('purchaser');
  const c = card(page, 'purchaser-finish-run', 'purchaser', 'Finish the run');
  await reach(page, mainButton(page).getByText(t('run.action.finish')));
  await c.tap('finish', mainButton(page));
  await c.tap('confirm-finish', sheet(page).getByRole('button', { name: t('run.action.finish') }));
  await expect(sheet(page)).toBeHidden();
  await c.shot('finished', null);
  await dump(page, 'purchaser-finished');
});

// ───────────────────────────── cashier ─────────────────────────────

test('cashier: daily close', async () => {
  const page = await phone('cashier');
  const c = card(page, 'cashier-daily-close', 'cashier', 'Daily close');
  // A cashier has only this page: no bottom bar.
  c.note("the cashier's app opens on the Daily close; a manager finds it under Close");
  const online = main(page).getByRole('textbox', {
    name: t('settlement.field.onlineRevenue'),
    exact: true,
  });
  await c.shot('online-revenue', online, {
    note: "today's sales are open already; type the day's totals",
  });
  await online.fill('1250000');
  const cash = main(page).getByRole('textbox', {
    name: t('settlement.field.invoicedCashRevenue'),
    exact: true,
  });
  await c.shot('cash-revenue', cash);
  await cash.fill('830000');
  await c.tap(
    'expense-template',
    main(page).getByRole('button', { name: EXPENSE_TEMPLATES[lang][0], exact: true }),
    {
      note: 'a template adds an expense line',
    },
  );
  // Without prices.view the template's amount is not sent (164fe743), so
  // a cashier types it.
  const amount = main(page).getByRole('textbox', {
    name: new RegExp(
      `^${escapeRegExp(t('settlement.expenses.itemNumber', { n: 1 }))}.*${escapeRegExp(t('settlement.expenses.amount'))}$`,
    ),
  });
  if (Number((await amount.inputValue()) || '0') === 0) {
    await c.shot('expense-amount', amount, {
      note: 'without the right to see prices the template fills only the reason; type the amount',
    });
    await amount.fill('30000');
  }
  await c.tap(
    'add-wage',
    main(page).getByRole('button', { name: t('settlement.wages.add'), exact: true }),
  );
  await c.tap(
    'pick-employee',
    sheet(page).getByRole('radio', { name: new RegExp(`^${PEOPLE[lang].staff}`) }),
    {
      note: 'the amount fills in with their daily wage',
    },
  );
  await expect(sheet(page)).toBeHidden();
  await dump(page, 'cashier-after-wage');
  await c.tap('save', mainButton(page));
  await reach(page, main(page).getByText(t('settlement.editing.title')));
  await c.shot('saved', null);
});

// ───────────────────────────── manager: admin ─────────────────────────────

const adminRow = (page: Page, text: string): Locator =>
  main(page).getByRole('button', { name: new RegExp(`^${escapeRegExp(text)}`) });

test('manager: count stock', async () => {
  const page = await phone('manager');
  const c = card(page, 'manager-count-stock', 'manager', 'Count stock');
  await tapTab(c, page, 'open-admin', 'admin');
  await c.tap('count-stock', adminRow(page, t('inventory.count.title')));
  const field = (code: string) =>
    sheet(page).getByRole('textbox', {
      name: t('inventory.count.fieldAria', { name: skuName(code, lang) }),
    });
  await c.shot('type-beef', field('BEEF'), {
    note: 'type what is on the shelf; Enter moves to the next row',
  });
  await field('BEEF').fill('1.2');
  await c.shot('type-tomato', field('TOMATO'), { note: 'rows left empty are not counted' });
  await field('TOMATO').fill('1.5');
  // UX-06: the Save button says how many counts differ; no dialog follows.
  await c.tap(
    'save',
    sheet(page).getByRole('button', {
      name: new RegExp(`^${escapeRegExp(t('inventory.count.save', { n: 2 }))}`),
    }),
  );
  await expect(sheet(page)).toBeHidden();
  await c.shot('saved', null);
});

test('manager: invite a member', async () => {
  const page = await phone('manager');
  const c = card(page, 'manager-invite', 'manager', 'Invite a member');
  await tapTab(c, page, 'open-admin', 'admin');
  await c.tap('invite', adminRow(page, t('admin.section.invite')));
  await dump(page, 'manager-invite-hub');
  await c.tap(
    'by-tg-id',
    sheet(page).getByRole('button', {
      name: new RegExp(`^${escapeRegExp(t('people.inviteByTgId'))}`),
    }),
  );
  const id = sheet(page).getByRole('textbox', { name: t('admin.field.tgUserId') });
  await c.shot('tg-id', id, {
    note: 'the person sees their Telegram ID when they open the Mini App',
  });
  await id.fill(INVITEE_TG.manager);
  const name = sheet(page).getByRole('textbox', { name: t('admin.field.displayName') });
  await c.shot('name', name);
  await name.fill(INVITEE[lang].manager);
  const role = sheet(page).getByRole('combobox', { name: t('admin.field.role') });
  await c.shot('role', role, { note: 'starts at Store staff; pick another role here' });
  await role.selectOption('cashier').catch(() => role.selectOption({ index: 1 }));
  await c.tap('add', sheet(page).getByRole('button', { name: t('admin.invite.byTgId.submit') }));
  await expect(sheet(page)).toBeHidden();
  await c.shot('added', null);
});

test('manager: approve a face enrollment', async () => {
  const page = await phone('manager');
  const c = card(page, 'manager-approve-face', 'manager', 'Approve a face enrollment');
  await tapTab(c, page, 'open-admin', 'admin');
  await c.tap('attendance', adminRow(page, t('admin.section.attendance')));
  await c.tap(
    'check',
    main(page).getByRole('button', { name: t('attendance.admin.enrollBannerAction'), exact: true }),
  );
  await c.tap(
    'approve',
    main(page).getByRole('button', { name: t('attendance.review.enrollApprove'), exact: true }),
  );
  await expect(
    main(page).getByRole('button', { name: t('attendance.review.enrollApprove'), exact: true }),
  ).toHaveCount(0);
  await c.shot('approved', null);
});

// ───────────────────────────── clocker ─────────────────────────────

test('staff who clocks in: the clock-in screen', async () => {
  const page = await phone('clocker');
  const c = card(page, 'clocker-clock-in', 'clocker', 'Clock in');
  // The face was approved on the manager's phone a moment ago.
  await page.reload();
  await main(page).waitFor();
  await tapTab(c, page, 'open-clock', 'attendance');
  const clockIn = main(page).getByRole('button', { name: t('attendance.clock.in'), exact: true });
  await reach(page, clockIn);
  await c.tap('clock-in', clockIn);
  await page.waitForTimeout(1500);
  await dump(page, 'clocker-camera');
  await c.shot('camera', null, {
    note: "from here the phone's camera takes the face photos; no camera in this walk, so the tutorial stops at this screen",
  });
  c.note(
    'the steps after the camera opens (looking at the camera, turning the head) cannot be shot without a real camera and face',
  );
});

// ───────────────────────────── owner setup ─────────────────────────────

const plusButton = (page: Page, text: string): Locator =>
  main(page).getByRole('button', { name: new RegExp(escapeRegExp(text)) });

test('owner: create a store', async () => {
  const page = await phone('owner');
  const c = card(page, 'owner-create-store', 'owner', 'Create a store');
  await tapTab(c, page, 'open-admin', 'admin');
  await c.tap('stores', adminRow(page, t('admin.section.stores')));
  await c.tap('new-store', plusButton(page, t('admin.store.new')));
  const name = sheet(page).getByRole('textbox').first();
  await c.shot('name', name);
  await name.fill(STORES[lang].added);
  await c.tap('create', sheet(page).getByRole('button', { name: t('common.create'), exact: true }));
  await expect(sheet(page)).toBeHidden();
  await dump(page, 'owner-store-created');
  await c.shot('created', null);
});

test('owner: add a product', async () => {
  const page = await phone('owner');
  const c = card(page, 'owner-add-product', 'owner', 'Add a product');
  await tapTab(c, page, 'open-admin', 'admin');
  await c.tap('catalog', adminRow(page, t('admin.section.catalog')));
  await c.tap('products', adminRow(page, t('admin.subsection.skus')));
  await c.tap('new-product', plusButton(page, t('catalog.sku.new')));
  const name = sheet(page).getByRole('textbox', {
    name: t('admin.field.nameInLocale', { locale: LANGUAGE_NATIVE_NAMES[lang] }),
  });
  await c.shot('name', name, {
    note: 'a name in one language is enough; add the others for colleagues who read them',
  });
  await name.fill(NEW_PRODUCT[lang]);
  const [category, unit, step] = [0, 1, 2].map((n) => sheet(page).getByRole('combobox').nth(n));
  await c.shot('category', category!);
  await category!.selectOption({
    label: CATEGORIES.find((x) => x.slug === 'vegetables')!.names[lang],
  });
  await c.shot('unit', unit!);
  await unit!.selectOption('kg');
  await c.shot('step', step!, { note: '0.5 for goods sold by weight' });
  await step!.selectOption('0.5');
  await c.tap('create', sheet(page).getByRole('button', { name: t('common.create'), exact: true }));
  await expect(sheet(page)).toBeHidden();
  await c.shot('created', null);
});

test('owner: invite with a role', async () => {
  const page = await phone('owner');
  const c = card(page, 'owner-invite', 'owner', 'Invite someone with a role');
  await tapTab(c, page, 'open-admin', 'admin');
  await c.tap('stores', adminRow(page, t('admin.section.stores')));
  await c.tap('store', adminRow(page, STORES[lang].central));
  await dump(page, 'owner-store-team');
  await c.tap('invite', plusButton(page, t('admin.section.invite')));
  await c.tap(
    'by-tg-id',
    sheet(page).getByRole('button', {
      name: new RegExp(`^${escapeRegExp(t('people.inviteByTgId'))}`),
    }),
  );
  const id = sheet(page).getByRole('textbox', { name: t('admin.field.tgUserId') });
  await c.shot('tg-id', id);
  await id.fill(INVITEE_TG.owner);
  const name = sheet(page).getByRole('textbox', { name: t('admin.field.displayName') });
  await c.shot('name', name);
  await name.fill(INVITEE[lang].owner);
  const role = sheet(page).getByRole('combobox', { name: t('admin.field.role') });
  await c.shot('role', role, { note: 'the role decides what they see' });
  await role.selectOption('manager');
  const clocks = sheet(page).getByRole('switch', { name: t('admin.invite.clocksIn') });
  const clocksRow = sheet(page)
    .locator('label')
    .filter({ has: page.getByRole('switch', { name: t('admin.invite.clocksIn') }) });
  await c.tap('clocks-in', clocksRow, {
    label: t('admin.invite.clocksIn'),
    note: 'only for a store where someone clocks in already',
  });
  await expect(clocks).toBeChecked();
  await c.tap('add', sheet(page).getByRole('button', { name: t('admin.invite.byTgId.submit') }));
  await expect(sheet(page)).toBeHidden();
  await c.shot('added', null);
});

test('owner: switch on clocking', async () => {
  const page = await phone('owner');
  const c = card(page, 'owner-switch-clocking', 'owner', 'Switch on clocking for someone');
  await tapTab(c, page, 'open-admin', 'admin');
  await c.tap('attendance', adminRow(page, t('admin.section.attendance')));
  await c.tap(
    'settings',
    main(page).getByRole('radio', { name: t('attendance.view.settings'), exact: true }),
  );
  const sw = main(page).getByRole('switch', { name: PEOPLE[lang].staff });
  // The switch's input is visually hidden; its label row is what is tapped.
  const swRow = main(page)
    .locator('label')
    .filter({ has: page.getByRole('switch', { name: PEOPLE[lang].staff }) });
  await c.tap('switch', swRow, {
    label: PEOPLE[lang].staff,
    note: 'their next punch registers their phone; they enroll their face first',
  });
  await expect(sw).toBeChecked();
  await c.shot('on', null);
});
