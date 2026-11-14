/**
 * Warms the chunks of the heavy pages this member can open, and the
 * settings sheet everyone has, once the browser is idle.
 *
 * Review COREWEB1-10 (2026-11-12): out of Shell.tsx.
 */
import { useEffect } from 'react';
import type { AuthSession } from '../../stores/authStore';
import { preloadPage, preloadSettingsSheet } from '../pageChunks';
import { browserIdleHost, prefetchInTurn } from './idlePrefetch';

export function usePagePrefetch(session: AuthSession | null): void {
  // Warm the AdminPage chunk in the background once we know the user
  // can see the tab. The `resilientLazy()` in pages.tsx splits it into a
  // separate JS chunk so non-admins never download it; `preloadPage`
  // kicks off the fetch idly so when the admin actually taps the tab,
  // React.lazy resolves synchronously instead of flashing the Suspense
  // fallback.
  //
  // Why we need this: without prefetch, the first tap-into-Admin shows
  // ~400-1000ms of spinner on slow networks, which (a) feels like a
  // stutter on Telegram WebApp, and (b) is enough to make the deep
  // smoke's 400ms post-click waitForTimeout race the chunk download.
  // We wait until the browser is idle so we don't compete with
  // first-paint work on the entry route.
  const canAdmin = !!session?.permissions.includes('users.manage') || !!session?.isPlatformAdmin;
  // M3.11: same warmup pattern for RunPage. Trigger when the user
  // can see the Run tab. Purchasers in production are a small share
  // of users, so a non-purchaser saves the 60 kB of RunPage chunk
  // entirely; purchasers get the chunk prefetched right after login.
  const canRun = !!session?.permissions.includes('run.purchase');
  // DX-PFE-2: review and receiving left the entry chunk; warm them the
  // same way for the people who have those tabs.
  const canApprove = !!session?.permissions.includes('order.approve');
  const canConfirm = !!session?.permissions.includes('delivery.confirm');
  // 2026-11-13: Order left the entry chunk. main.tsx starts it unless the
  // app reopens on another tab; then it is warmed here like the others.
  const canOrder = !!session?.permissions.includes('order.draft');
  const signedIn = session !== null;
  useEffect(() => {
    if (!signedIn) return;
    // Review MWD-04 (modern-web-guidance: schedule-tasks-by-priority): one
    // chunk at a time, once idle; without requestIdleCallback (iOS), a few
    // seconds after `load` instead of at once (idlePrefetch.ts). Each
    // failure is dropped here: the page's own import retries when the user
    // actually taps in.
    const tasks: Array<() => Promise<unknown>> = [];
    if (canAdmin) tasks.push(() => preloadPage('admin'));
    if (canRun) tasks.push(() => preloadPage('run'));
    if (canApprove) tasks.push(() => preloadPage('approve'));
    if (canConfirm) tasks.push(() => preloadPage('confirm'));
    if (canOrder) tasks.push(() => preloadPage('order'));
    tasks.push(preloadSettingsSheet);
    return prefetchInTurn(browserIdleHost(), tasks);
  }, [signedIn, canAdmin, canRun, canApprove, canConfirm, canOrder]);
}
