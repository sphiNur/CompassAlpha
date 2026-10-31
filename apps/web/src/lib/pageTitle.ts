/**
 * A11Y-10 (2026-10-31): the document title said "Compass" on every screen,
 * so switching tabs or opening an admin page changed nothing a screen
 * reader (or the browser's tab list) could report. Shell sets the base
 * (the tab, the store); a drill-down page such as an admin section adds
 * its own name in front while it is open.
 */
const APP_NAME = 'Compass';

let base: string[] = [];
let sub: string | null = null;

export function pageTitle(parts: ReadonlyArray<string | null | undefined>): string {
  const named = parts.map((p) => (p ?? '').trim()).filter((p) => p.length > 0);
  return [...named, APP_NAME].join(' · ');
}

function apply(): void {
  if (typeof document === 'undefined') return;
  document.title = pageTitle([sub, ...base]);
}

export function setPageTitleBase(parts: ReadonlyArray<string | null | undefined>): void {
  base = parts.filter((p): p is string => !!p);
  apply();
}

/** Returns the function that takes the name off again. */
export function setPageTitleSub(name: string | null): () => void {
  sub = name;
  apply();
  return () => {
    if (sub === name) {
      sub = null;
      apply();
    }
  };
}
