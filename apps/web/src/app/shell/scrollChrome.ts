/**
 * What the page's scroll does to the frame around it (owner, 2026-11-14):
 * the fade under the top bar shows once something is above, the fade over
 * the nav goes at the end of the page, and the nav capsule shrinks while
 * the person scrolls down and returns when they scroll up or reach the top.
 *
 * The state is three attributes on the shell's root, read by
 * styles/index.css, so a scroll re-renders nothing.
 */
import { useLayoutEffect, useRef, type RefObject } from 'react';

/** How far (px) a scroll must go in one direction to change the capsule. */
export const COMPACT_STEP_PX = 8;
/** Pages with less to scroll than this (px) keep the full capsule. */
export const COMPACT_MIN_SCROLL_PX = 120;

export interface ScrollSample {
  top: number;
  /** scrollHeight − clientHeight. */
  scrollable: number;
}

/**
 * The capsule's next state and the scroll position it was decided at.
 * Small moves add up from the last decision, so a slow drag still counts.
 */
export function nextCompact(
  prev: { compact: boolean; anchor: number },
  sample: ScrollSample,
  reducedMotion: boolean,
): { compact: boolean; anchor: number } {
  if (reducedMotion || sample.top <= 0 || sample.scrollable < COMPACT_MIN_SCROLL_PX) {
    return { compact: false, anchor: Math.max(0, sample.top) };
  }
  const delta = sample.top - prev.anchor;
  if (delta >= COMPACT_STEP_PX) return { compact: true, anchor: sample.top };
  if (delta <= -COMPACT_STEP_PX) return { compact: false, anchor: sample.top };
  return prev;
}

function flag(el: HTMLElement, name: string, on: boolean) {
  if (on) el.setAttribute(name, '');
  else el.removeAttribute(name);
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * `rootRef` goes on the shell's root, `onScroll` on <main>. `resetKey`
 * (the open tab) puts the capsule back to full size.
 */
export function useScrollChrome(mainRef: RefObject<HTMLElement | null>, resetKey: unknown) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const state = useRef({ compact: false, anchor: 0 });
  const update = (main: HTMLElement) => {
    const root = rootRef.current;
    if (!root) return;
    const top = main.scrollTop;
    const scrollable = main.scrollHeight - main.clientHeight;
    flag(root, 'data-scrolled', top > 0);
    flag(root, 'data-scroll-end', scrollable > 0 && top >= scrollable - 1);
    state.current = nextCompact(state.current, { top, scrollable }, prefersReducedMotion());
    flag(root, 'data-nav-compact', state.current.compact);
  };
  useLayoutEffect(() => {
    state.current = { compact: false, anchor: 0 };
    const root = rootRef.current;
    if (root) flag(root, 'data-nav-compact', false);
    if (mainRef.current) update(mainRef.current);
    // resetKey: run again for each tab (update reads only refs).
  }, [resetKey, mainRef]);
  return { rootRef, onScroll: (e: { currentTarget: HTMLElement }) => update(e.currentTarget) };
}
