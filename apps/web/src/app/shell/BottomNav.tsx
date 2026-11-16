/**
 * The foot of the screen: the tab bar, or with one page or none nothing
 * (showsNav; <main> then keeps the phone's home-indicator strip clear).
 *
 * Review COREWEB1-10 (2026-11-12): out of Shell.tsx, with the badge query
 * and the nav height. COREWEB1-31: no casts, and it reads the language
 * itself instead of taking i18n as a prop.
 *
 * Owner, 2026-11-14: a capsule floating over the page (`.app-nav` in
 * styles/index.css); on a page with a main button it shares a row with it
 * (Shell.tsx's dock). Owner 2026-11-17: up to five tabs + More
 * (navLayout.ts); More is a page (MorePage.tsx) with the tabs the bar has
 * no room for, Settings in a browser, and Admin. The items keep their
 * places; only the open one shows its word, on its pill, the others are
 * icons, and a switch slides them to their new places (FLIP, translate
 * only).
 */
import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { IconMore } from '@compass/ui';
import { useNavigationBlocked } from '../../hooks/useAppMutating';
import { useI18n } from '../../hooks/useI18n';
import { pollWhenOffline, useRealtimeLive } from '../../hooks/useRealtime';
import { useStoreContext } from '../../hooks/useStoreContext';
import { navBadges, type NavBadge } from '../../lib/navBadges';
import { trpc } from '../../lib/trpc';
import { useAuthStore } from '../../stores/authStore';
import type { Tab } from '../../stores/navStore';
import { NAV_BADGE_COUNT_CLASS, navBadgeCountText } from '../../lib/navBadgeLook';
import { prefersReducedMotion } from '../../lib/reducedMotion';
import { DOCK_FLIP_MS } from './dockFlip';
import type { NavLayout } from './navLayout';
import type { TabDef } from './tabs';

interface BottomNavProps {
  /** The bar and the More page (navLayout.ts), worked out by the shell. */
  layout: NavLayout<TabDef>;
  tab: Tab;
  onSelect: (tab: Tab) => void;
}

/** Whether there is a bar: one page or none has nothing to switch to. */
export function showsNav(layout: NavLayout<TabDef>): boolean {
  return layout.bar.length + (layout.morePage ? 1 : 0) > 1;
}

export function BottomNav({ layout, tab, onSelect }: BottomNavProps) {
  // 2026-11-05 (owner): without the bar, --app-nav-h goes to 0 so the main
  // button, toasts and empty states sit on the bottom edge instead of
  // above a gap. 2026-11-14: and the capsule's float gap with it, so the
  // room <main> keeps (--app-nav-reserve) is the home-indicator strip.
  const show = showsNav(layout);
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
  return <TabBar layout={layout} tab={tab} onSelect={onSelect} />;
}

/**
 * DX-SHL-23 / DX-APR-5 / DX-DLV-13 (2026-11-01): badges on the tabs where
 * something waits for this person (requirement 03 §2.4): orders to
 * review, orders to buy, goods to receive, today's close not filed. One
 * small query for the store in the header; realtime invalidates it with
 * the order / run pushes, and it polls only while realtime is down. The
 * More page reads the same query (one request, shared).
 */
export function useNavBadges(tabs: readonly TabDef[]) {
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

const EASE = 'cubic-bezier(0.2, 0.7, 0.2, 1)';

/**
 * Owner 2026-11-17: when the open tab changes, the items widen or narrow
 * (only the open one shows its word); each slides from where it was
 * instead of jumping. The places are read while rendering the new tab
 * (the DOM still shows the old one) and the slide starts after commit.
 */
function useItemSlide(navRef: RefObject<HTMLElement | null>, tab: Tab) {
  const shownTab = useRef(tab);
  const before = useRef<Map<string, number> | null>(null);
  if (shownTab.current !== tab && before.current === null && navRef.current) {
    const map = new Map<string, number>();
    navRef.current.querySelectorAll<HTMLElement>('.app-nav-item').forEach((el) => {
      map.set(el.dataset.testid ?? '', el.getBoundingClientRect().left);
    });
    before.current = map;
  }
  useLayoutEffect(() => {
    const was = before.current;
    before.current = null;
    shownTab.current = tab;
    const nav = navRef.current;
    if (!was || !nav || typeof nav.animate !== 'function' || prefersReducedMotion()) return;
    nav.querySelectorAll<HTMLElement>('.app-nav-item').forEach((el) => {
      const from = was.get(el.dataset.testid ?? '');
      if (from === undefined) return;
      const dx = from - el.getBoundingClientRect().left;
      if (Math.abs(dx) < 0.5) return;
      el.animate([{ translate: `${dx}px 0` }, { translate: '0 0' }], {
        duration: DOCK_FLIP_MS,
        easing: EASE,
      });
    });
  }, [tab, navRef]);
}

/**
 * M3.50 (2026-05-23): the nav goes grey and inert while a write that
 * swaps the session is in flight (F3 2026-10-30, useNavigationBlocked),
 * so a tap cannot land on a page that missed the result.
 */
function TabBar({ layout, tab, onSelect }: BottomNavProps) {
  const i18n = useI18n();
  const busy = useNavigationBlocked();
  const { bar, more, admin, morePage } = layout;
  const badges = useNavBadges(admin ? [...bar, ...more, admin] : [...bar, ...more]);
  const navRef = useRef<HTMLElement | null>(null);
  useItemSlide(navRef, tab);
  // A tab opened from the More page: the More item stands for it.
  const current = more.find((t) => t.key === tab);
  const moreActive = tab === 'more' || !!current;
  const moreBadge =
    more.some((t) => badges[t.key] !== undefined) || (!!admin && badges.admin !== undefined);
  /** `label` with the tab's badge said after it; null when the tab has no badge. */
  const badgeText = (t: TabDef, label = i18n.t(t.labelKey)): string | null => {
    const badge = badges[t.key];
    if (badge === undefined) return null;
    return badge === 'dot'
      ? i18n.t('nav.badge.due', { label })
      : i18n.t('nav.badge.count', { label, n: badge });
  };
  // WCAG 2.5.3 (label in name): a button's accessible name starts with the
  // word it shows. The short nav word (ru "Ещё", "Закрытие") is not always
  // the start of the full name, so the full name follows it.
  const startWithWord = (short: string, full: string): string =>
    full.toLocaleLowerCase().startsWith(short.toLocaleLowerCase())
      ? full
      : i18n.t('common.textThenDetail', { text: short, detail: full });
  const moreLabel = current
    ? i18n.t('nav.moreCurrentAria', { label: i18n.t(current.labelKey) })
    : i18n.t('nav.moreAria');
  const moreShort = i18n.t(current ? current.shortKey : 'nav.short.more');
  const moreName = startWithWord(moreShort, moreLabel);
  return (
    <nav
      ref={navRef}
      data-testid="primary-nav"
      className="app-nav"
      style={{
        pointerEvents: busy ? 'none' : undefined,
        opacity: busy ? 0.5 : undefined,
      }}
      aria-label={i18n.t('nav.primaryAriaLabel')}
      aria-busy={busy || undefined}
    >
      {bar.map((t) => {
        const label = i18n.t(t.labelKey);
        const short = i18n.t(t.shortKey);
        const name = startWithWord(short, label);
        return (
          <NavItem
            key={t.key}
            testId={`nav-${t.key}`}
            active={tab === t.key}
            Icon={t.Icon}
            short={short}
            // Review MWC-03: always named; the icon is aria-hidden and only
            // the open item shows its word.
            ariaLabel={badgeText(t, name) ?? name}
            badge={<NavBadgeMark tabKey={t.key} badge={badges[t.key]} />}
            disabled={busy}
            onClick={() => onSelect(t.key)}
          />
        );
      })}
      {morePage ? (
        <NavItem
          testId="nav-more"
          active={moreActive}
          Icon={current?.Icon ?? IconMore}
          short={moreShort}
          ariaLabel={moreBadge ? i18n.t('nav.badge.inside', { label: moreName }) : moreName}
          badge={moreBadge ? <NavBadgeMark tabKey="more" badge="dot" /> : null}
          disabled={busy}
          onClick={() => onSelect('more')}
        />
      ) : null}
    </nav>
  );
}

interface NavItemProps {
  testId: string;
  active: boolean;
  Icon: TabDef['Icon'];
  short: string;
  ariaLabel: string | undefined;
  badge: ReactNode;
  disabled: boolean;
  onClick: () => void;
}

/**
 * One item of the capsule. Owner 2026-11-17: the open one is a pill with
 * its icon and word side by side; the others are icons, sharing the rest
 * of the capsule. WALK-03: every item is the capsule's height and at
 * least 44 px wide.
 */
function NavItem({
  testId,
  active,
  Icon,
  short,
  ariaLabel,
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
      onClick={onClick}
      disabled={disabled}
      className={
        'app-nav-item press relative flex min-w-11 items-center justify-center ' +
        (active
          ? 'max-w-[45%] flex-none gap-1.5 px-3 text-[var(--c-action)]'
          : 'flex-1 px-0.5 text-[var(--c-fg-muted)]')
      }
    >
      {active ? (
        <span
          aria-hidden
          className="app-nav-active absolute inset-x-0.5 inset-y-1 rounded-[var(--r-pill)] bg-[var(--c-nav-active)]"
        />
      ) : null}
      <span className="app-nav-icon relative inline-flex">
        <Icon size={22} />
        {badge}
      </span>
      {active ? (
        <span className="app-nav-label relative min-w-0 truncate text-old-label font-semibold leading-tight">
          {short}
        </span>
      ) : null}
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
          : `absolute -right-2.5 -top-1.5 ${NAV_BADGE_COUNT_CLASS}`
      }
    >
      {badge === 'dot' ? null : navBadgeCountText(badge)}
    </span>
  );
}
