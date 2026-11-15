import { isInTelegram } from '../../lib/telegram';

/**
 * The top of the screen: room for what sits above the page, and nothing
 * of our own (owner, 2026-11-15: no app top bar; the store chip and the
 * settings button went). Inside Telegram it is the strip under Telegram's
 * own chrome (Close, bot title, ⋯), sized by
 * hooks/useTelegramChromeInsets.ts; settings open from Telegram's ⋯ menu
 * (useTelegramSettingsButton) and the store is switched there. In a
 * browser it is the device's safe area; settings open from More
 * (BottomNav.tsx).
 *
 * Owner 2026-11-16 ("a large part of the top is unused"): it is no longer
 * an opaque strip the page stops at. The page starts below it at rest
 * (<main>'s padding-top, `--app-top-inset`, which Shell sets from
 * topInset()), scrolls up under it, and TopVeil fades it there
 * (.app-top-veil in styles/index.css).
 *
 * 2026-07-30: `isInTelegram()` tests real initData; `!!window.Telegram` is
 * true in any browser, as index.html loads the SDK.
 */
export function topInset(): string {
  // M3.42 (2026-05-22): `--app-chrome-reserve` from Telegram's
  // contentSafeAreaInset / safeAreaInset, with the older
  // `--app-safe-top + 36px` rule where the SDK gives none.
  return isInTelegram()
    ? 'var(--app-chrome-reserve, calc(var(--app-safe-top) + 36px))'
    : 'var(--app-safe-top)';
}

/** The fade over the top inset; after <main>, so it draws over it. */
export function TopVeil() {
  return <div aria-hidden data-testid="top-strip" className="app-fade app-top-veil" />;
}
