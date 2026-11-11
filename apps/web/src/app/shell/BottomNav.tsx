/**
 * The foot of the screen: the tab bar, or with one page or none only the
 * phone's home-indicator strip (showsNav).
 *
 * Review COREWEB1-10 (2026-11-12): out of Shell.tsx, with the badge query
 * and the nav height. COREWEB1-31: no casts, and it reads the language
 * itself instead of taking i18n as a prop.
 */
import { useEffect } from 'react';
import { useNavigationBlocked } from '../../hooks/useAppMutating';
import { useI18n } from '../../hooks/useI18n';
import { pollWhenOffline, useRealtimeLive } from '../../hooks/useRealtime';
import { useStoreContext } from '../../hooks/useStoreContext';
import { navBadges } from '../../lib/navBadges';
import { trpc } from '../../lib/trpc';
import { useAuthStore } from '../../stores/authStore';
import type { Tab } from '../../stores/navStore';
import { showsNav, type TabDef } from './tabs';

interface BottomNavProps {
  tabs: readonly TabDef[];
  tab: Tab;
  onSelect: (tab: Tab) => void;
}

export function BottomNav({ tabs, tab, onSelect }: BottomNavProps) {
  // 2026-11-05 (owner): without the bar, --app-nav-h goes to 0 so the main
  // button, toasts and empty states sit on the bottom edge instead of
  // above a gap.
  const show = showsNav(tabs);
  useEffect(() => {
    const root = document.documentElement.style;
    if (show) root.removeProperty('--app-nav-h');
    else root.setProperty('--app-nav-h', '0px');
    return () => {
      root.removeProperty('--app-nav-h');
    };
  }, [show]);
  if (!show) {
    // No nav: keep the phone's home-indicator strip clear of the page.
    return (
      <div
        aria-hidden
        className="shrink-0 bg-[var(--c-surface)]"
        style={{ height: 'var(--app-safe-bottom)' }}
      />
    );
  }
  return <TabBar tabs={tabs} tab={tab} onSelect={onSelect} />;
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
function TabBar({ tabs, tab, onSelect }: BottomNavProps) {
  const i18n = useI18n();
  // F3 (2026-10-30): only writes that swap the session lock the nav now;
  // see useNavigationBlocked.
  const busy = useNavigationBlocked();
  const badges = useNavBadges(tabs);
  return (
    <nav
      data-testid="primary-nav"
      // D17 (2026-10-31): flex, not a grid of equal columns, so a long
      // ru / uz word takes a few px from the short ones instead of ending
      // in an ellipsis. Seven tabs at 360 px: ru labels need 321 px, uz
      // 300 px. How each tab grows and shrinks: the button's class below.
      className="flex shrink-0 border-t border-[var(--c-divider)] bg-[var(--c-surface)]"
      style={{
        paddingBottom: 'var(--app-safe-bottom)',
        // COREWEB1-07: keeps the first and last tabs off a side notch.
        paddingLeft: 'var(--app-safe-left, 0px)',
        paddingRight: 'var(--app-safe-right, 0px)',
        height: 'calc(var(--app-nav-h) + var(--app-safe-bottom))',
        // M3.50: block tab switches during in-flight mutations.
        pointerEvents: busy ? 'none' : undefined,
        opacity: busy ? 0.5 : undefined,
        transition: 'opacity 120ms ease',
      }}
      aria-label={i18n.t('nav.primaryAriaLabel')}
      aria-busy={busy || undefined}
    >
      {tabs.map((t) => {
        const active = tab === t.key;
        const Icon = t.Icon;
        const label = i18n.t(t.labelKey);
        const short = i18n.t(t.shortKey);
        const badge = badges[t.key];
        // The badge is read with the name: 「审核，2 件待处理」.
        const badgeText =
          badge === undefined
            ? null
            : badge === 'dot'
              ? i18n.t('nav.badge.due', { label })
              : i18n.t('nav.badge.count', { label, n: badge });
        return (
          <button
            key={t.key}
            type="button"
            data-testid={`nav-${t.key}`}
            // The short nav word is an abbreviation in ru / uz; screen
            // readers announce the section's full name.
            aria-label={badgeText ?? (short === label ? undefined : label)}
            onClick={() => onSelect(t.key)}
            aria-current={active ? 'page' : undefined}
            disabled={busy}
            className={
              // V5: px-0.5 leaves each of seven tabs at 360 px about 47 px
              // of label room — enough for every zh and en label at 11 px.
              // 2026-11-05: flex-auto + min-w-0 — tabs share the width by
              // their label length and may shrink below it (then truncate).
              // flex-1 alone never shrank below the label, so at 320 px seven
              // ru tabs pushed the last one off screen and the page scrolled
              // sideways.
              'press flex min-w-0 flex-auto flex-col items-center justify-center gap-1 px-0.5 ' +
              (active ? 'text-[var(--c-action)]' : 'text-[var(--c-fg-muted)]')
            }
          >
            <span className="relative inline-flex">
              <Icon size={tabs.length >= 5 ? 21 : 22} />
              {badge !== undefined ? (
                <span
                  aria-hidden
                  data-testid={`nav-badge-${t.key}`}
                  className={
                    badge === 'dot'
                      ? 'absolute -right-1 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-[var(--c-surface)] bg-[var(--c-danger)]'
                      : 'absolute -right-2.5 -top-1.5 min-w-[18px] rounded-full border-2 border-[var(--c-surface)] bg-[var(--c-danger)] px-1 text-center text-[10px] font-semibold leading-[14px] text-[var(--c-danger-fg)] tabular-nums'
                  }
                >
                  {badge === 'dot' ? null : badge > 99 ? '99+' : badge}
                </span>
              ) : null}
            </span>
            {/* V5 (2026-10-30): 11 px (text-old-label), was 9 px with the
                line height equal to the size. Measured at 360 px with seven
                tabs: zh and en fit; the longest ru / uz words
                ("Согласование", "Tasdiqlash", "Kun yakuni") overflowed, so
                the nav uses the short labels (D17). `truncate` stays as a
                guard for a future label that is too long. */}
            <span
              className={
                active
                  ? 'max-w-full truncate text-old-label font-semibold leading-tight'
                  : 'max-w-full truncate text-old-label leading-tight'
              }
            >
              {short}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
