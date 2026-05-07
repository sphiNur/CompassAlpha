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
import { RunPage } from '../pages/RunPage';
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
import { useAuthStore } from '../stores/authStore';
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
  run: () => <RunPage />,
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
  useEffect(() => {
    if (!canAdmin) return;
    const kick = () => { void importAdminPage(); };
    type IdleCB = (cb: () => void) => number;
    const ric = (window as { requestIdleCallback?: IdleCB }).requestIdleCallback;
    if (ric) ric(kick);
    else setTimeout(kick, 0);
  }, [canAdmin]);

  const [tab, setTab] = useState<Tab>(() => (visible[0]?.key as Tab) ?? 'order');
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
  const inTelegram =
    typeof window !== 'undefined' && !!(window as { Telegram?: unknown }).Telegram;

  return (
    <div className="flex h-full flex-col bg-[var(--c-bg)]">
      <SettingsSheet
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        pageMenu={pageMenu}
      />
      {inTelegram ? (
        // Reserved strip lets Telegram's chrome (Close + bot title + ⋯)
        // sit on top without overlapping our content. iOS env(safe-top)
        // already covers the dynamic island; we add ~36 px for the chrome
        // row itself. Tested values: 80 was too much (produced a ~140 px
        // black band before the first content), 24 clipped page titles
        // on devices without a notch. 36 is the sweet spot.
        <div
          aria-hidden
          style={{
            flexShrink: 0,
            height: 'calc(var(--app-safe-top) + 36px)',
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

