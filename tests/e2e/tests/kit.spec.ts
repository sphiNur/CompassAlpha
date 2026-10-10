import { expect, test } from '@playwright/test';

/**
 * DESIGN.md, measured. The component kit is rendered in a real browser
 * at the width of the phone most of the fleet is no wider than, and the
 * rules that keep a screen from getting dense again are read back off
 * the page: text size, row height, touch targets, aligned figures.
 */
test.use({ viewport: { width: 390, height: 844 } });

const px = (v: string) => Number.parseFloat(v);

test.describe('component kit follows DESIGN.md', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?kit');
    await expect(page.getByRole('heading', { name: 'Component kit' })).toBeVisible();
  });

  test('nothing is set smaller than the caption size, and rows read at body size', async ({
    page,
  }) => {
    const sizes = await page.evaluate(() => {
      const out = new Map<string, number>();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.textContent?.trim() || !node.parentElement) continue;
        const size = getComputedStyle(node.parentElement).fontSize;
        out.set(size, (out.get(size) ?? 0) + 1);
      }
      return [...out.keys()];
    });
    // The eight type tokens resolve to five sizes. Anything else is ad hoc.
    expect(sizes.map(px).sort((a, b) => a - b)).toEqual([13, 15, 16, 18, 24]);

    const title = page.getByTestId('kit-row').first().locator('span.text-body').first();
    expect(px(await title.evaluate((el) => getComputedStyle(el).fontSize))).toBe(16);
  });

  test('rows are at least 56px tall and a long name wraps instead of shrinking', async ({
    page,
  }) => {
    const rows = page.getByTestId('kit-row');
    const heights = await rows.evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().height),
    );
    expect(heights.length).toBeGreaterThan(3);
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(56);

    const long = rows.filter({ hasText: 'Картофель' });
    const title = await long.evaluate((el) => {
      const t = el.querySelector('span.text-body') as HTMLElement;
      return { clipped: t.scrollWidth > t.clientWidth, height: t.getBoundingClientRect().height };
    });
    expect(title.clipped).toBe(false);
    // Two lines of 24px: the name wrapped.
    expect(title.height).toBeGreaterThanOrEqual(48);
  });

  test('everything tappable is at least 44px in both directions', async ({ page }) => {
    const small = await page.evaluate(() =>
      [...document.querySelectorAll('button')]
        .map((b) => ({ text: b.textContent?.trim().slice(0, 30), r: b.getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && (r.width < 44 || r.height < 44))
        .map(({ text, r }) => `${text} ${Math.round(r.width)}x${Math.round(r.height)}`),
    );
    expect(small).toEqual([]);
  });

  test('amounts are tabular and share a right edge', async ({ page }) => {
    const amounts = page.getByTestId('kit-row').locator('[data-money]');
    const facts = await amounts.evaluateAll((els) =>
      els.map((el) => ({
        right: Math.round(el.getBoundingClientRect().right),
        numeric: getComputedStyle(el.firstElementChild as Element).fontVariantNumeric,
      })),
    );
    expect(facts.length).toBe(4);
    expect(new Set(facts.map((f) => f.right)).size).toBe(1);
    for (const f of facts) expect(f.numeric).toContain('tabular-nums');
  });

  test('the payment method sits at the same place in every row', async ({ page }) => {
    const chips = page.getByTestId('kit-row').locator('[data-payment-method]');
    const rights = await chips.evaluateAll((els) =>
      els.map((el) => Math.round(el.getBoundingClientRect().right)),
    );
    expect(rights.length).toBe(4);
    expect(new Set(rights).size).toBe(1);
    await expect(chips.first()).toHaveText('Cash');
  });

  test('one primary action, pinned to the bottom, 52px tall', async ({ page }) => {
    const primary = page.getByTestId('kit-primary');
    const before = await primary.boundingBox();
    expect(before?.height).toBe(52);
    await page.getByText('Something failed').scrollIntoViewIfNeeded();
    const after = await primary.boundingBox();
    expect(after?.y).toBe(before?.y);
    // Above the navigation, inside the viewport.
    expect((after?.y ?? 0) + 52).toBeLessThan(844);
  });

  test('the page never scrolls sideways', async ({ page }) => {
    const overflow = await page.evaluate(() =>
      [...document.querySelectorAll('*')]
        .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 0.5)
        .map((el) => el.tagName + '.' + el.className)
        .slice(0, 5),
    );
    expect(overflow).toEqual([]);
  });

  test('the stepper changes the quantity and stops at zero', async ({ page }) => {
    const stepper = page.getByTestId('kit-stepper');
    const value = stepper.locator('[data-step="value"]');
    await expect(value).toHaveText(/2\s*kg/);
    await stepper.locator('[data-step="up"]').click();
    await expect(value).toHaveText(/2\.5\s*kg/);
    for (let i = 0; i < 5; i++) await stepper.locator('[data-step="down"]').click();
    await expect(value).toHaveText(/0\s*kg/);
    await expect(stepper.locator('[data-step="down"]')).toBeDisabled();
  });

  test('a sheet opens over the page and closes without acting', async ({ page }) => {
    await page.getByTestId('kit-primary').click();
    const dialog = page.getByRole('dialog', { name: 'Finish buying?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Keep buying' }).click();
    await expect(dialog).toBeHidden();
  });
});
