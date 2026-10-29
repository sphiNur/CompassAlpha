import { useCallback, useRef } from 'react';

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
  const last = useRef<{ key: string; at: number }>({ key: '', at: 0 });
  return useCallback(
    <A extends unknown[]>(fn: ((...args: A) => void) | undefined, key = '') =>
      fn
        ? (...args: A) => {
            const now = Date.now();
            if (last.current.key === key && now - last.current.at < windowMs) return;
            last.current = { key, at: now };
            fn(...args);
          }
        : undefined,
    [windowMs],
  );
}
