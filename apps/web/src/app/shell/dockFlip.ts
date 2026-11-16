/**
 * The dock when the page's main button comes or goes (owner 2026-11-16:
 * "the dock animation should be done properly"; modern-web-guidance
 * `motion`: "Prefer to animate opacity and transform").
 *
 * The row's layout changes in one step (the button's slot opens or
 * closes, the capsule narrows or widens); then every piece is moved back
 * to where it was and slides to its new place (FLIP): each nav item, each
 * dock tool and the button by `translate`, the capsule's surface (its
 * ::before) by translate + scaleX from its left edge, so the icons on it
 * never stretch. Compositor only: one layout for the change, none per
 * frame. Without element.animate, or under reduced motion, the change is
 * simply made.
 */
import { prefersReducedMotion } from '../../lib/reducedMotion';

export const DOCK_FLIP_MS = 240;
const EASE = 'cubic-bezier(0.2, 0.7, 0.2, 1)';
const MOVING = '.app-nav-item, .app-dock-tool, .app-main-capsule';

export function flipDock(dock: HTMLElement | null, change: () => void): void {
  if (!dock || typeof dock.animate !== 'function' || prefersReducedMotion()) {
    change();
    return;
  }
  const nav = dock.querySelector<HTMLElement>('.app-nav');
  const navBefore = nav?.getBoundingClientRect() ?? null;
  const before = new Map<HTMLElement, number>();
  dock.querySelectorAll<HTMLElement>(MOVING).forEach((el) => {
    before.set(el, el.getBoundingClientRect().left);
  });
  change();
  const timing: KeyframeAnimationOptions = { duration: DOCK_FLIP_MS, easing: EASE };
  for (const [el, left] of before) {
    if (!el.isConnected) continue;
    const dx = left - el.getBoundingClientRect().left;
    if (Math.abs(dx) < 0.5) continue;
    el.animate([{ translate: `${dx}px 0` }, { translate: '0 0' }], timing);
  }
  if (!nav || !navBefore) return;
  const after = nav.getBoundingClientRect();
  if (after.width <= 0 || navBefore.width <= 0) return;
  const dx = navBefore.left - after.left;
  const sx = navBefore.width / after.width;
  if (Math.abs(dx) < 0.5 && Math.abs(sx - 1) < 0.005) return;
  try {
    nav.animate(
      [
        { transformOrigin: '0 50%', transform: `translateX(${dx}px) scaleX(${sx})` },
        { transformOrigin: '0 50%', transform: 'none' },
      ],
      { ...timing, pseudoElement: '::before' },
    );
  } catch {
    // A browser without pseudoElement animations: the surface just moves.
  }
}
