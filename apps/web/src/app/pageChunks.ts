/**
 * The lazily loaded pages, one import function each, shared by the Shell
 * (React.lazy in shell/pages.tsx, idle prefetch in shell/usePagePrefetch.ts)
 * and main.tsx (DX-PFE-3: the page the app reopens on starts downloading
 * as soon as the entry runs, instead of after the auth check and the
 * saved-data restore have drawn the Shell).
 *
 * The order page is lazy too (2026-11-13, startup budget): it was ~16 KB
 * gzip of the entry chunk. Nearly every signed-in person has the Order tab
 * and it is the default first tab, so main.tsx starts its chunk with the
 * entry, side by side with the language catalog, whenever the app does
 * not reopen on another tab: no extra round trip before the first screen.
 */
import { AUTH_STORAGE_KEY } from '../stores/authStore';
import { isTab, NAV_STORAGE_KEY, type Tab } from '../stores/navStore';

export const importAdminPage = () =>
  import('../pages/AdminPage').then((m) => ({ default: m.AdminPage }));
export const importOrderPage = () =>
  import('../pages/OrderPage').then((m) => ({ default: m.OrderPage }));
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

// Review COREWEB1-11 (2026-11-11): keyed by every tab, so a new tab
// cannot be left out of the preload.
const PAGE_IMPORTS: Record<Tab, () => Promise<unknown>> = {
  order: importOrderPage,
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
 * Start downloading a tab's page chunk. The promise settles once it is in
 * (or failed) and never rejects: a failure is left to the page's own
 * import (resilientLazy shows a retry there). `isTab` rather than `in`,
 * which also took a stored "toString" or "constructor"
 * (Object.prototype's) and called it as a page import at start.
 */
export function preloadPage(tab: Tab): Promise<void> {
  if (!isTab(tab)) return Promise.resolve();
  return PAGE_IMPORTS[tab]().then(
    () => undefined,
    () => {
      /* offline or a removed chunk: the page's own import handles it */
    },
  );
}

/**
 * The settings sheet (Telegram's gear, or the header in a browser) is not
 * a page, but loads like one: on its first open, and warmed when the
 * browser is idle (shell/usePagePrefetch.ts), as everyone has it. It left
 * the entry chunk when the startup budget ran out (scripts/
 * check-entry-budget.ts, 2026-11-12).
 */
export const importSettingsSheet = () =>
  import('../components/SettingsSheet').then((m) => ({ default: m.SettingsSheet }));

/** Start downloading the settings sheet; its own import handles a failure. */
export function preloadSettingsSheet(): void {
  importSettingsSheet().catch(() => {
    /* offline or a removed chunk: the sheet's own import handles it */
  });
}

/**
 * The tab the app will reopen on, read from storage before React starts:
 * the persisted bottom tab, when someone is signed in. Null when there is
 * no session or nothing usable is stored (main.tsx then starts Order, the
 * default tab). The Shell still checks it against the person's
 * permissions; a guess that turns out unusable only costs one chunk
 * download.
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
    return isTab(tab) ? tab : null;
  } catch {
    return null;
  }
}
