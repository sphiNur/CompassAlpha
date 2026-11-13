/**
 * S2 (2026-11-13): opens Review on a cold start when an order waits there
 * (landingVerdict.ts decides). Its own component, so the counts it watches
 * redraw only this, never the Shell, and it unmounts once decided.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useStoreContext } from '../../hooks/useStoreContext';
import { tabFromDeepLinkPath } from '../../lib/deepLink';
import { getTg } from '../../lib/telegram';
import { trpc } from '../../lib/trpc';
import { requestTabChange, useNavStore, type Tab } from '../../stores/navStore';
import { LANDING_WINDOW_MS, landingVerdict } from './landingVerdict';

/** Decided once per page load: a Shell mounted again (another org) is not a start. */
let landingSettled = false;

/** Opened from a link that names a tab or carries a start param. */
function openedFromLink(): boolean {
  if (typeof window === 'undefined') return false;
  return !!tabFromDeepLinkPath(window.location.pathname) || !!getTg()?.initDataUnsafe?.start_param;
}

export function ReviewLanding(props: { visibleKeys: readonly Tab[]; currentTab: Tab }) {
  const [done, setDone] = useState(landingSettled);
  const finish = useCallback(() => setDone(true), []);
  if (done) return null;
  return <LandingWatch {...props} onDone={finish} />;
}

function LandingWatch({
  visibleKeys,
  currentTab,
  onDone,
}: {
  visibleKeys: readonly Tab[];
  currentTab: Tab;
  onDone: () => void;
}) {
  // Read before the Shell's link handling strips the path (its effect).
  const [deepLinked] = useState(openedFromLink);
  const [startedAt] = useState(() => Date.now());
  const acted = useRef(false);
  const storeCtx = useStoreContext();
  const oneStore = storeCtx.kind === 'specific';
  // The bottom nav's query: same input, same cache (restored on start).
  const counts = trpc.nav.counts.useQuery(oneStore ? { storeId: storeCtx.storeId } : {}, {
    enabled: oneStore && visibleKeys.includes('approve'),
    retry: false,
  });

  useEffect(() => {
    const mark = () => {
      acted.current = true;
    };
    window.addEventListener('pointerdown', mark, true);
    window.addEventListener('keydown', mark, true);
    const timer = window.setTimeout(() => {
      landingSettled = true;
      onDone();
    }, LANDING_WINDOW_MS);
    return () => {
      window.removeEventListener('pointerdown', mark, true);
      window.removeEventListener('keydown', mark, true);
      window.clearTimeout(timer);
    };
  }, [onDone]);

  const visibleKey = visibleKeys.join(',');
  const approve = counts.data?.approve;
  const updatedAt = counts.data ? counts.dataUpdatedAt : null;
  useEffect(() => {
    if (landingSettled) return;
    const now = Date.now();
    const verdict = landingVerdict({
      visibleKeys: visibleKey.split(',') as Tab[],
      currentTab,
      oneStore,
      deepLinked,
      userActed: acted.current,
      elapsedMs: now - startedAt,
      counts: updatedAt === null ? null : { approve: approve ?? null, ageMs: now - updatedAt },
    });
    if (verdict === 'wait') return;
    landingSettled = true;
    if (verdict === 'review') {
      void requestTabChange('approve').then((allowed) => {
        if (allowed && !acted.current) useNavStore.getState().setTab('approve');
      });
    }
    onDone();
  }, [visibleKey, currentTab, oneStore, deepLinked, startedAt, approve, updatedAt, onDone]);

  return null;
}
