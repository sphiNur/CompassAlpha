import type { Page } from '@playwright/test';

/**
 * Opens a bottom-nav tab. A tab that is not in the bar for this role is
 * opened from the More page (owner 2026-11-17), which also holds Admin.
 */
/**
 * Owner 2026-11-23 (apps/web/src/app/shell/tabGroups.ts): Receiving and
 * History share a bar item with Order and Buying when the role sees both;
 * the page then switches between them (data-testid="group-<tab>").
 */
const GROUP_LEAD: Record<string, string> = { confirm: 'order', history: 'run' };

export async function openTab(page: Page, key: string): Promise<void> {
  const nav = page.getByTestId('primary-nav');
  await nav.waitFor();
  const inBar = nav.getByTestId(`nav-${key}`);
  if ((await inBar.count()) > 0) {
    await inBar.click();
    return;
  }
  const lead = GROUP_LEAD[key];
  if (lead && (await nav.getByTestId(`nav-${lead}`).count()) > 0) {
    await nav.getByTestId(`nav-${lead}`).click();
    await page.getByTestId(`group-${key}`).click();
    return;
  }
  // Owner 2026-11-17: More is a page; Admin is drawn on it, the other
  // tabs the bar has no room for are rows at its top.
  await nav.getByTestId('nav-more').click();
  if (key === 'admin' || key === 'more') return;
  await page.getByTestId('more-nav-list').getByTestId(`nav-${key}`).click();
}
