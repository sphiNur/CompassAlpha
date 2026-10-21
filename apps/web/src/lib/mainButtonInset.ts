/**
 * 2026-10-21 FE-05: the Shell's in-page main button (Submit / Save) sits
 * between the content and the bottom nav. The toast stack is anchored
 * above the nav, so without knowing the button's height it rendered on
 * top of it. Shell publishes the height here as a CSS variable that
 * @compass/ui's ToastProvider adds to its bottom offset; 0 when no page
 * has a main button.
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
