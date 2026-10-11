import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Spinner, useSheetCount } from '@compass/ui';
import { ActionBar, BottomNav, Button, Money } from '@compass/ui/kit';
import type { NavItem } from '@compass/ui/kit';
import { OrderPage } from '../pages/OrderPage';
import { ApprovalPage } from '../pages/ApprovalPage';
import { ConfirmPage } from '../pages/ConfirmPage';
import { TodayPage } from '../destinations/TodayPage';
import { OrdersPage } from '../destinations/OrdersPage';
import { PurchasingPage } from '../destinations/PurchasingPage';
import { ManagePage } from '../destinations/ManagePage';
import { ManageIcon, OrdersIcon, PurchasingIcon, TodayIcon } from '../destinations/icons';
// M3.11 (2026-05-16): same treatment for RunPage. ~3.4k LoC + heavy
// purchase / delivery / confirm sheets + history detail. The
// `run.purchase` permission gate hides the tab from staff, cashiers,
// receivers etc. — typical deployment has 1 purchaser per N stores,
// so 90% of users pay for the chunk without ever opening it. Pulling
// it behind lazy() saves ~60 kB off the initial bundle. Prefetch
// (below) keeps the tap-to-open latency snappy for actual purchasers.
const importRunPage = () => import('../pages/RunPage').then((m) => ({ default: m.RunPage }));
const RunPage = lazy(importRunPage);
// Daily close is a financial, permission-gated surface. Keep its form and
// recent-ledger query code out of the startup bundle for everyone else.
const importSettlementPage = () =>
  import('../pages/SettlementPage').then((m) => ({ default: m.SettlementPage }));
const SettlementPage = lazy(importSettlementPage);
import { useAuthStore } from '../stores/authStore';
import { requestTabChange, resolveVisibleTab, useNavStore, landingTab } from '../stores/navStore';
import type { Tab } from '../stores/navStore';
import { useI18n } from '../hooks/useI18n';
import {
  isInTelegram,
  usePageMainButtonState,
  useTelegramBackButton,
  useTelegramSettingsButton,
} from '../hooks/useTelegram';
import { useAppMutating } from '../hooks/useAppMutating';
import { SettingsSheet } from '../components/SettingsSheet';
import { PageMenuProvider, usePageMenuRegistration } from './PageMenuContext';
import { StoreBar } from './StoreBar';
import { useTelegramChrome } from './useTelegramChrome';

/**
 * Places to go. They have the navigation under them and are for looking
 * and choosing. Each appears only for someone with a reason to be there.
 */
const DESTINATIONS: Array<{
  key: Tab;
  labelKey: string;
  icon: ReactNode;
  anyOf: string[] | null;
}> = [
  { key: 'menu', labelKey: 'nav.today', icon: <TodayIcon />, anyOf: null },
  {
    key: 'orders',
    labelKey: 'nav.orders',
    icon: <OrdersIcon />,
    anyOf: ['order.draft', 'order.approve'],
  },
  {
    key: 'purchasing',
    labelKey: 'nav.purchasing',
    icon: <PurchasingIcon />,
    anyOf: ['run.purchase', 'prices.view'],
  },
  {
    key: 'admin',
    labelKey: 'nav.manage',
    icon: <ManageIcon />,
    anyOf: ['users.manage', 'settlement.record'],
  },
];

/**
 * Things to do. A task takes the whole screen: no navigation, a way back,
 * and one button. In the order a day runs.
 */
const TASKS: Array<{ key: Tab; permission: string }> = [
  { key: 'order', permission: 'order.draft' },
  { key: 'approve', permission: 'order.approve' },
  { key: 'run', permission: 'run.purchase' },
  { key: 'confirm', permission: 'delivery.confirm' },
  { key: 'settlement', permission: 'settlement.record' },
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

  const destinations = DESTINATIONS.filter(
    (d) => d.anyOf === null || d.anyOf.some((permission) => can(permission)),
  );
  // Daily close is a part of the product an organisation either uses or
  // does not; having the permission is not enough to be shown it.
  const tasks = TASKS.filter(
    (t) => can(t.permission) && (t.key !== 'settlement' || !!session?.member.dailyClose),
  );
  const reachable: Tab[] = [...destinations.map((d) => d.key), ...tasks.map((t) => t.key)];

  // The buying screen is the heaviest and only purchasers open it: fetch
  // its code once the page is idle, so the first tap does not wait for it.
  const canRun = !!session?.permissions.includes('run.purchase');
  useEffect(() => {
    if (!canRun) return;
    type IdleCB = (cb: () => void) => number;
    const ric = (window as { requestIdleCallback?: IdleCB }).requestIdleCallback;
    const kick = () => void importRunPage();
    if (ric) ric(kick);
    else setTimeout(kick, 0);
  }, [canRun]);

  const persistedTab = useNavStore((s) => s.tab);
  const setTab = useNavStore((s) => s.setTab);
  // Decided once per visit, from what was stored when the app opened.
  const [landing] = useState(() => {
    const stored = useNavStore.getState();
    return landingTab(
      stored.tab,
      stored.tabAt,
      tasks.map((t) => t.key),
      reachable,
      Date.now(),
    );
  });
  const landed = useRef(false);
  const tab = resolveVisibleTab(landed.current ? persistedTab : landing, reachable);
  useEffect(() => {
    landed.current = true;
    if (tab !== persistedTab) setTab(tab);
  }, [tab, persistedTab, setTab]);

  const isTask = tasks.some((t) => t.key === tab);
  // Where "back" from a task leads: the place it was opened from.
  const cameFrom = useRef<Tab>('menu');
  if (!isTask) cameFrom.current = tab;

  const go = (next: Tab) => {
    if (next === tab) return;
    // A screen with unsaved work can refuse to be left.
    void requestTabChange(next).then((allowed) => {
      if (allowed) setTab(next);
    });
  };
  const back = () => go(reachable.includes(cameFrom.current) ? cameFrom.current : 'menu');

  const [settingsOpen, setSettingsOpen] = useState(false);
  useTelegramSettingsButton(() => setSettingsOpen(true));

  // `window.Telegram` exists in any browser, because index.html loads the
  // SDK; only real initData means Telegram's chrome is on screen.
  const inTelegram = isInTelegram();
  useTelegramChrome(inTelegram);

  // On a task screen Telegram's own arrow is the way back. An open sheet
  // owns the arrow while it is open.
  const sheets = useSheetCount();
  useTelegramBackButton(back, isTask && sheets === 0);

  const openSettings = () => setSettingsOpen(true);
  const pages: Record<Tab, () => ReactNode> = {
    menu: () => <TodayPage onOpen={go} onOpenSettings={openSettings} />,
    orders: () => <OrdersPage onOpen={go} />,
    purchasing: () => <PurchasingPage onOpen={go} />,
    admin: () => <ManagePage onOpen={go} onOpenSettings={openSettings} />,
    order: () => <OrderPage />,
    approve: () => <ApprovalPage />,
    run: () => lazily(<RunPage />),
    confirm: () => <ConfirmPage />,
    settlement: () => lazily(<SettlementPage />),
    // Past purchases are part of Purchasing now; an old stored value lands there.
    history: () => <PurchasingPage onOpen={go} />,
  };

  const busy = useAppMutating();
  const items: Array<NavItem<Tab>> = destinations.map((d) => ({
    key: d.key,
    label: i18n.t(d.labelKey as Parameters<typeof i18n.t>[0]) as string,
    icon: d.icon,
  }));

  return (
    // On a wide screen the app is one centred column: it is a phone tool,
    // and stretched rows put a name and its amount a hand's width apart.
    <div
      className="mx-auto flex min-h-0 w-full max-w-md flex-col bg-neutral"
      style={{ height: 'var(--app-viewport-h, 100dvh)' }}
    >
      <SettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} pageMenu={pageMenu} />
      <StoreBar
        inTelegram={inTelegram}
        onOpenAccount={openSettings}
        // In Telegram its own arrow does this.
        onBack={isTask && !inTelegram ? back : undefined}
        bare={tab === 'menu'}
      />

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
        {/* A task has the whole screen; the navigation is for choosing one. */}
        {isTask ? null : (
          <BottomNav<Tab>
            label={i18n.t('nav.primaryAriaLabel') as string}
            items={items}
            active={tab}
            onSelect={(key) => go(key)}
            // Leaving mid-save would land on a screen that has not seen the
            // result yet.
            disabled={busy}
            className={busy ? 'opacity-60' : undefined}
          />
        )}
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
    <ActionBar
      className="py-md"
      summary={
        state.summary ? (
          <>
            <span className="min-w-0 text-body text-secondary">{state.summary.text}</span>
            {state.summary.amount ? (
              <Money amount={state.summary.amount} currency={state.summary.currency} />
            ) : null}
          </>
        ) : undefined
      }
    >
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
