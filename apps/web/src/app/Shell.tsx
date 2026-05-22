import { lazy, Suspense, useEffect, useState } from 'react';
import type { ComponentType, ReactNode, SVGProps } from 'react';
import {
  IconAdmin,
  IconApprove,
  IconConfirm,
  IconOrder,
  IconRun,
  Spinner,
} from '@compass/ui';
import { OrderPage } from '../pages/OrderPage';
import { ApprovalPage } from '../pages/ApprovalPage';
import { ConfirmPage } from '../pages/ConfirmPage';
// AdminPage is the heaviest screen in the bundle (~5k LoC + the role
// editor + the audit list etc.). Most users will never open it — the
// `users.manage` permission gate hides the tab — yet a static import
// puts it in the initial JS chunk every fresh load downloads. Lazy +
// Suspense splits it out to its own chunk that only admins pay for.
// (M1.3, 2026-05-06.) The other tabs stay eagerly imported because
// every authenticated user reaches at least one of them.
const importAdminPage = () =>
  import('../pages/AdminPage').then((m) => ({ default: m.AdminPage }));
const AdminPage = lazy(importAdminPage);
// M3.11 (2026-05-16): same treatment for RunPage. ~3.4k LoC + heavy
// purchase / delivery / confirm sheets + history detail. The
// `run.purchase` permission gate hides the tab from staff, cashiers,
// receivers etc. — typical deployment has 1 purchaser per N stores,
// so 90% of users pay for the chunk without ever opening it. Pulling
// it behind lazy() saves ~60 kB off the initial bundle. Prefetch
// (below) keeps the tap-to-open latency snappy for actual purchasers.
const importRunPage = () =>
  import('../pages/RunPage').then((m) => ({ default: m.RunPage }));
const RunPage = lazy(importRunPage);
import { useAuthStore } from '../stores/authStore';
import { useNavStore, resolveVisibleTab } from '../stores/navStore';
import { useI18n } from '../hooks/useI18n';
import { useTelegramSettingsButton } from '../hooks/useTelegram';
import { SettingsSheet } from '../components/SettingsSheet';
import { PageMenuProvider, usePageMenuRegistration } from './PageMenuContext';

// Debug tab moved INTO Admin as a sub-tab. Reduces bottom-nav clutter
// (was 6 items, now 5) and groups operator-only views together. Admins
// reach Debug via Admin → Debug; non-admins never see it (which is
// what `system.logs.view` already gated).
type Tab = 'order' | 'approve' | 'run' | 'confirm' | 'admin';

type IconComponent = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

const TABS: Array<{ key: Tab; permission: string | null; labelKey: string; Icon: IconComponent }> = [
  { key: 'order', permission: 'order.draft', labelKey: 'nav.order', Icon: IconOrder },
  { key: 'approve', permission: 'order.approve', labelKey: 'nav.approve', Icon: IconApprove },
  { key: 'run', permission: 'run.purchase', labelKey: 'nav.run', Icon: IconRun },
  { key: 'confirm', permission: 'delivery.confirm', labelKey: 'nav.confirm', Icon: IconConfirm },
  { key: 'admin', permission: 'users.manage', labelKey: 'nav.admin', Icon: IconAdmin },
];

// Loading fallback for lazily-imported pages. Centered spinner so the
// blip between bundle download and render doesn't look like a stall.
// 80vh keeps it visually placed where the page content would be, not
// crammed under the header.
function PageLoading() {
  return (
    <div className="flex h-[80vh] items-center justify-center">
      <Spinner size={20} />
    </div>
  );
}

const PAGES: Record<Tab, () => ReactNode> = {
  order: () => <OrderPage />,
  approve: () => <ApprovalPage />,
  run: () => (
    <Suspense fallback={<PageLoading />}>
      <RunPage />
    </Suspense>
  ),
  confirm: () => <ConfirmPage />,
  admin: () => (
    <Suspense fallback={<PageLoading />}>
      <AdminPage />
    </Suspense>
  ),
};

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
  // M1.12: contextual "this page" actions live in the same gear as the
  // global SettingsSheet. Pages register via usePageMenu(). When the
  // sheet opens it shows the page section first, then global settings.
  const pageMenu = usePageMenuRegistration();

  const visible = TABS.filter(
    (t) => !t.permission || session?.permissions.includes(t.permission),
  );

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

  // M3.16-B (2026-05-16): tab state lives in navStore (persisted to
  // localStorage). On hydration, resolve the persisted tab against
  // the currently-visible tab set so a lost permission doesn't strand
  // the user on a blank page.
  const persistedTab = useNavStore((s) => s.tab);
  const setPersistedTab = useNavStore((s) => s.setTab);
  const visibleKeys = visible.map((t) => t.key as Tab);
  const tab = resolveVisibleTab(persistedTab, visibleKeys);
  const setTab = setPersistedTab;
  // If the resolved tab differs from what's persisted (permission
  // lost since last session), write the corrected value back so we
  // don't keep re-resolving on every render.
  useEffect(() => {
    if (tab !== persistedTab) setPersistedTab(tab);
  }, [tab, persistedTab, setPersistedTab]);
  // App-level language picker — wired into Telegram's gear icon in
  // the bot's `⋯` overflow menu (added 2026-05-05). Available on every
  // page for every user without consuming layout space. The Admin →
  // Organization screen also has a Language row for admins on web
  // preview where the gear isn't rendered.
  // M1.6 (2026-05-06): the Telegram gear icon now opens a fuller
  // SettingsSheet (profile + language + about), not just a language
  // picker. State variable name kept short for legacy locality.
  const [settingsOpen, setSettingsOpen] = useState(false);
  useTelegramSettingsButton(() => setSettingsOpen(true));

  // Inside Telegram, the platform chrome (Close + bot title + ⋯) is the
  // header. Rendering our own title bar here would just collide with it
  // (and on iOS Telegram's chrome overlay can't be measured via env()).
  //
  // Telegram on iOS already pushes our content below the dynamic island /
  // status bar via its own viewport calculation, AND env(safe-area-inset-top)
  // resolves to that offset. So we don't need to reserve the full chrome
  // height — env() already covers the device's safe area, and Telegram's
  // own chrome row sits ABOVE that in a translucent overlay we can ignore.
  //
  // The earlier 80px reserved strip was empirically too much: on iPhone 14+
  // it produced a ~140 px black band before the first content row. A small
  // 12 px floor avoids hairline-tight content while letting env() do its job.
  // M3.18: window.Telegram is globally typed via src/types/telegram.d.ts.
  const inTelegram = typeof window !== 'undefined' && !!window.Telegram;

  // M3.42 (2026-05-22): Android Telegram WebView doesn't expose
  // `env(safe-area-inset-top)` (returns 0), so the 36-px chrome reserve
  // fell short of Telegram's Close + bot title row (~56-64 px on
  // Android) and our sticky page header rendered behind it. Read the
  // accurate value from the SDK when available:
  //   1. WebApp.contentSafeAreaInset.top  (TG 8.0+) — gold standard,
  //      includes both device safe-area AND Telegram's own chrome row
  //   2. WebApp.safeAreaInset.top         (TG 8.0+) + a platform-aware
  //      chrome-row addition
  //   3. fallback to env() + the historical 36-px addition (iOS path)
  // Result is written to the CSS variable `--app-chrome-reserve` and
  // read by the reserved strip below. Listens for safeAreaChanged /
  // contentSafeAreaChanged so we re-measure when the user rotates or
  // pulls Telegram's keyboard.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const tg = window.Telegram?.WebApp;
    if (!tg) return;
    const apply = () => {
      const platform = tg.platform ?? 'unknown';
      // M3.47 (2026-05-22): even when the SDK reports a number,
      // floor it at the platform-empirical chrome-row value.
      // contentSafeAreaInset.top has been observed to UNDER-report
      // on iOS Telegram when the floating Close button extends
      // beyond the standard chrome row. Without the floor, page
      // content (e.g. PreviewSummaryCard's "可以生成采购单"
      // CardHeader title) lands behind the close button.
      const chromeRowFloor =
        platform === 'android' ? 56 : platform === 'tdesktop' ? 0 : 64;
      // --- Vertical chrome reserve ---
      const contentTop = tg.contentSafeAreaInset?.top;
      if (typeof contentTop === 'number' && contentTop > 0) {
        const safeTop = tg.safeAreaInset?.top ?? 0;
        const minReserve = safeTop + chromeRowFloor;
        const reserve = Math.max(contentTop, minReserve);
        document.documentElement.style.setProperty(
          '--app-chrome-reserve',
          `${reserve}px`,
        );
      } else {
        const safeTop = tg.safeAreaInset?.top;
        // chromeRowFloor (declared above) carries the empirical
        // values: Android 56 / iOS 64 / tdesktop 0. iOS bumped from
        // M3.42's 36 to 64 because the close button is a floating
        // overlay that extends beyond the standard chrome row, and
        // the old 36-px reserve let the first-card header land
        // behind it.
        if (typeof safeTop === 'number') {
          document.documentElement.style.setProperty(
            '--app-chrome-reserve',
            `${safeTop + chromeRowFloor}px`,
          );
        } else {
          // No SDK telemetry. Fall back to env() (handled in the CSS
          // var default below) — leaves the var unset.
          document.documentElement.style.removeProperty('--app-chrome-reserve');
        }
      }
      // --- Horizontal chrome pad (M3.46, 2026-05-22) ---
      // Telegram renders a Close button at top-LEFT and a ⋯ overflow
      // menu at top-RIGHT. With M3.42 our content sits BELOW the
      // chrome row vertically, but the chrome buttons stay anchored
      // in place over their slots — and sticky page headers that
      // put content at the left/right edge still got hidden by them.
      //
      // contentSafeAreaInset.left/right gives the precise overlay
      // widths on TG 8.0+ clients; fall back to platform-empirical
      // defaults otherwise. The values land on
      // `--app-chrome-pad-left` / `--app-chrome-pad-right` so any
      // sticky strip can opt in via padding.
      const contentLeft = tg.contentSafeAreaInset?.left;
      const contentRight = tg.contentSafeAreaInset?.right;
      // Empirical: Android Close button ~56px, ⋯ overflow + menu ~96px.
      // iOS slightly smaller — but 56/96 over-pads safely; under-pads
      // are the visible bug, over-pads just shrink the title area.
      // tdesktop: no chrome — 0.
      const defaultLeft =
        platform === 'tdesktop' ? 0 : platform === 'android' ? 56 : 56;
      const defaultRight =
        platform === 'tdesktop' ? 0 : platform === 'android' ? 96 : 96;
      const padLeft =
        typeof contentLeft === 'number' && contentLeft > 0 ? contentLeft : defaultLeft;
      const padRight =
        typeof contentRight === 'number' && contentRight > 0
          ? contentRight
          : defaultRight;
      document.documentElement.style.setProperty(
        '--app-chrome-pad-left',
        `${padLeft}px`,
      );
      document.documentElement.style.setProperty(
        '--app-chrome-pad-right',
        `${padRight}px`,
      );
    };
    apply();
    // Newer Telegram clients fire these events when the user changes
    // orientation, the keyboard opens, or pulls down the chrome.
    const onEvent = tg.onEvent;
    const offEvent = tg.offEvent;
    if (onEvent && offEvent) {
      onEvent('safeAreaChanged', apply);
      onEvent('contentSafeAreaChanged', apply);
      onEvent('viewportChanged', apply);
      return () => {
        offEvent('safeAreaChanged', apply);
        offEvent('contentSafeAreaChanged', apply);
        offEvent('viewportChanged', apply);
      };
    }
    return;
  }, []);

  return (
    <div className="flex h-full flex-col bg-[var(--c-bg)]">
      <SettingsSheet
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        pageMenu={pageMenu}
      />
      {inTelegram ? (
        // Reserved strip lets Telegram's chrome (Close + bot title + ⋯)
        // sit on top without overlapping our content.
        //
        // M3.42 (2026-05-22): height is `--app-chrome-reserve` (set by
        // the useEffect above from Telegram WebApp's contentSafeAreaInset
        // / safeAreaInset / platform), with the legacy
        // `calc(--app-safe-top + 36px)` rule as the fallback when the
        // SDK doesn't expose anything (older Telegram clients, web
        // preview wrapped in fake WebApp).
        //
        // iOS env(safe-top) already covers the dynamic island; we add
        // ~36 px for the chrome row itself. On Android the SDK reports
        // a ~56 px row, which the variable now picks up correctly.
        <div
          aria-hidden
          style={{
            flexShrink: 0,
            height:
              'var(--app-chrome-reserve, calc(var(--app-safe-top) + 36px))',
            background: 'var(--c-bg)',
          }}
        />
      ) : (
        <header
          className="sticky top-0 z-10 flex items-center justify-between border-b border-[var(--c-divider)] bg-[var(--c-surface)]"
          style={{
            paddingTop: 'var(--app-safe-top)',
            paddingLeft: 'max(16px, var(--app-safe-left))',
            paddingRight: 'max(16px, var(--app-safe-right))',
            height: 'calc(var(--app-header-h) + var(--app-safe-top))',
          }}
        >
          <span className="text-h3 font-semibold tracking-tight">Compass</span>
          <span className="text-label text-[var(--c-fg-muted)]">
            {session?.member.orgName}
          </span>
        </header>
      )}

      <main
        className="flex-1 overflow-y-auto"
        // Native iOS momentum scrolling. Without this, scroll inside
        // the WebView feels stuttery and stops abruptly when you lift
        // your finger — Telegram's WebView doesn't enable this by
        // default. -webkit-overflow-scrolling: touch is the iOS-only
        // way to opt in. overscroll-behavior: contain prevents the
        // bounce from propagating to Telegram's container, which
        // sometimes manifested as a "scroll stalls" feeling.
        style={{
          WebkitOverflowScrolling: 'touch',
          overscrollBehaviorY: 'contain',
        }}
      >
        {PAGES[tab]()}
      </main>

      <nav
        className="grid border-t border-[var(--c-divider)] bg-[var(--c-surface)]"
        style={{
          gridTemplateColumns: `repeat(${visible.length}, minmax(0, 1fr))`,
          paddingBottom: 'var(--app-safe-bottom)',
          height: 'calc(var(--app-nav-h) + var(--app-safe-bottom))',
        }}
        aria-label="Primary"
      >
        {visible.map((t) => {
          const active = tab === t.key;
          const Icon = t.Icon;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key as Tab)}
              aria-current={active ? 'page' : undefined}
              className={
                'press flex flex-col items-center justify-center gap-1 ' +
                (active ? 'text-[var(--c-action)]' : 'text-[var(--c-fg-muted)]')
              }
            >
              <Icon size={22} />
              <span
                className={
                  active
                    ? 'text-tiny font-semibold leading-none'
                    : 'text-tiny leading-none'
                }
              >
                {i18n.t(t.labelKey as Parameters<typeof i18n.t>[0])}
              </span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

