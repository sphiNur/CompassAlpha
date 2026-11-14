/**
 * Runs a DOM update inside a same-document view transition (UI overhaul B,
 * 2026-11-15; modern-web-guidance: directional-navigation-transitions).
 *
 * - `update` must change the DOM synchronously (wrap a React state change
 *   in flushSync), so the new snapshot is the new page.
 * - `types` (e.g. 'forward', 'backward') select the CSS for the direction
 *   through `:active-view-transition-type()`; a browser without transition
 *   types gets the plain transition, and one without view transitions, a
 *   reduced-motion preference or a hidden page gets the update alone.
 * - `scope` is set as `data-vt` on <html> for the transition's length, so
 *   the CSS names only the elements this transition is about.
 */
import { prefersReducedMotion } from './reducedMotion';

type StartViewTransition = (arg: (() => void) | { update: () => void; types?: string[] }) => {
  finished: Promise<void>;
};

function supportsTypes(): boolean {
  const VT = (globalThis as { ViewTransition?: { prototype: object } }).ViewTransition;
  return !!VT && 'types' in VT.prototype;
}

let running = false;

export function withViewTransition(update: () => void, scope: string, types: string[] = []): void {
  const start = (document as { startViewTransition?: StartViewTransition }).startViewTransition;
  if (!start || running || document.hidden || prefersReducedMotion()) {
    update();
    return;
  }
  const root = document.documentElement;
  root.dataset.vt = scope;
  running = true;
  let transition: { finished: Promise<void> };
  try {
    transition = supportsTypes()
      ? start.call(document, { update, types })
      : start.call(document, update);
  } catch {
    delete root.dataset.vt;
    running = false;
    update();
    return;
  }
  void transition.finished.finally(() => {
    if (root.dataset.vt === scope) delete root.dataset.vt;
    running = false;
  });
}
