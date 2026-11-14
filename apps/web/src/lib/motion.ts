/**
 * Scripted motion for things CSS cannot see coming (UI overhaul B part 2,
 * 2026-11-15; modern-web-guidance: motion, animate-element-entry-exit).
 * Opacity and translate only, then a short height collapse so the rows
 * below slide up instead of jumping. Nothing moves under reduced motion,
 * and every helper resolves at once when it cannot animate.
 */
import { prefersReducedMotion } from './reducedMotion';

const EASE_OUT = 'cubic-bezier(0.2, 0.7, 0.2, 1)';
const EASE_IN = 'cubic-bezier(0.4, 0, 1, 1)';

function canAnimate(el: Element | null | undefined): el is HTMLElement {
  return !!el && typeof (el as HTMLElement).animate === 'function' && !prefersReducedMotion();
}

/**
 * A list item that is about to leave (an order approved or rejected):
 * slides out to the side and folds its height, then stays folded until
 * the list re-renders without it. `gap` is the list's gap in px, folded
 * with it.
 */
export async function leaveListItem(el: Element | null | undefined, gap = 8): Promise<void> {
  if (!canAnimate(el)) return;
  const height = el.offsetHeight;
  try {
    await el.animate(
      [
        { opacity: 1, translate: '0 0' },
        { opacity: 0, translate: '-24px 0' },
      ],
      { duration: 160, easing: EASE_IN, fill: 'forwards' },
    ).finished;
    el.style.overflow = 'hidden';
    await el.animate(
      [
        { height: `${height}px`, marginBottom: '0px' },
        { height: '0px', marginBottom: `${-gap}px` },
      ],
      { duration: 180, easing: EASE_OUT, fill: 'forwards' },
    ).finished;
  } catch {
    /* cancelled (the item re-rendered): nothing to wait for */
  }
}

/** Put back an item whose leave did not happen (the request failed). */
export function restoreListItem(el: Element | null | undefined): void {
  if (!el) return;
  for (const a of (el as HTMLElement).getAnimations?.() ?? []) a.cancel();
  (el as HTMLElement).style.overflow = '';
}

/**
 * A drill-down level just drawn: slides in from the side it came from
 * ('enter' from the right, 'return' from the left).
 */
export function enterLevel(el: Element | null | undefined, direction: 'enter' | 'return'): void {
  if (!canAnimate(el)) return;
  const from = direction === 'enter' ? '24px 0' : '-24px 0';
  el.animate(
    [
      { opacity: 0, translate: from },
      { opacity: 1, translate: '0 0' },
    ],
    { duration: 240, easing: EASE_OUT },
  );
}
