import type { Page } from '@playwright/test';

/**
 * Opens a bottom-nav tab. With more than five tabs the bar holds four and
 * More (owner, 2026-11-14), so a tab that is not in the bar for this role
 * is opened from the More sheet.
 */
export async function openTab(page: Page, key: string): Promise<void> {
  const nav = page.getByTestId('primary-nav');
  await nav.waitFor();
  const inBar = nav.getByTestId(`nav-${key}`);
  if (await inBar.isVisible()) {
    await inBar.click();
    return;
  }
  await nav.getByTestId('nav-more').click();
  await page.getByRole('dialog').getByTestId(`nav-${key}`).click();
}
