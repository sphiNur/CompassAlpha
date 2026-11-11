/**
 * The open tab, and switching it: a nav tap, a link, a permission lost.
 * Each tab keeps its scroll position in <main>.
 *
 * Review COREWEB1-10 (2026-11-12): out of Shell.tsx.
 */
import { useEffect, useLayoutEffect, useRef, type UIEvent } from 'react';
import { scrollBehavior } from '../../lib/reducedMotion';
import { createTabScrollMemory, restoreScroll } from '../../lib/tabScroll';
import { requestTabChange, resolveVisibleTab, useNavStore, type Tab } from '../../stores/navStore';
import type { TabDef } from './tabs';
import { useDeepLinkTab } from './useDeepLinkTab';

export function useShellTab(visible: readonly TabDef[]) {
  // M3.16-B (2026-05-16): tab state lives in navStore (persisted to
  // localStorage). On hydration, resolve the persisted tab against
  // the currently-visible tab set so a lost permission doesn't strand
  // the user on a blank page.
  const persistedTab = useNavStore((s) => s.tab);
  const setPersistedTab = useNavStore((s) => s.setTab);
  const visibleKeys = visible.map((t) => t.key);
  const tab = resolveVisibleTab(persistedTab, visibleKeys);
  // DX-SHL-10 (2026-11-01): <main> is the one scroller; each tab's
  // position is recorded as it scrolls and put back when the tab returns.
  const mainRef = useRef<HTMLElement | null>(null);
  const scrollMemory = useRef(createTabScrollMemory<Tab>()).current;
  const tabRef = useRef(tab);
  useLayoutEffect(() => {
    tabRef.current = tab;
    const main = mainRef.current;
    if (!main) return;
    const stop = restoreScroll(main, scrollMemory.get(tab));
    // The person's own scroll wins over a restore still waiting for rows.
    const events = ['wheel', 'touchstart', 'keydown'] as const;
    events.forEach((type) => main.addEventListener(type, stop, { passive: true, once: true }));
    return () => {
      stop();
      events.forEach((type) => main.removeEventListener(type, stop));
    };
  }, [tab, scrollMemory]);
  const saveScroll = (e: UIEvent<HTMLElement>) =>
    scrollMemory.save(tabRef.current, e.currentTarget.scrollTop);
  const selectTab = (nextTab: Tab) => {
    // DX-SHL-10: tapping the tab you are on goes back to its top.
    if (nextTab === tab) {
      // Walkthrough F15 (2026-11-05): inside an admin page, tapping 管理
      // again goes back to the admin menu, as tab bars do elsewhere.
      if (tab === 'admin' && useNavStore.getState().adminSection !== 'home') {
        useNavStore.getState().resetAdminDrillDown();
        return;
      }
      mainRef.current?.scrollTo({ top: 0, behavior: scrollBehavior() });
      return;
    }
    void requestTabChange(nextTab).then((allowed) => {
      if (allowed) setPersistedTab(nextTab);
    });
  };
  useDeepLinkTab(visibleKeys, setPersistedTab);
  // If the resolved tab differs from what's persisted (permission
  // lost since last session), write the corrected value back so we
  // don't keep re-resolving on every render.
  useEffect(() => {
    if (tab !== persistedTab) setPersistedTab(tab);
  }, [tab, persistedTab, setPersistedTab]);
  return { tab, selectTab, mainRef, saveScroll };
}
