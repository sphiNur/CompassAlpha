import type { Page } from '@playwright/test';

/**
 * Opens a bottom-nav tab. With more than five tabs the bar holds four and
 * More (owner, 2026-11-14), so a tab that is not in the bar for this role
 * is opened from the More sheet.
 */
export async function openTab(page: Page, key: string): Promise<void> {
  const nav = page.getByTestId('primary-nav');
  await nav.waitFor();
  await showAllTabs(page);
  const inBar = nav.getByTestId(`nav-${key}`);
  if ((await inBar.count()) > 0) {
    await inBar.click();
    return;
  }
  await nav.getByTestId('nav-more').click();
  await page.getByRole('dialog').getByTestId(`nav-${key}`).click();
}

/**
 * 2026-11-14: scrolled down on a page with a main button, the capsule
 * keeps the open tab only (the button takes the room); back at the top of
 * the page every tab shows again.
 */
export async function showAllTabs(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.querySelector('[data-nav-compact]')) {
      document.getElementById('main-content')?.scrollTo({ top: 0 });
    }
  });
}
