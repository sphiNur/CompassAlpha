import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Spinner, useSheetCount } from '@compass/ui';
import { ActionBar, BottomNav, Button } from '@compass/ui/kit';
import type { NavItem } from '@compass/ui/kit';
import { OrderPage } from '../pages/OrderPage';
import { ApprovalPage } from '../pages/ApprovalPage';
import { ConfirmPage } from '../pages/ConfirmPage';
import { MenuPage } from '../pages/MenuPage';
// AdminPage is the heaviest screen in the bundle (~5k LoC + the role
// editor + the audit list etc.). Most users will never open it — the
// `users.manage` permission gate hides the tab — yet a static import
// puts it in the initial JS chunk every fresh load downloads. Lazy +
// Suspense splits it out to its own chunk that only admins pay for.
// (M1.3, 2026-05-06.) The other tabs stay eagerly imported because
// every authenticated user reaches at least one of them.
const importAdminPage = () => import('../pages/AdminPage').then((m) => ({ default: m.AdminPage }));
const AdminPage = lazy(importAdminPage);
// M3.11 (2026-05-16): same treatment for RunPage. ~3.4k LoC + heavy
// purchase / delivery / confirm sheets + history detail. The
// `run.purchase` permission gate hides the tab from staff, cashiers,
// receivers etc. — typical deployment has 1 purchaser per N stores,
// so 90% of users pay for the chunk without ever opening it. Pulling
// it behind lazy() saves ~60 kB off the initial bundle. Prefetch
// (below) keeps the tap-to-open latency snappy for actual purchasers.
const importRunPage = () => import('../pages/RunPage').then((m) => ({ default: m.RunPage }));
const RunPage = lazy(importRunPage);
// 2026-07-30: history is its own tab now. Lazy for the same reason as
// RunPage — it pulls in the ~800-line history subsystem plus the money
// settlement helpers. Rollup hoists RunHistory.tsx into a chunk shared
// with RunPage, so a purchaser who opens both downloads it once.
const importHistoryPage = () =>
  import('../pages/HistoryPage').then((m) => ({ default: m.HistoryPage }));
const HistoryPage = lazy(importHistoryPage);
// Daily close is a financial, permission-gated surface. Keep its form and
// recent-ledger query code out of the startup bundle for everyone else.
const importSettlementPage = () =>
  import('../pages/SettlementPage').then((m) => ({ default: m.SettlementPage }));
const SettlementPage = lazy(importSettlementPage);
import { useAuthStore } from '../stores/authStore';
import { requestTabChange, resolveVisibleTab, useNavStore } from '../stores/navStore';
import type { Tab } from '../stores/navStore';
import { useI18n } from '../hooks/useI18n';
import {
  isInTelegram,
  usePageMainButtonState,
  useTelegramBackButton,
  useTelegramSettingsButton,
} from '../hooks/useTelegram';
import { useAppMutating } from '../hooks/useAppMutating';
import { trpc } from '../lib/trpc';
import { SettingsSheet } from '../components/SettingsSheet';
import { useStoreContext } from '../components/StoreSwitcher';
import { PageMenuProvider, usePageMenuRegistration } from './PageMenuContext';
import { StoreBar } from './StoreBar';
import { useTelegramChrome } from './useTelegramChrome';

/**
 * The navigation holds the things a person does every day, in the order
 * a day runs: order, approve, buy, receive, close. Each appears only for
 * someone allowed to do it, so most people see two or three, and the
 * menu is always last.
 */
const TASKS: Array<{ key: Tab; permission: string; labelKey: string }> = [
  { key: 'order', permission: 'order.draft', labelKey: 'nav.order' },
  { key: 'approve', permission: 'order.approve', labelKey: 'nav.approve' },
  { key: 'run', permission: 'run.purchase', labelKey: 'nav.run' },
  { key: 'confirm', permission: 'delivery.confirm', labelKey: 'nav.confirm' },
  { key: 'settlement', permission: 'settlement.record', labelKey: 'nav.settlement' },
];

/** Reached from the menu, not from the navigation. */
const BEHIND_MENU: Array<{ key: Tab; permission: string }> = [
  // `prices.view` is who may see money: purchasers, managers, admins.
  { key: 'history', permission: 'prices.view' },
  { key: 'admin', permission: 'users.manage' },
];

function PageLoading() {
  return (
    <div className="flex h-full items-center justify-center">
      <Spinner size={20} />
    </div>
  );
}

const lazily = (page: ReactNode) => <Suspense fallback={<PageLoading />}>{page}</Suspense>;

export function Shell() {
  return (
    <PageMenuProvider>
      <ShellInner />
    </PageMenuProvider>
  );
}

function ShellInner() {
  const i18n = useI18n();
  const session = useAuthStore((s) => s.session);
  const can = (permission: string) => !!session?.permissions.includes(permission);
  // Actions a page offers about itself; they appear at the top of the
  // settings sheet, which Telegram's gear opens.
  const pageMenu = usePageMenuRegistration();

  const tasks = TASKS.filter((t) => can(t.permission));
  const reachable: Tab[] = [
    ...tasks.map((t) => t.key),
    'menu',
    ...BEHIND_MENU.filter((t) => can(t.permission)).map((t) => t.key),
  ];

  // Warm the AdminPage chunk in the background once we know the user
  // can see the tab. The static `lazy()` above splits it into a
  // separate JS chunk so non-admins never download it; this `import()`
  // call kicks off the fetch idly so when the admin actually taps the
  // tab, React.lazy resolves synchronously instead of flashing the
  // Suspense fallback.
  //
  // Why we need this: without prefetch, the first tap-into-Admin shows
  // ~400-1000ms of spinner on slow networks, which (a) feels like a
  // stutter on Telegram WebApp, and (b) is enough to make the deep
  // smoke's 400ms post-click waitForTimeout race the chunk download.
  // We use requestIdleCallback when available so we don't compete with
  // first-paint work on the entry route.
  const canAdmin = !!session?.permissions.includes('users.manage');
  // M3.11: same warmup pattern for RunPage. Trigger when the user
  // can see the Run tab. Purchasers in production are a small share
  // of users, so a non-purchaser saves the 60 kB of RunPage chunk
  // entirely; purchasers get the chunk prefetched right after login.
  const canRun = !!session?.permissions.includes('run.purchase');
  useEffect(() => {
    if (!canAdmin && !canRun) return;
    type IdleCB = (cb: () => void) => number;
    const ric = (window as { requestIdleCallback?: IdleCB }).requestIdleCallback;
    const kick = () => {
      // Fire both prefetches if applicable. Each is a Promise we
      // intentionally drop — React.lazy will reuse the same Promise
      // when the user actually taps in.
      if (canAdmin) void importAdminPage();
      if (canRun) void importRunPage();
    };
    if (ric) ric(kick);
    else setTimeout(kick, 0);
  }, [canAdmin, canRun]);

  // The tab is remembered across visits. A remembered tab the person
  // can no longer open resolves to their first one instead of a blank.
  const persistedTab = useNavStore((s) => s.tab);
  const setTab = useNavStore((s) => s.setTab);
  const tab = resolveVisibleTab(persistedTab, reachable);
  useEffect(() => {
    if (tab !== persistedTab) setTab(tab);
  }, [tab, persistedTab, setTab]);
  const go = (next: Tab) => {
    if (next === tab) return;
    // A screen with unsaved work can refuse to be left.
    void requestTabChange(next).then((allowed) => {
      if (allowed) setTab(next);
    });
  };

  const [settingsOpen, setSettingsOpen] = useState(false);
  useTelegramSettingsButton(() => setSettingsOpen(true));

  // `window.Telegram` exists in any browser, because index.html loads the
  // SDK; only real initData means Telegram's chrome is on screen.
  const inTelegram = isInTelegram();
  useTelegramChrome(inTelegram);

  // History and administration open from the menu, so Telegram's back
  // arrow returns there. Administration has its own back handling once
  // inside a section, and an open sheet owns the arrow while it is open.
  const behindMenu = tab === 'history' || tab === 'admin';
  const adminAtHome = useNavStore((s) => s.adminSection === 'home');
  const sheets = useSheetCount();
  useTelegramBackButton(
    () => go('menu'),
    behindMenu && sheets === 0 && (tab !== 'admin' || adminAtHome),
  );

  const pages: Record<Tab, () => ReactNode> = {
    order: () => <OrderPage />,
    approve: () => <ApprovalPage />,
    run: () => lazily(<RunPage />),
    confirm: () => <ConfirmPage />,
    settlement: () => lazily(<SettlementPage />),
    history: () => lazily(<HistoryPage />),
    admin: () => lazily(<AdminPage />),
    menu: () => <MenuPage onOpen={go} onOpenSettings={() => setSettingsOpen(true)} />,
  };

  const waitingForApproval = usePendingApprovals(can('order.approve'));
  const busy = useAppMutating();
  const items: Array<NavItem<Tab>> = [
    ...tasks.map((t) => ({
      key: t.key,
      label: i18n.t(t.labelKey as Parameters<typeof i18n.t>[0]) as string,
      count: t.key === 'approve' ? waitingForApproval : undefined,
    })),
    { key: 'menu', label: i18n.t('nav.menu') as string },
  ];

  return (
    <div
      className="flex min-h-0 flex-col bg-neutral"
      style={{ height: 'var(--app-viewport-h, 100dvh)' }}
    >
      <SettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} pageMenu={pageMenu} />
      <StoreBar inTelegram={inTelegram} />

      <main
        className="min-h-0 flex-1 overflow-y-auto"
        // iOS momentum scrolling, and a bounce that stays inside the app
        // instead of dragging Telegram's container.
        style={{ WebkitOverflowScrolling: 'touch', overscrollBehaviorY: 'contain' }}
      >
        {pages[tab]()}
      </main>

      <BottomChrome>
        <PageAction />
        <BottomNav<Tab>
          label={i18n.t('nav.primaryAriaLabel') as string}
          items={items}
          // History and administration live under the menu.
          active={behindMenu ? 'menu' : tab}
          onSelect={(key) => go(key)}
          // Leaving mid-save would land on a screen that has not seen the
          // result yet.
          disabled={busy}
          className={busy ? 'opacity-60' : undefined}
        />
      </BottomChrome>
    </div>
  );
}

/**
 * The pinned bottom of the app: a screen's action, then the navigation.
 * Its height is published as `--app-bottom-chrome-h` so that toasts can
 * sit above it rather than over the button a person is about to press.
 */
function BottomChrome({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const publish = () =>
      root.style.setProperty('--app-bottom-chrome-h', `${el.getBoundingClientRect().height}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--app-bottom-chrome-h');
    };
  }, []);
  return (
    <div ref={ref} className="shrink-0">
      {children}
    </div>
  );
}

/**
 * The current screen's main action, which pages declare with
 * usePageMainButton. It is drawn here, above the navigation, so the
 * navigation never moves when an action appears or goes. Telegram's own
 * MainButton stays hidden: it sits below the WebView and would push the
 * navigation up.
 */
function PageAction() {
  const state = usePageMainButtonState();
  const busy = useAppMutating();
  useEffect(() => {
    window.Telegram?.WebApp?.MainButton.hide();
  }, [state?.visible]);

  if (!state || !state.visible) return null;
  return (
    <ActionBar className="py-md">
      <Button
        variant="primary"
        data-testid="page-main-button"
        // Also while some OTHER write is in flight: two saves racing each
        // other is how a screen ends up showing the loser.
        disabled={!state.active || busy}
        aria-busy={busy || undefined}
        onClick={state.onClick}
      >
        {state.text}
      </Button>
    </ActionBar>
  );
}

/** Orders waiting for a decision in the current store, for the nav count. */
function usePendingApprovals(enabled: boolean): number {
  const ctx = useStoreContext();
  // Same query and input as the approval screen, so the two share a cache
  // entry and the realtime invalidation keeps both current.
  const query = trpc.order.pendingList.useQuery(
    { status: 'submitted', ...(ctx.kind === 'specific' ? { storeId: ctx.storeId } : {}) },
    { enabled: enabled && ctx.kind !== 'none' },
  );
  return query.data?.length ?? 0;
}
