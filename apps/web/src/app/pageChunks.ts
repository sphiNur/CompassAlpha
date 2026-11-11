/**
 * The lazily loaded pages, one import function each, shared by the Shell
 * (React.lazy + idle prefetch) and main.tsx (DX-PFE-3: the page the app
 * reopens on starts downloading as soon as the entry runs, instead of
 * after the auth check and the saved-data restore have drawn the Shell).
 *
 * The order page stays in the entry chunk: nearly every signed-in person
 * has the Order tab, and it is the default first tab.
 */
import { AUTH_STORAGE_KEY } from '../stores/authStore';
import { isTab, NAV_STORAGE_KEY, type Tab } from '../stores/navStore';

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
export const importAttendancePage = () =>
  import('../pages/AttendancePage').then((m) => ({ default: m.AttendancePage }));
export const importConfirmPage = () =>
  import('../pages/ConfirmPage').then((m) => ({ default: m.ConfirmPage }));

/** Every tab but Order, whose page is in the entry chunk. */
type LazyTab = Exclude<Tab, 'order'>;

// Review COREWEB1-11 (2026-11-11): keyed by every lazy tab, so a new tab
// cannot be left out of the preload.
const PAGE_IMPORTS: Record<LazyTab, () => Promise<unknown>> = {
  approve: importApprovalPage,
  run: importRunPage,
  history: importHistoryPage,
  settlement: importSettlementPage,
  sales: importSalesPage,
  confirm: importConfirmPage,
  attendance: importAttendancePage,
  admin: importAdminPage,
};

/**
 * Whether a value names a lazy tab. `in` alone also took a stored
 * "toString" or "constructor" (Object.prototype's), which main.tsx then
 * called as a page import at start.
 */
function isLazyTab(tab: unknown): tab is LazyTab {
  return isTab(tab) && tab in PAGE_IMPORTS;
}

/**
 * Start downloading a tab's page chunk without waiting for it. A failure
 * is left to the page's own import (resilientLazy shows a retry there).
 */
export function preloadPage(tab: Tab): void {
  if (!isLazyTab(tab)) return;
  PAGE_IMPORTS[tab]().catch(() => {
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
    const auth = JSON.parse(storage.getItem(AUTH_STORAGE_KEY) ?? 'null') as {
      state?: { session?: unknown };
    } | null;
    if (!auth?.state?.session) return null;
    const nav = JSON.parse(storage.getItem(NAV_STORAGE_KEY) ?? 'null') as {
      state?: { tab?: unknown };
    } | null;
    const tab = nav?.state?.tab;
    return isLazyTab(tab) ? tab : null;
  } catch {
    return null;
  }
}
