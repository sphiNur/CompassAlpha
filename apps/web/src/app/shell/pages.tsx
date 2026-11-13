/**
 * Each tab's page. Every page is lazy: its own chunk, downloaded when the
 * tab is first opened, or before (usePagePrefetch.ts, main.tsx). Order,
 * where nearly every user lands, starts downloading with the entry
 * (pageChunks.ts).
 *
 * Review COREWEB1-10 (2026-11-12): out of Shell.tsx.
 */
import { Suspense, type ReactNode } from 'react';
import { Spinner } from '@compass/ui';
import { resilientLazy } from '../../components/resilientLazy';
import type { Tab } from '../../stores/navStore';
import {
  importAdminPage,
  importApprovalPage,
  importAttendancePage,
  importConfirmPage,
  importHistoryPage,
  importOrderPage,
  importRunPage,
  importSalesPage,
  importSettlementPage,
} from '../pageChunks';

// AdminPage is the heaviest screen in the bundle (~5k LoC + the role
// editor + the audit list etc.). Most users will never open it — the
// `users.manage` permission gate hides the tab. (M1.3, 2026-05-06.)
const AdminPage = resilientLazy(importAdminPage);
// M3.11 (2026-05-16): same treatment for RunPage. ~3.4k LoC + heavy
// purchase / delivery / confirm sheets + history detail. The
// `run.purchase` permission gate hides the tab from staff, cashiers,
// receivers etc. — typical deployment has 1 purchaser per N stores,
// so 90% of users pay for the chunk without ever opening it. Prefetch
// (usePagePrefetch.ts) keeps the tap-to-open latency snappy for actual
// purchasers.
const RunPage = resilientLazy(importRunPage);
// 2026-07-30: history is its own tab now. Lazy for the same reason as
// RunPage — it pulls in the ~800-line history subsystem plus the money
// settlement helpers. Rollup hoists RunHistory.tsx into a chunk shared
// with RunPage, so a purchaser who opens both downloads it once.
const HistoryPage = resilientLazy(importHistoryPage);
// Daily close is a financial, permission-gated surface. Keep its form and
// recent-ledger query code out of the startup bundle for everyone else.
const SettlementPage = resilientLazy(importSettlementPage);
// 2026-10-21: staff-only sales tab. Small page, but lazy like Settlement
// so the many users who never see it don't parse it.
const SalesPage = resilientLazy(importSalesPage);
// DX-PFE-2 (2026-11-01): review and receiving were in the entry chunk
// (~60 KB raw together) although only approvers and receivers open them.
const ApprovalPage = resilientLazy(importApprovalPage);
const ConfirmPage = resilientLazy(importConfirmPage);
// 2026-11-05: clock in / out, only for members switched on for it.
const AttendancePage = resilientLazy(importAttendancePage);

// 2026-11-13: out of the entry chunk for the startup budget (scripts/
// check-entry-budget.ts); main.tsx starts it with the entry.
const OrderPage = resilientLazy(importOrderPage);

// Loading fallback for lazily-imported pages. Centered spinner so the
// blip between bundle download and render doesn't look like a stall.
// 80dvh (at most the screen above the nav) keeps it visually placed where
// the page content would be, not crammed under the header.
function PageLoading() {
  return (
    <div className="flex min-h-[min(80dvh,calc(var(--app-viewport-h)-var(--app-nav-h)))] items-center justify-center">
      <Spinner size={20} />
    </div>
  );
}

export const PAGES: Record<Tab, () => ReactNode> = {
  order: () => (
    <Suspense fallback={<PageLoading />}>
      <OrderPage />
    </Suspense>
  ),
  approve: () => (
    <Suspense fallback={<PageLoading />}>
      <ApprovalPage />
    </Suspense>
  ),
  run: () => (
    <Suspense fallback={<PageLoading />}>
      <RunPage />
    </Suspense>
  ),
  history: () => (
    <Suspense fallback={<PageLoading />}>
      <HistoryPage />
    </Suspense>
  ),
  settlement: () => (
    <Suspense fallback={<PageLoading />}>
      <SettlementPage />
    </Suspense>
  ),
  sales: () => (
    <Suspense fallback={<PageLoading />}>
      <SalesPage />
    </Suspense>
  ),
  confirm: () => (
    <Suspense fallback={<PageLoading />}>
      <ConfirmPage />
    </Suspense>
  ),
  attendance: () => (
    <Suspense fallback={<PageLoading />}>
      <AttendancePage />
    </Suspense>
  ),
  admin: () => (
    <Suspense fallback={<PageLoading />}>
      <AdminPage />
    </Suspense>
  ),
};
