/**
 * What the page's scroll does to the frame around it (owner, 2026-11-14):
 * the fade under the top bar shows once something is above, and the fade
 * over the nav goes at the end of the page. The nav capsule keeps one size
 * (owner, 2026-11-15: it used to shrink and drop its words scrolling down).
 *
 * The state is two attributes on the shell's root, read by
 * styles/index.css, so a scroll re-renders nothing.
 */
import { useLayoutEffect, useRef, type RefObject } from 'react';

function flag(el: HTMLElement, name: string, on: boolean) {
  if (on) el.setAttribute(name, '');
  else el.removeAttribute(name);
}

/**
 * `rootRef` goes on the shell's root, `onScroll` on <main>. `resetKey`
 * (the open tab) measures again for the new page.
 */
export function useScrollChrome(mainRef: RefObject<HTMLElement | null>, resetKey: unknown) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const update = (main: HTMLElement) => {
    const root = rootRef.current;
    if (!root) return;
    const top = main.scrollTop;
    const scrollable = main.scrollHeight - main.clientHeight;
    flag(root, 'data-scrolled', top > 0);
    flag(root, 'data-scroll-end', scrollable > 0 && top >= scrollable - 1);
  };
  useLayoutEffect(() => {
    if (mainRef.current) update(mainRef.current);
    // resetKey: run again for each tab (update reads only refs).
  }, [resetKey, mainRef]);
  return { rootRef, onScroll: (e: { currentTarget: HTMLElement }) => update(e.currentTarget) };
}
