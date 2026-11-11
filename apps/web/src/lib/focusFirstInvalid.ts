import { scrollBehavior } from './reducedMotion';

/**
 * A11Y-2: focus the first field marked invalid inside `root` and bring it
 * into view. Returns false when there is none.
 */
export function focusFirstInvalid(root: HTMLElement | null): boolean {
  const field = root?.querySelector<HTMLElement>('[aria-invalid="true"]');
  if (!field) return false;
  field.focus({ preventScroll: true });
  field.scrollIntoView({ block: 'center', behavior: scrollBehavior() });
  return true;
}
