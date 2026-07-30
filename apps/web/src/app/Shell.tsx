import { lazy, Suspense, useEffect, useState } from 'react';
import type { ComponentType, ReactNode, SVGProps } from 'react';
import {
  IconAdmin,
  IconApprove,
  IconConfirm,
  IconHistory,
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
// 2026-07-30: history is its own tab now. Lazy for the same reason as
// RunPage — it pulls in the ~800-line history subsystem plus the money
// settlement helpers. Rollup hoists RunHistory.tsx into a chunk shared
// with RunPage, so a purchaser who opens both downloads it once.
const importHistoryPage = () =>
  import('../pages/HistoryPage').then((m) => ({ default: m.HistoryPage }));
const HistoryPage = lazy(importHistoryPage);
import { useAuthStore } from '../stores/authStore';
import { useNavStore, resolveVisibleTab } from '../stores/navStore';
import { useI18n } from '../hooks/useI18n';
import {
  isInTelegram,
  useTelegramSettingsButton,
  usePageMainButtonState,
} from '../hooks/useTelegram';
import { useAppMutating } from '../hooks/useAppMutating';
import { SettingsSheet } from '../components/SettingsSheet';
import { StoreChip } from '../components/StoreSwitcher';
import { PageMenuProvider, usePageMenuRegistration } from './PageMenuContext';

// Debug tab moved INTO Admin as a sub-tab. Reduces bottom-nav clutter
// (was 6 items, now 5) and groups operator-only views together. Admins
// reach Debug via Admin → Debug; non-admins never see it (which is
// what `system.logs.view` already gated).
type Tab = 'order' | 'approve' | 'run' | 'history' | 'confirm' | 'admin';

type IconComponent = ComponentType<SVGProps<SVGSVGElement> & { size?: number }>;

const TABS: Array<{ key: Tab; permission: string | null; labelKey: string; Icon: IconComponent }> = [
  { key: 'order', permission: 'order.draft', labelKey: 'nav.order', Icon: IconOrder },
  { key: 'approve', permission: 'order.approve', labelKey: 'nav.approve', Icon: IconApprove },
  { key: 'run', permission: 'run.purchase', labelKey: 'nav.run', Icon: IconRun },
  // 2026-07-30: purchase history used to be reachable only from the
  // bottom of the Run tab, which meant only `run.purchase` holders
  // could see it — a store manager had no route to their own store's
  // spend. `prices.view` is the money-visibility permission (purchaser
  // + manager + admin + super_admin) and is the right gate for a
  // price-and-spend record. See HistoryPage.tsx for why this needed no
  // server-side change.
  { key: 'history', permission: 'prices.view', labelKey: 'nav.history', Icon: IconHistory },
  { key: 'confirm', permission: 'delivery.confirm', labelKey: 'nav.confirm', Icon: IconConfirm },
  { key: 'admin', permission: 'users.manage', labelKey: 'nav.admin', Icon: IconAdmin },
];

// Loading fallback for lazily-imported pages. Centered spinner so the
// blip between bundle download and render doesn't look like a stall.
// 80vh keeps it visually placed where the page content would be, not
// crammed under the header.
function PageLoading() {
  return (
    <div className="flex min-h-[min(80dvh,calc(var(--app-viewport-h)-var(--app-nav-h)))] items-center justify-center">
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
  history: () => (
    <Suspense fallback={<PageLoading />}>
      <HistoryPage />
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
  //
  // 2026-07-30: was `!!window.Telegram`, true in any browser because
  // index.html loads the SDK statically. The app therefore ALWAYS reserved
  // a blank strip for Telegram's chrome and never rendered its own header
  // — no title, no org name, just ~60 px of empty space at the top of
  // every screen outside Telegram. `isInTelegram()` tests real initData.
  const inTelegram = isInTelegram();

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
    // 2026-07-30: the same trap the header fix above walked into, one
    // layer down. index.html loads the SDK statically, so `tg` exists in
    // a plain browser too — platform 'unknown', empty initData, every
    // inset 0. Its presence says nothing about whether Telegram's chrome
    // is on screen, and `contentSafeAreaInset.left/right` of 0 falls
    // through to the platform-empirical defaults, so the browser build
    // padded every StickyPageBar by 56 px left / 96 px right to clear a
    // Close button and a ⋯ menu that are not there. On Order that left
    // the store chip + search + category strip boxed into the middle
    // 208 px of a 375 px viewport while the SKU rows under it ran edge
    // to edge. Outside Telegram, Shell renders its own <header> and
    // there is no overlay chrome to clear — drop the vars so the
    // `var(--app-chrome-pad-*, 16px)` fallbacks take over.
    if (!tg || !inTelegram) {
      const root = document.documentElement;
      root.style.removeProperty('--app-chrome-reserve');
      root.style.removeProperty('--app-chrome-safe-top');
      root.style.removeProperty('--app-chrome-pad-left');
      root.style.removeProperty('--app-chrome-pad-right');
      return;
    }
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
      // 2026-07-30: publish the SDK's own safe-area top alongside the
      // reserve. The strip that holds the store title needs to know
      // which slice of `--app-chrome-reserve` is device safe-area
      // (notch / dynamic island) and which is Telegram's actual button
      // row, so it can center the title on the BUTTONS rather than on
      // the whole strip. It used to derive that from CSS
      // `--app-safe-top` — `max(env(safe-area-inset-top), 16px)` — a
      // different source of truth with a 16px floor the SDK value
      // doesn't have, so the two disagreed and the title rendered a
      // few px below the Close / ⋯ centerline.
      document.documentElement.style.setProperty(
        '--app-chrome-safe-top',
        `${tg.safeAreaInset?.top ?? 0}px`,
      );
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
  }, [inTelegram]);

  return (
    <div
      className="flex min-h-0 flex-col bg-[var(--c-bg)]"
      style={{ height: 'var(--app-viewport-h, 100dvh)' }}
    >
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
        //
        // 2026-07-30: the strip is no longer blank — it carries the
        // current store, sitting where Telegram puts a bot title:
        // between the Close button (left) and the ⋯ overflow (right).
        //
        // Padding is the LARGER of the two chrome pads on BOTH sides,
        // not each side's own value. Telegram's right cluster is wider
        // than Close (96px vs 56px measured on Android), so per-side
        // padding centers the title in the free GAP — about 30px left
        // of the screen's center line, which reads as misaligned right
        // next to Telegram's own screen-centered chrome. Padding both
        // sides by max() puts the title on the true center line while
        // still clearing the wider cluster, so it cannot slide under
        // either button.
        //
        // `paddingTop` drops it below the device safe area so it lands
        // on the button row rather than in the notch — using the SDK's
        // `--app-chrome-safe-top`, the same source the height came
        // from (box-border makes that padding eat the safe-area share
        // of `--app-chrome-reserve`, leaving exactly the button row).
        <div
          className="flex items-center justify-center"
          style={{
            flexShrink: 0,
            height:
              'var(--app-chrome-reserve, calc(var(--app-safe-top) + 36px))',
            background: 'var(--c-bg)',
            paddingTop: 'var(--app-chrome-safe-top, 0px)',
            paddingLeft:
              'max(var(--app-chrome-pad-left, 16px), var(--app-chrome-pad-right, 16px))',
            paddingRight:
              'max(var(--app-chrome-pad-left, 16px), var(--app-chrome-pad-right, 16px))',
          }}
        >
          <StoreChip />
        </div>
      ) : (
        // Outside Telegram there are no overlay buttons, but the header
        // plays the same role — so the store sits centered here too,
        // between the wordmark and the org name. A 3-column grid with
        // `1fr auto 1fr` keeps the chip on the true centre line no
        // matter how wide the two side labels are; `justify-between`
        // would drift it toward whichever side is shorter.
        <header
          className="sticky top-0 z-10 grid grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-[var(--c-divider)] bg-[var(--c-surface)]"
          style={{
            paddingTop: 'var(--app-safe-top)',
            paddingLeft: 'max(16px, var(--app-safe-left))',
            paddingRight: 'max(16px, var(--app-safe-right))',
            height: 'calc(var(--app-header-h) + var(--app-safe-top))',
          }}
        >
          <span className="truncate text-h3 font-semibold">Compass</span>
          <StoreChip />
          <span className="justify-self-end truncate text-label text-[var(--c-fg-muted)]">
            {session?.member.orgName}
          </span>
        </header>
      )}

      <main
        className="min-h-0 flex-1 overflow-y-auto"
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

      {/* M3.49 (2026-05-23): in-page primary action button. Telegram's
          native MainButton lives BELOW the WebView, so it pushed the
          bottom nav up whenever a page set a primary action. The
          user explicitly requested the bottom nav stay anchored at
          all times. This in-DOM button sits ABOVE the nav, so when
          it appears/disappears the NAV doesn't move — only the
          page-content area shrinks/grows. Driven by the same
          usePageMainButton hook every page already uses. */}
      <PageMainButton />

      <BottomNav
        visible={visible}
        tab={tab}
        setTab={(k) => setTab(k as Tab)}
        i18n={i18n}
      />
    </div>
  );
}

/**
 * M3.50 (2026-05-23): bottom nav extracted so it can call
 * useAppMutating() and disable tab switching while a mutation is in
 * flight. Without this, the user could tap Save (mutation started)
 * → tap a different tab mid-flight → land on a page that didn't see
 * the save result, racing the cache invalidation. Now: nav goes
 * grey + non-interactive until the mutation settles.
 *
 * Cosmetic: faded opacity rather than removed-from-screen, so the
 * user still has spatial context of where the nav is. Mirrors the
 * existing disabled-button look used everywhere else in the app.
 */
function BottomNav({
  visible,
  tab,
  setTab,
  i18n,
}: {
  visible: Array<{ key: Tab; permission: string | null; labelKey: string; Icon: IconComponent }>;
  tab: Tab;
  setTab: (k: Tab) => void;
  i18n: ReturnType<typeof useI18n>;
}) {
  const busy = useAppMutating();
  return (
    <nav
      className="grid shrink-0 border-t border-[var(--c-divider)] bg-[var(--c-surface)]"
      style={{
        gridTemplateColumns: `repeat(${visible.length}, minmax(0, 1fr))`,
        paddingBottom: 'var(--app-safe-bottom)',
        height: 'calc(var(--app-nav-h) + var(--app-safe-bottom))',
        // M3.50: block tab switches during in-flight mutations.
        pointerEvents: busy ? 'none' : undefined,
        opacity: busy ? 0.5 : undefined,
        transition: 'opacity 120ms ease',
      }}
      aria-label={i18n.t('nav.primaryAriaLabel')}
      aria-busy={busy || undefined}
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
            disabled={busy}
            className={
              'press flex min-w-0 flex-col items-center justify-center gap-1 px-1 ' +
              (active ? 'text-[var(--c-action)]' : 'text-[var(--c-fg-muted)]')
            }
          >
            <Icon size={visible.length >= 5 ? 21 : 22} />
            <span
              className={
                active
                  ? 'max-w-full truncate text-tiny font-semibold leading-none'
                  : 'max-w-full truncate text-tiny leading-none'
              }
            >
              {i18n.t(t.labelKey as Parameters<typeof i18n.t>[0])}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

/**
 * In-DOM page primary action button (M3.49, 2026-05-23). Reads from the
 * module-level store written by usePageMainButton(). Renders nothing
 * when no page has registered an action — the nav rises against the
 * page content. When a page sets one, a sticky bar appears ABOVE the
 * nav with the action's text + click handler.
 *
 * Telegram's native MainButton is kept permanently hidden (effect
 * below) so the two don't compete for the bottom-of-screen slot.
 */
function PageMainButton() {
  const state = usePageMainButtonState();
  // M3.50: also guard against re-tap during any in-flight mutation
  // (not just the one this button started). Without this guard, the
  // user could tap Save, then while it's processing tap a
  // sibling-screen's main button (e.g. switch tab → submit there)
  // and create a race.
  const busy = useAppMutating();
  // Permanently hide Telegram's native MainButton — we render our
  // own in-DOM equivalent above the bottom nav. The hide() call is
  // idempotent on the SDK side.
  useEffect(() => {
    const tg = typeof window !== 'undefined' ? window.Telegram?.WebApp : null;
    if (!tg) return;
    tg.MainButton.hide();
  }, [state?.visible]);

  if (!state || !state.visible) return null;
  const interactable = state.active && !busy;
  return (
    <div
      className="shrink-0 border-t border-[var(--c-divider)] bg-[var(--c-surface)]"
      style={{
        // Match the chrome horizontal pad so the button doesn't sit
        // beneath the Telegram overflow icons (it shouldn't on the
        // bottom edge, but defensive symmetry with the top sticky
        // headers — see M3.46).
        paddingLeft: 'max(16px, var(--app-safe-left, 16px))',
        paddingRight: 'max(16px, var(--app-safe-right, 16px))',
        paddingTop: 8,
        paddingBottom: 8,
      }}
    >
      <button
        type="button"
        disabled={!interactable}
        onClick={state.onClick}
        aria-busy={busy || undefined}
        className={
          'flex h-12 w-full min-w-0 items-center justify-center rounded-[var(--r-pill)] px-4 text-h3 font-semibold ' +
          (interactable
            ? 'bg-[var(--c-action)] text-[var(--c-action-fg)] active:opacity-80'
            : 'bg-[var(--c-surface-2)] text-[var(--c-fg-muted)]')
        }
      >
        <span className="min-w-0 truncate">{state.text}</span>
      </button>
    </div>
  );
}
