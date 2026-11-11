/**
 * Opens the tab a link names.
 *
 * Review COREWEB1-10 (2026-11-12): out of Shell.tsx.
 */
import { useEffect } from 'react';
import {
  resolveDeepLinkTab,
  storeFromDeepLinkSearch,
  stripDeepLinkPath,
  stripStoreParam,
  tabFromDeepLinkPath,
  tabFromStartParam,
} from '../../lib/deepLink';
import { requestStoreChange } from '../../lib/storeContext';
import { getTg } from '../../lib/telegram';
import { useAuthStore } from '../../stores/authStore';
import { isTab, requestTabChange, useNavStore, type Tab } from '../../stores/navStore';
import { visibleTabsFor } from './tabs';

/**
 * 2026-10-21 audit CA-15 / E-04: notification buttons open
 * FRONTEND_URL + '/approve' | '/order' | '/run' | '/confirm'. The Shell
 * only mounts behind AuthGate, so the visible tabs are known here. Switch
 * through the same guard as a nav tap (an unsaved draft can veto), then
 * drop the segment from the URL (search/hash kept) so a reload doesn't
 * re-apply it. A tab the user can't see is ignored.
 */
export function useDeepLinkTab(visibleKeys: readonly Tab[], setTab: (tab: Tab) => void): void {
  // The effect follows the set of tabs, not each render's new array.
  const visibleKey = visibleKeys.join(',');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const { pathname, search, hash } = window.location;
    const visible = visibleKey.split(',').filter(isTab);
    if (!tabFromDeepLinkPath(pathname)) {
      // A bot link `startapp=tab_<name>` (atlas SHL-6). Telegram keeps the
      // same start_param for a reload, so apply it once per launch.
      const startParam = getTg()?.initDataUnsafe?.start_param;
      const linked = tabFromStartParam(startParam);
      if (!linked || !visible.includes(linked)) return;
      try {
        const seenKey = 'compass.startParamTab';
        if (window.sessionStorage.getItem(seenKey) === startParam) return;
        window.sessionStorage.setItem(seenKey, startParam ?? '');
      } catch {
        /* no storage: apply it anyway */
      }
      if (linked === useNavStore.getState().tab) return;
      void requestTabChange(linked).then((allowed) => {
        if (allowed) setTab(linked);
      });
      return;
    }
    // DX-APR-7 (2026-11-01): the link may name the store it is about.
    const linkedStore = storeFromDeepLinkSearch(search);
    try {
      window.history.replaceState(
        window.history.state,
        '',
        `${stripDeepLinkPath(pathname)}${stripStoreParam(search)}${hash}`,
      );
    } catch {
      /* the tab switch below still applies */
    }
    void (async () => {
      const auth = useAuthStore.getState();
      if (
        linkedStore &&
        linkedStore !== auth.currentStoreId &&
        auth.session?.stores.some((st) => st.id === linkedStore) &&
        (await requestStoreChange(linkedStore))
      ) {
        auth.setCurrentStore(linkedStore);
      }
      // COREWEB1-05: once in the linked store, the tab is judged by what
      // the member may do there. A staff member at A who manages B, sent
      // `/approve?store=B` while at A, was moved to B but left on A's tab.
      const now = useAuthStore.getState();
      const keys =
        linkedStore && now.currentStoreId === linkedStore && now.session
          ? visibleTabsFor(
              now.session.permissions,
              now.session.storePermissions?.[linkedStore],
              !!now.session.isPlatformAdmin,
            ).map((t) => t.key)
          : visible;
      const target = resolveDeepLinkTab(pathname, keys);
      if (!target || target === useNavStore.getState().tab) return;
      if (await requestTabChange(target)) setTab(target);
    })();
  }, [visibleKey, setTab]);
}
