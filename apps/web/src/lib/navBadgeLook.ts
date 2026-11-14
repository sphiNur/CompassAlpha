/**
 * The look of a count badge in the bottom dock: a nav tab's
 * (BottomNav.tsx) and the page main button's (PageMainButton.tsx, owner
 * 2026-11-14), so the two read alike. Where it sits is the caller's.
 * Review MWC-11 (modern-web-guidance: typography): the count is sized in
 * rem (10 px at the default root), so it follows the phone's text size.
 */
export const NAV_BADGE_COUNT_CLASS =
  'min-w-[1.125rem] rounded-full border-2 border-[var(--c-surface)] bg-[var(--c-danger)] px-1 text-center text-[0.625rem] font-semibold leading-[0.875rem] text-[var(--c-danger-fg)] tabular-nums';

/** What a count badge says: the count, or 99+. */
export function navBadgeCountText(n: number): string {
  return n > 99 ? '99+' : String(n);
}
