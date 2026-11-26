import { Suspense, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Banner, Button, EmptyState, focusAfter } from '@compass/ui';
import { PageMenuProvider, usePageMenuRegistration } from '../components/PageMenuContext';
import { resilientLazy } from '../components/resilientLazy';
import { useI18n } from '../hooks/useI18n';
import { useStoreContext } from '../hooks/useStoreContext';
import { useTelegramSettingsButton } from '../hooks/useTelegram';
import { useTelegramChromeInsets } from '../hooks/useTelegramChromeInsets';
import { setPageTitleBase } from '../lib/pageTitle';
import { useAuthStore } from '../stores/authStore';
import { importSettingsSheet } from './pageChunks';
import { PageErrorBoundary } from './PageErrorBoundary';
import { BottomNav, showsNav, useNavBadges } from './shell/BottomNav';
import { GroupSwitch } from './shell/GroupSwitch';
import { entryKeyFor, groupEntries, memberToOpen, membersAround } from './shell/tabGroups';
import type { Tab } from '../stores/navStore';
import { MoreNavContext } from './shell/moreNav';
import { LiveAnnouncer } from './shell/LiveAnnouncer';
import { navLayout } from './shell/navLayout';
import { OfflineBanner } from './shell/OfflineBanner';
import { PageMainButton } from './shell/PageMainButton';
import { setDockToolSlot } from '../lib/dockSlot';
import { PAGES } from './shell/pages';
import { ReviewLanding } from './shell/ReviewLanding';
import { useScrollChrome } from './shell/scrollChrome';
import { SkipLinks } from './shell/SkipLinks';
import { SwipePager } from './shell/SwipePager';
import { MORE_TAB, shellTabs, TABS_WITH_OWN_H1 } from './shell/tabs';
import { TopVeil, topInset } from './shell/TopBar';
import { isInTelegram } from '../lib/telegram';
import { usePagePrefetch } from './shell/usePagePrefetch';
import { useShellTab } from './shell/useShellTab';

const SettingsSheet = resilientLazy(importSettingsSheet);

/**
 * The app around the page: the top bar, the page in <main> (the one
 * scroller), the page's main button and the bottom nav.
 *
 * Review COREWEB1-10 (2026-11-12): this file held every part of it, about
 * 1,200 lines; the parts are in ./shell/ now and this only puts them
 * together.
 */
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

  // SHL-2 / CLS-5 (2026-10-30): tabs that work on one store follow what the
  // member may do in the selected store, not the union of all their stores
  // (a staff member at A and manager at B saw 审核 at A, then got "no
  // permission"; someone with 销售 rights only at B never saw 销售).
  // Cross-store pages (采购, 历史, 管理) keep the union.
  const storeCtx = useStoreContext();
  const storePerms =
    storeCtx.kind === 'specific' ? session?.storePermissions?.[storeCtx.storeId] : undefined;
  const memberTabs = shellTabs(session, storePerms);
  usePagePrefetch(session);
  // Owner, 2026-11-15: no top bar. In a browser (no Telegram ⋯ menu)
  // settings open from More, which is then always there.
  const browserSettings = !isInTelegram();
  // Owner 2026-11-17: Admin lives on the More page, never in the bar; the
  // shell's tabs are the member's pages without Admin, plus More when
  // there is one (navLayout.ts).
  // Owner 2026-11-23: ordering and receiving, and buying and its history,
  // each take one place in the bar (tabGroups.ts); the tabs stay tabs.
  const entries = groupEntries(memberTabs);
  const layout = navLayout(entries, session?.permissions ?? [], browserSettings);
  const visible = [
    ...memberTabs.filter((t) => t.key !== 'admin'),
    ...(layout.morePage ? [MORE_TAB] : []),
  ];
  const { tab, selectTab, changeTab, mainRef, saveScroll } = useShellTab(visible);
  // The bar's item for the open tab, and the group it is open in.
  const navTab = entryKeyFor(tab, entries);
  const groupMembers = membersAround(tab, entries);
  const tabBadges = useNavBadges(memberTabs);
  const lastInGroup = useRef(new Map<Tab, Tab>());
  if (groupMembers.length > 0) lastInGroup.current.set(navTab, tab);
  /** The member a group's entry opens; a lone tab is itself. */
  const openFor = (key: Tab): Tab => {
    const members = entries.find((e) => e.key === key)?.members;
    if (!members) return key;
    if (members.includes(tab)) return tab;
    return memberToOpen(members, lastInGroup.current.get(key), tabBadges);
  };
  // A tap on a bar or More entry. On the group already open it is a tap on
  // the open tab (back to its top), as on any tab.
  const selectEntry = (key: Tab) => selectTab(openFor(key));
  // 2026-11-14 (step 2): a swipe moves to the bar's neighbouring item, in
  // the order the bar draws them, More last; not to the tabs listed on the
  // More page (SwipePager.tsx).
  const hasNav = showsNav(layout);
  const swipeRing = hasNav
    ? [...layout.bar.map((t) => openFor(t.key)), ...(layout.morePage ? (['more'] as const) : [])]
    : [];
  const swipeResetKey = [
    session?.user.id,
    session?.user.locale,
    storeCtx.kind === 'specific' ? storeCtx.storeId : storeCtx.kind,
  ].join('|');
  // Review MWB-14 (modern-web-guidance: stack-drill-down): "make sure focus
  // ends up inside the active view after every active-view change". A tap
  // keeps focus on the nav button; a swipe unmounts the page that held it,
  // and focus fell to <body>. It goes to <main> then (focusAfter acts only
  // if focus was lost; <main> draws no ring).
  const swipeTab = async (next: Parameters<typeof changeTab>[0]) => {
    const allowed = await changeTab(next);
    if (allowed) focusAfter('#main-content');
    return allowed;
  };
  // 2026-11-14: the fades and the nav capsule's size follow <main>'s scroll.
  const scrollChrome = useScrollChrome(mainRef, tab);

  // A11Y-10 (2026-10-31): the document title names the page and the store
  // ("下单 · Central Kitchen · Compass"); it used to be "Compass" on every
  // screen. Pages without a visible heading get a hidden <h1> below.
  const activeTabDef = visible.find((t) => t.key === tab);
  const tabLabel = activeTabDef ? i18n.t(activeTabDef.labelKey) : null;
  const titleStoreName =
    storeCtx.kind === 'specific'
      ? (session?.stores.find((st) => st.id === storeCtx.storeId)?.name ?? null)
      : null;
  useEffect(() => {
    setPageTitleBase([tabLabel, titleStoreName]);
  }, [tabLabel, titleStoreName]);

  // The settings sheet: profile, language, about, and the page's own menu
  // (M1.6, 2026-05-06). Telegram's gear in the bot's ⋯ menu opens it, and
  // so does the top bar: inside Telegram its ⋮ button, left of Telegram's
  // ⋯ (UX-09, 2026-11-14); in a browser, the button with the org name.
  // It loads on the first open (pageChunks.ts) and then stays mounted, so
  // it closes with its animation.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const openSettings = () => {
    setSettingsLoaded(true);
    setSettingsOpen(true);
  };
  useTelegramSettingsButton(openSettings);
  useTelegramChromeInsets();

  return (
    <div
      ref={scrollChrome.rootRef}
      // relative: the nav capsule floats over the page (BottomNav.tsx).
      className="relative flex min-h-0 flex-col bg-[var(--c-bg)]"
      style={
        {
          height: 'var(--app-viewport-h, 100dvh)',
          // Owner 2026-11-16: the room at the top the page starts below
          // and scrolls under (app/shell/TopBar.tsx).
          '--app-top-inset': topInset(),
        } as CSSProperties
      }
    >
      <SkipLinks hasNav={hasNav} />
      {settingsLoaded ? (
        <Suspense fallback={null}>
          <SettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} pageMenu={pageMenu} />
        </Suspense>
      ) : null}
      <LiveAnnouncer />
      {/* 2026-11-14: the page fades where it scrolls under the top of the
          screen and the nav capsule (.app-fade in styles/index.css). */}
      <SwipePager
        ring={swipeRing}
        tab={tab}
        mainRef={mainRef}
        onSwipe={swipeTab}
        resetKey={swipeResetKey}
      >
        <main
          ref={mainRef}
          id="main-content"
          // DX-IX-3 / DX-IX-4: where focus lands when the element that had it
          // is gone (a sheet's opener removed by its action). Focusable from
          // script only; no ring, it is the page itself.
          tabIndex={-1}
          data-focus-fallback=""
          onScroll={(e) => {
            saveScroll(e);
            scrollChrome.onScroll(e);
          }}
          // app-main: room under the last content for the nav capsule.
          className="app-main min-h-0 flex-1 overflow-y-auto outline-none"
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
            // Sideways drags are the pager's (SwipePager.tsx); the browser
            // keeps vertical scrolling and pinch zoom.
            touchAction: 'pan-y pinch-zoom',
            // COREWEB1-07: a phone on its side puts the notch and rounded
            // corners over the left and right; pages add their px-4 inside.
            paddingLeft: 'var(--app-safe-left, 0px)',
            paddingRight: 'var(--app-safe-right, 0px)',
          }}
        >
          <OfflineBanner />
          {session?.subscription && !session.subscription.writeAccess ? (
            <div className="px-4 pt-3">
              <Banner tone="warn" title={i18n.t('subscription.readOnlyTitle')}>
                {i18n.t('subscription.readOnlyBody')}
              </Banner>
            </div>
          ) : null}
          {/* The More page with Admin on it has Admin's <h1> (one per page). */}
          {tabLabel && !TABS_WITH_OWN_H1.has(tab) && !(tab === 'more' && layout.admin) ? (
            <h1 className="sr-only">{tabLabel}</h1>
          ) : null}
          {/* SHL-3 (2026-10-30): a member whose roles open no tab got an
            empty bar over the order page. */}
          {visible.length > 0 ? (
            <PageErrorBoundary
              key={tab}
              // Review COREWEB1-23 (2026-11-11): an error is a danger
              // Banner with retry, as DataState draws one (UI-15), not the
              // empty-list look.
              fallback={(retry) => (
                <div className="px-4 pt-3">
                  <Banner
                    tone="danger"
                    title={i18n.t('shell.pageError.title')}
                    action={
                      <Button size="sm" variant="secondary" onClick={retry}>
                        {i18n.t('common.retry')}
                      </Button>
                    }
                  >
                    {i18n.t('shell.pageError.body')}
                  </Banner>
                </div>
              )}
            >
              <MoreNavContext.Provider
                value={{
                  tabs: layout.more,
                  admin: layout.admin,
                  onSelect: selectEntry,
                  onOpenSettings: browserSettings ? openSettings : undefined,
                }}
              >
                {groupMembers.length > 1 ? (
                  <GroupSwitch
                    members={groupMembers.flatMap((k) => memberTabs.filter((t) => t.key === k))}
                    tab={tab}
                    badges={tabBadges}
                    onSelect={selectTab}
                  />
                ) : null}
                {PAGES[tab]()}
              </MoreNavContext.Provider>
            </PageErrorBoundary>
          ) : (
            <EmptyState
              title={i18n.t('shell.noTabs.title')}
              description={i18n.t('shell.noTabs.body')}
            />
          )}
        </main>
        <TopVeil />
        {hasNav ? <div aria-hidden className="app-fade app-fade-bottom" /> : null}
      </SwipePager>

      {/* M3.49 (2026-05-23): in-page primary action button. Telegram's
          native MainButton lives BELOW the WebView, so it pushed the
          bottom nav up whenever a page set a primary action. The user
          explicitly requested the bottom nav stay anchored at all times.
          Driven by the same usePageMainButton hook every page already
          uses. 2026-11-14 (owner): the nav capsule and the button float
          in one dock, on one row, the button a circle (.app-dock in
          styles/index.css); the nav comes first for Tab. Outside the
          pager, so a swipe never starts on either. */}
      <div className="app-dock" data-nav={hasNav ? '' : undefined}>
        <div className="app-dock-row">
          <BottomNav layout={layout} tab={navTab} onSelect={selectEntry} />
          {/* UI overhaul C/D (2026-11-15): a page's search or view switch,
              drawn here through a portal (components/dock). */}
          <div ref={setDockToolSlot} className="app-dock-slot" />
          <PageMainButton />
        </div>
      </div>
      <ReviewLanding visibleKeys={visible.map((t) => t.key)} currentTab={tab} />
    </div>
  );
}
