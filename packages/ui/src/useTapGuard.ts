import { useCallback, useRef } from 'react';

/**
 * The decision behind every double-tap guard, kept free of React so it
 * can be tested: `allow(key, now)` lets the first tap of an action
 * through and refuses repeats of the SAME key for `windowMs` after it.
 */
export function createTapGuard(windowMs: number) {
  let last = { key: '', at: Number.NEGATIVE_INFINITY };
  return {
    allow(key: string, now: number): boolean {
      if (last.key === key && now - last.at < windowMs) return false;
      last = { key, at: now };
      return true;
    },
  };
}

/**
 * Let one tap through, then ignore repeats of the SAME action for
 * `windowMs` (DLV-4 / BUY-12, 2026-10-30). A double tap on a confirm
 * button fired both taps before the re-render that disables it: "start
 * delivery" answered with a conflict and the sheet stuck open, "confirm
 * receipt" showed success and conflict at once.
 *
 * `key` names the action (the button's label): a shared button that has
 * meanwhile become a different action — the page's main button on the
 * next page — is not a repeat. A time window, not a pending lock, so an
 * action that never reports pending can still be tapped again.
 */
export function useTapGuard(windowMs = 700) {
  const guard = useRef<ReturnType<typeof createTapGuard> | null>(null);
  guard.current ??= createTapGuard(windowMs);
  return useCallback(
    <A extends unknown[]>(fn: ((...args: A) => void) | undefined, key = '') =>
      fn
        ? (...args: A) => {
            if (!guard.current!.allow(key, Date.now())) return;
            fn(...args);
          }
        : undefined,
    [],
  );
}
