import { useCallback, useRef } from 'react';

/**
 * Let one tap through, then ignore repeats for `windowMs` (DLV-4 / BUY-12,
 * 2026-10-30). A double tap on a confirm button fired both taps before the
 * re-render that disables it: "start delivery" answered with a conflict
 * and the sheet stuck open, "confirm receipt" showed success and conflict
 * at once. A time window, not a pending lock, so an action that never
 * reports pending can still be tapped again a moment later.
 */
export function useTapGuard(windowMs = 700) {
  const last = useRef(0);
  return useCallback(
    <A extends unknown[]>(fn: ((...args: A) => void) | undefined) =>
      fn
        ? (...args: A) => {
            const now = Date.now();
            if (now - last.current < windowMs) return;
            last.current = now;
            fn(...args);
          }
        : undefined,
    [windowMs],
  );
}
