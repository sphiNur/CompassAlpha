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
 * slides out to the side, then its space closes. It is inert from the
 * start, so its buttons leave the tab order while they fade, and it stays
 * collapsed until the list re-renders without it; when the list still
 * shows it (the refresh failed), `restoreListItem` puts it back.
 *
 * modern-web-guidance `motion` (review 2026-11-15): "Prefer to animate
 * opacity and transform". The space no longer closes by animating the
 * item's height (layout on every frame): the item collapses at once and
 * the rows below slide up from where they were (FLIP, translate only).
 * `gap` is the list's gap in px, closed with it.
 */
export async function leaveListItem(el: Element | null | undefined, gap = 8): Promise<void> {
  if (!el) return;
  const item = el as HTMLElement;
  item.inert = true;
  if (!canAnimate(item)) return;
  try {
    await item.animate(
      [
        { opacity: 1, translate: '0 0' },
        { opacity: 0, translate: '-24px 0' },
      ],
      { duration: 160, easing: EASE_IN, fill: 'forwards' },
    ).finished;
  } catch {
    /* cancelled (the item re-rendered): nothing to wait for */
    return;
  }
  const below: HTMLElement[] = [];
  for (let n = item.nextElementSibling; n; n = n.nextElementSibling) below.push(n as HTMLElement);
  const before = below.map((n) => n.getBoundingClientRect().top);
  item.style.height = '0px';
  item.style.overflow = 'hidden';
  item.style.marginBottom = `${-gap}px`;
  const moves = below.map((n, i) => {
    const dy = before[i]! - n.getBoundingClientRect().top;
    return dy
      ? n.animate([{ translate: `0 ${dy}px` }, { translate: '0 0' }], {
          duration: 180,
          easing: EASE_OUT,
        }).finished
      : Promise.resolve();
  });
  await Promise.allSettled(moves);
}

/**
 * Put back an item whose leave did not happen (the request or the refresh
 * failed, or the list still has it): visible, sized and focusable again.
 */
export function restoreListItem(el: Element | null | undefined): void {
  if (!el) return;
  const item = el as HTMLElement;
  for (const a of item.getAnimations?.() ?? []) a.cancel();
  item.style.height = '';
  item.style.overflow = '';
  item.style.marginBottom = '';
  item.inert = false;
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
