/**
 * A display choice kept in this browser: a view, a price unit. Review
 * RUNWEB1-21 (2026-11-12): each screen wrapped localStorage itself, and
 * the purchase preview's view did not, so where storage is blocked (some
 * WebViews and private modes throw on any access) the card failed to
 * draw. There, a choice simply lasts until the page closes.
 */

/** The saved value, or null when there is none or storage is blocked. */
export function readLocalPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Saves the value; does nothing where storage is blocked or full. */
export function writeLocalPref(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* not kept: the choice lasts until the page closes */
  }
}
