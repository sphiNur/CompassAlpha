/**
 * 2026-10-21 FE-05: the Shell's in-page main button (Submit / Save) sits
 * between the content and the bottom nav. The toast stack is anchored
 * above the nav, so without knowing the button's height it rendered on
 * top of it. Shell publishes the height here as a CSS variable that
 * @compass/ui's ToastProvider adds to its bottom offset; 0 when no page
 * has a main button.
 *
 * 2026-11-14 (owner): the button shares the nav capsule's row, so the
 * value is what it adds ABOVE the top of the nav (mainButtonInsetOf);
 * <main> adds it to the room it keeps under its last content.
 */
export const MAIN_BUTTON_INSET_VAR = '--app-main-btn-h';

export function mainButtonInsetValue(height: number | null | undefined): string {
  if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return '0px';
  return `${Math.ceil(height)}px`;
}

export function publishMainButtonInset(
  height: number | null | undefined,
  root: {
    style: { setProperty: (name: string, value: string) => void };
  } | null = typeof document !== 'undefined' ? document.documentElement : null,
): void {
  root?.style.setProperty(MAIN_BUTTON_INSET_VAR, mainButtonInsetValue(height));
}

/**
 * How far the dock's button part reaches above the top of the nav (px):
 * nothing beside the capsule on its row, or the hint over the row when
 * shown. Without the nav, all of it down to the dock's foot (the button,
 * its gap to the bottom, and the hint when shown).
 */
export function mainButtonInsetOf(m: {
  /** The nav capsule's top, or null when there is no nav. */
  navTop: number | null;
  /** The top of the button's capsule, or of the hint over it. */
  contentTop: number;
  /** The bottom of the dock. */
  dockBottom: number;
}): number {
  if (m.navTop === null) return Math.max(0, m.dockBottom - m.contentTop);
  return Math.max(0, m.navTop - m.contentTop);
}
