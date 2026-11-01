/**
 * The lazily loaded pages, one import function each, shared by the Shell
 * (React.lazy + idle prefetch) and main.tsx (DX-PFE-3: the page the app
 * reopens on starts downloading as soon as the entry runs, instead of
 * after the auth check and the saved-data restore have drawn the Shell).
 *
 * The order page stays in the entry chunk: nearly every signed-in person
 * has the Order tab, and it is the default first tab.
 */
import { NAV_STORAGE_KEY, type Tab } from '../stores/navStore';

export const importAdminPage = () =>
  import('../pages/AdminPage').then((m) => ({ default: m.AdminPage }));
export const importRunPage = () => import('../pages/RunPage').then((m) => ({ default: m.RunPage }));
export const importHistoryPage = () =>
  import('../pages/HistoryPage').then((m) => ({ default: m.HistoryPage }));
export const importSettlementPage = () =>
  import('../pages/SettlementPage').then((m) => ({ default: m.SettlementPage }));
export const importSalesPage = () =>
  import('../pages/SalesPage').then((m) => ({ default: m.SalesPage }));
export const importApprovalPage = () =>
  import('../pages/ApprovalPage').then((m) => ({ default: m.ApprovalPage }));
export const importConfirmPage = () =>
  import('../pages/ConfirmPage').then((m) => ({ default: m.ConfirmPage }));

const PAGE_IMPORTS: Partial<Record<Tab, () => Promise<unknown>>> = {
  approve: importApprovalPage,
  run: importRunPage,
  history: importHistoryPage,
  settlement: importSettlementPage,
  sales: importSalesPage,
  confirm: importConfirmPage,
  admin: importAdminPage,
};

/**
 * Start downloading a tab's page chunk without waiting for it. A failure
 * is left to the page's own import (resilientLazy shows a retry there).
 */
export function preloadPage(tab: Tab): void {
  PAGE_IMPORTS[tab]?.().catch(() => {
    /* offline or a removed chunk: the page's own import handles it */
  });
}

/**
 * The tab the app will reopen on, read from storage before React starts:
 * the persisted bottom tab, when someone is signed in. Null when there is
 * no session or nothing usable is stored. The Shell still checks it
 * against the person's permissions; a guess that turns out unusable only
 * costs one chunk download.
 */
export function savedTab(storage: Pick<Storage, 'getItem'>): Tab | null {
  try {
    const auth = JSON.parse(storage.getItem('compass.auth') ?? 'null') as {
      state?: { session?: unknown };
    } | null;
    if (!auth?.state?.session) return null;
    const nav = JSON.parse(storage.getItem(NAV_STORAGE_KEY) ?? 'null') as {
      state?: { tab?: unknown };
    } | null;
    const tab = nav?.state?.tab;
    return typeof tab === 'string' && tab in PAGE_IMPORTS ? (tab as Tab) : null;
  } catch {
    return null;
  }
}
