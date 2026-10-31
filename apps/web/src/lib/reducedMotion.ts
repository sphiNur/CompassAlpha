/**
 * A11Y-8 (2026-10-31): `scrollIntoView({ behavior: 'smooth' })` ignores
 * the system's "reduce motion" setting; CSS transitions here already
 * follow it (tokens.css zeroes the durations). Scripted scrolls ask this.
 */
export function scrollBehavior(
  matchMedia: ((query: string) => { matches: boolean }) | undefined = typeof window !==
  'undefined'
    ? window.matchMedia?.bind(window)
    : undefined,
): ScrollBehavior {
  return matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}
