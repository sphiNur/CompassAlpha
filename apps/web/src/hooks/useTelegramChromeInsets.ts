import { useEffect } from 'react';
import { chromeInsets } from '../lib/chromeInsets';
import { isInTelegram } from '../lib/telegram';

/**
 * Keeps the CSS variables for Telegram's buttons over the Mini App current
 * (lib/chromeInsets.ts measures them).
 *
 * M3.42 (2026-05-22): Android Telegram WebView doesn't expose
 * `env(safe-area-inset-top)` (returns 0), so the 36-px chrome reserve
 * fell short of Telegram's Close + bot title row (~56-64 px on
 * Android) and our sticky page header rendered behind it. Read the
 * accurate value from the SDK when available:
 *   1. WebApp.contentSafeAreaInset.top  (TG 8.0+) — gold standard,
 *      includes both device safe-area AND Telegram's own chrome row
 *   2. WebApp.safeAreaInset.top         (TG 8.0+) + a platform-aware
 *      chrome-row addition
 *   3. fallback to env() + the historical 36-px addition (iOS path)
 * Result is written to the CSS variable `--app-chrome-reserve` and
 * read by the reserved strip (app/shell/TopBar.tsx). Listens for
 * safeAreaChanged / contentSafeAreaChanged so we re-measure when the
 * user rotates or pulls Telegram's keyboard.
 *
 * Review COREWEB1-10 (2026-11-12): out of Shell.tsx.
 */
export function useTelegramChromeInsets(): void {
  const inTelegram = isInTelegram();
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const tg = window.Telegram?.WebApp;
    const root = document.documentElement.style;
    // 2026-07-30: the same trap TopBar.tsx's header walked into, one
    // layer down. index.html loads the SDK statically, so `tg` exists in
    // a plain browser too — platform 'unknown', empty initData, every
    // inset 0. Its presence says nothing about whether Telegram's chrome
    // is on screen, and `contentSafeAreaInset.left/right` of 0 falls
    // through to the platform-empirical defaults, so the browser build
    // padded every StickyPageBar by 56 px left / 96 px right to clear a
    // Close button and a ⋯ menu that are not there. On Order that left
    // the store chip + search + category strip boxed into the middle
    // 208 px of a 375 px viewport while the SKU rows under it ran edge
    // to edge. Outside Telegram, the Shell renders its own <header> and
    // there is no overlay chrome to clear — drop the vars so the
    // `var(--app-chrome-pad-*, 16px)` fallbacks take over.
    if (!tg || !inTelegram) {
      root.removeProperty('--app-chrome-reserve');
      root.removeProperty('--app-chrome-safe-top');
      root.removeProperty('--app-chrome-pad-left');
      root.removeProperty('--app-chrome-pad-right');
      return;
    }
    const apply = () => {
      const insets = chromeInsets(tg);
      root.setProperty('--app-chrome-safe-top', `${insets.safeTop}px`);
      // No SDK telemetry: leave the reserve to the stylesheet's env()
      // fallback (TopBar.tsx).
      if (insets.reserve === null) root.removeProperty('--app-chrome-reserve');
      else root.setProperty('--app-chrome-reserve', `${insets.reserve}px`);
      root.setProperty('--app-chrome-pad-left', `${insets.padLeft}px`);
      root.setProperty('--app-chrome-pad-right', `${insets.padRight}px`);
    };
    apply();
    // Newer Telegram clients fire these events when the user changes
    // orientation, the keyboard opens, or pulls down the chrome.
    const onEvent = tg.onEvent;
    const offEvent = tg.offEvent;
    if (onEvent && offEvent) {
      onEvent('safeAreaChanged', apply);
      onEvent('contentSafeAreaChanged', apply);
      onEvent('viewportChanged', apply);
      return () => {
        offEvent('safeAreaChanged', apply);
        offEvent('contentSafeAreaChanged', apply);
        offEvent('viewportChanged', apply);
      };
    }
    return;
  }, [inTelegram]);
}
