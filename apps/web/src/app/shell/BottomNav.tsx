/**
 * The foot of the screen: the tab bar, or with one page or none nothing
 * (showsNav; <main> then keeps the phone's home-indicator strip clear).
 *
 * Review COREWEB1-10 (2026-11-12): out of Shell.tsx, with the badge query
 * and the nav height. COREWEB1-31: no casts, and it reads the language
 * itself instead of taking i18n as a prop.
 *
 * Owner, 2026-11-14: a capsule floating over the page with at most five
 * items, four tabs + More when there are more (navLayout.ts). Its look is
 * `.app-nav` in styles/index.css.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { IconMore, Sheet } from '@compass/ui';
import { useNavigationBlocked } from '../../hooks/useAppMutating';
import { useI18n } from '../../hooks/useI18n';
import { pollWhenOffline, useRealtimeLive } from '../../hooks/useRealtime';
import { useStoreContext } from '../../hooks/useStoreContext';
import { navBadges, type NavBadge } from '../../lib/navBadges';
import { trpc } from '../../lib/trpc';
import { useAuthStore } from '../../stores/authStore';
import type { Tab } from '../../stores/navStore';
import { navLayout } from './navLayout';
import { showsNav, type TabDef } from './tabs';

interface BottomNavProps {
  tabs: readonly TabDef[];
  tab: Tab;
  onSelect: (tab: Tab) => void;
  /** The member's permissions over all their stores: which tabs go in the bar. */
  permissions: readonly string[];
}

export function BottomNav({ tabs, tab, onSelect, permissions }: BottomNavProps) {
  // 2026-11-05 (owner): without the bar, --app-nav-h goes to 0 so the main
  // button, toasts and empty states sit on the bottom edge instead of
  // above a gap. 2026-11-14: and the capsule's float gap with it, so the
  // room <main> keeps (--app-nav-reserve) is the home-indicator strip.
  const show = showsNav(tabs);
  useEffect(() => {
    const root = document.documentElement.style;
    const clear = () => {
      root.removeProperty('--app-nav-h');
      root.removeProperty('--app-nav-float');
    };
    if (show) clear();
    else {
      root.setProperty('--app-nav-h', '0px');
      root.setProperty('--app-nav-float', '0px');
    }
    return clear;
  }, [show]);
  if (!show) return null;
  return <TabBar tabs={tabs} tab={tab} onSelect={onSelect} permissions={permissions} />;
}

/**
 * DX-SHL-23 / DX-APR-5 / DX-DLV-13 (2026-11-01): badges on the tabs where
 * something waits for this person (requirement 03 §2.4): orders to
 * review, orders to buy, goods to receive, today's close not filed. One
 * small query for the store in the header; realtime invalidates it with
 * the order / run pushes, and it polls only while realtime is down.
 */
function useNavBadges(tabs: readonly TabDef[]) {
  const session = useAuthStore((s) => s.session);
  const storeCtx = useStoreContext();
  const realtimeLive = useRealtimeLive();
  const navCountsQuery = trpc.nav.counts.useQuery(
    storeCtx.kind === 'specific' ? { storeId: storeCtx.storeId } : {},
    {
      enabled: !!session && storeCtx.kind !== 'none',
      refetchInterval: pollWhenOffline(60_000, realtimeLive),
      // An older server without nav.counts: no badges, no retries.
      retry: false,
    },
  );
  return navBadges(
    navCountsQuery.data,
    tabs.map((t) => t.key),
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
 * F3 (2026-10-30): narrowed to the writes that swap the session — see
 * useNavigationBlocked for why leaving a page mid-write is safe.
 *
 * Cosmetic: faded opacity rather than removed-from-screen, so the
 * user still has spatial context of where the nav is. Mirrors the
 * existing disabled-button look used everywhere else in the app.
 */
function TabBar({ tabs, tab, onSelect, permissions }: BottomNavProps) {
  const i18n = useI18n();
  // F3 (2026-10-30): only writes that swap the session lock the nav now;
  // see useNavigationBlocked.
  const busy = useNavigationBlocked();
  const badges = useNavBadges(tabs);
  const { bar, more } = navLayout(tabs, permissions);
  const [moreOpen, setMoreOpen] = useState(false);
  // The open tab lives in More: the More item stands for it.
  const current = more.find((t) => t.key === tab);
  const moreBadge = more.some((t) => badges[t.key] !== undefined);
  // The badge is read with the name: 「审核，2 件待处理」.
  const badgeText = (t: TabDef): string | null => {
    const badge = badges[t.key];
    const label = i18n.t(t.labelKey);
    if (badge === undefined) return null;
    return badge === 'dot'
      ? i18n.t('nav.badge.due', { label })
      : i18n.t('nav.badge.count', { label, n: badge });
  };
  const moreLabel = current
    ? i18n.t('nav.moreCurrentAria', { label: i18n.t(current.labelKey) })
    : i18n.t('nav.moreAria');
  return (
    <>
      <nav
        data-testid="primary-nav"
        className="app-nav"
        style={{
          // M3.50: block tab switches during in-flight mutations.
          pointerEvents: busy ? 'none' : undefined,
          opacity: busy ? 0.5 : undefined,
        }}
        aria-label={i18n.t('nav.primaryAriaLabel')}
        aria-busy={busy || undefined}
      >
        {bar.map((t) => {
          const label = i18n.t(t.labelKey);
          const short = i18n.t(t.shortKey);
          return (
            <NavItem
              key={t.key}
              testId={`nav-${t.key}`}
              active={tab === t.key}
              Icon={t.Icon}
              short={short}
              // The short nav word is an abbreviation in ru / uz; screen
              // readers announce the section's full name. Review MWC-03: always
              // named, since the compact capsule hides the word (display:none)
              // and the icon is aria-hidden.
              ariaLabel={badgeText(t) ?? label}
              badge={<NavBadgeMark tabKey={t.key} badge={badges[t.key]} />}
              disabled={busy}
              onClick={() => onSelect(t.key)}
            />
          );
        })}
        {more.length > 0 ? (
          <NavItem
            testId="nav-more"
            active={!!current}
            Icon={current?.Icon ?? IconMore}
            short={i18n.t(current ? current.shortKey : 'nav.short.more')}
            ariaLabel={moreBadge ? i18n.t('nav.badge.inside', { label: moreLabel }) : moreLabel}
            ariaHasPopup
            ariaExpanded={moreOpen}
            badge={moreBadge ? <NavBadgeMark tabKey="more" badge="dot" /> : null}
            disabled={busy}
            onClick={() => setMoreOpen(true)}
          />
        ) : null}
      </nav>
      {more.length > 0 ? (
        <Sheet open={moreOpen} onOpenChange={setMoreOpen} title={i18n.t('nav.more')}>
          <ul className="flex flex-col pb-2" data-testid="more-nav-sheet">
            {more.map((t) => {
              const Icon = t.Icon;
              const badge = badges[t.key];
              const active = tab === t.key;
              return (
                <li key={t.key}>
                  <button
                    type="button"
                    data-testid={`nav-${t.key}`}
                    aria-current={active ? 'page' : undefined}
                    aria-label={badgeText(t) ?? undefined}
                    onClick={() => {
                      setMoreOpen(false);
                      onSelect(t.key);
                    }}
                    className={
                      'press flex min-h-12 w-full items-center gap-3 rounded-[var(--r-capsule)] px-3 text-left text-old-h3 ' +
                      (active
                        ? 'bg-[var(--c-nav-active)] font-semibold text-[var(--c-action)]'
                        : 'text-[var(--c-fg)]')
                    }
                  >
                    <Icon size={22} />
                    <span className="min-w-0 flex-1 truncate">{i18n.t(t.labelKey)}</span>
                    {badge !== undefined ? (
                      <span
                        aria-hidden
                        data-testid={`nav-badge-${t.key}`}
                        className={
                          badge === 'dot'
                            ? 'h-2.5 w-2.5 rounded-full bg-[var(--c-danger)]'
                            : 'min-w-[20px] rounded-full bg-[var(--c-danger)] px-1.5 text-center text-old-label font-semibold leading-5 text-[var(--c-danger-fg)] tabular-nums'
                        }
                      >
                        {badge === 'dot' ? null : badge > 99 ? '99+' : badge}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </Sheet>
      ) : null}
    </>
  );
}

interface NavItemProps {
  testId: string;
  active: boolean;
  Icon: TabDef['Icon'];
  short: string;
  ariaLabel: string | undefined;
  ariaHasPopup?: boolean;
  ariaExpanded?: boolean;
  badge: ReactNode;
  disabled: boolean;
  onClick: () => void;
}

/**
 * One item of the capsule: icon over its short label, the active one on a
 * filled pill. WALK-03: the item is the whole height of the capsule (48 px
 * at its lowest) and at least min(44 px, a fifth of it) wide; it grows
 * with its label, so a long ru / uz word takes room from the short ones
 * (D17) and truncates only past that.
 */
function NavItem({
  testId,
  active,
  Icon,
  short,
  ariaLabel,
  ariaHasPopup,
  ariaExpanded,
  badge,
  disabled,
  onClick,
}: NavItemProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={ariaLabel}
      aria-current={active ? 'page' : undefined}
      aria-haspopup={ariaHasPopup ? 'dialog' : undefined}
      aria-expanded={ariaHasPopup ? ariaExpanded : undefined}
      onClick={onClick}
      disabled={disabled}
      className={
        'press relative flex min-w-[min(2.75rem,20%)] flex-auto flex-col items-center justify-center gap-0.5 px-0.5 ' +
        (active ? 'text-[var(--c-action)]' : 'text-[var(--c-fg-muted)]')
      }
    >
      {active ? (
        <span
          aria-hidden
          className="absolute inset-x-0.5 inset-y-1 rounded-[var(--r-pill)] bg-[var(--c-nav-active)]"
        />
      ) : null}
      <span className="relative inline-flex">
        <Icon size={22} />
        {badge}
      </span>
      <span
        className={
          'app-nav-label relative max-w-full truncate text-old-label leading-tight' +
          (active ? ' font-semibold' : '')
        }
      >
        {short}
      </span>
    </button>
  );
}

/**
 * A count, or a dot for "not done today" / "something inside waits".
 * Review MWC-11 (modern-web-guidance: typography): the count is sized in
 * rem (10 px at the default root), so it follows the phone's text size.
 */
function NavBadgeMark({ tabKey, badge }: { tabKey: string; badge: NavBadge | undefined }) {
  if (badge === undefined) return null;
  return (
    <span
      aria-hidden
      data-testid={`nav-badge-${tabKey}`}
      className={
        badge === 'dot'
          ? 'absolute -right-1 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--c-surface)] bg-[var(--c-danger)]'
          : 'absolute -right-2.5 -top-1.5 min-w-[1.125rem] rounded-full border-2 border-[var(--c-surface)] bg-[var(--c-danger)] px-1 text-center text-[0.625rem] font-semibold leading-[0.875rem] text-[var(--c-danger-fg)] tabular-nums'
      }
    >
      {badge === 'dot' ? null : badge > 99 ? '99+' : badge}
    </span>
  );
}
