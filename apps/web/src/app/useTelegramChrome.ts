import { useEffect } from 'react';

/**
 * Publish where Telegram's own chrome sits, as CSS variables, so the
 * app can keep clear of it.
 *
 * Inside Telegram the WebView is overlaid by a Close button (top left)
 * and a menu (top right). `--app-chrome-reserve` is the height to leave
 * free at the top, `--app-chrome-safe-top` the device's own share of it,
 * and `--app-chrome-pad-left/right` the widths of the two overlays.
 * Outside Telegram the variables are removed and the CSS fallbacks apply.
 */
export function useTelegramChrome(inTelegram: boolean): void {
  // M3.42 (2026-05-22): Android Telegram WebView doesn't expose
  // `env(safe-area-inset-top)` (returns 0), so the 36-px chrome reserve
  // fell short of Telegram's Close + bot title row (~56-64 px on
  // Android) and our sticky page header rendered behind it. Read the
  // accurate value from the SDK when available:
  //   1. WebApp.contentSafeAreaInset.top  (TG 8.0+) — gold standard,
  //      includes both device safe-area AND Telegram's own chrome row
  //   2. WebApp.safeAreaInset.top         (TG 8.0+) + a platform-aware
  //      chrome-row addition
  //   3. fallback to env() + the historical 36-px addition (iOS path)
  // Result is written to the CSS variable `--app-chrome-reserve` and
  // read by the reserved strip below. Listens for safeAreaChanged /
  // contentSafeAreaChanged so we re-measure when the user rotates or
  // pulls Telegram's keyboard.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const tg = window.Telegram?.WebApp;
    // 2026-07-30: the same trap the header fix above walked into, one
    // layer down. index.html loads the SDK statically, so `tg` exists in
    // a plain browser too — platform 'unknown', empty initData, every
    // inset 0. Its presence says nothing about whether Telegram's chrome
    // is on screen, and `contentSafeAreaInset.left/right` of 0 falls
    // through to the platform-empirical defaults, so the browser build
    // padded every StickyPageBar by 56 px left / 96 px right to clear a
    // Close button and a ⋯ menu that are not there. On Order that left
    // the store chip + search + category strip boxed into the middle
    // 208 px of a 375 px viewport while the SKU rows under it ran edge
    // to edge. Outside Telegram, Shell renders its own <header> and
    // there is no overlay chrome to clear — drop the vars so the
    // `var(--app-chrome-pad-*, 16px)` fallbacks take over.
    if (!tg || !inTelegram) {
      const root = document.documentElement;
      root.style.removeProperty('--app-chrome-reserve');
      root.style.removeProperty('--app-chrome-safe-top');
      root.style.removeProperty('--app-chrome-pad-left');
      root.style.removeProperty('--app-chrome-pad-right');
      return;
    }
    const apply = () => {
      const platform = tg.platform ?? 'unknown';
      // M3.47 (2026-05-22): even when the SDK reports a number,
      // floor it at the platform-empirical chrome-row value.
      // contentSafeAreaInset.top has been observed to UNDER-report
      // on iOS Telegram when the floating Close button extends
      // beyond the standard chrome row. Without the floor, page
      // content (e.g. PreviewSummaryCard's "可以生成采购单"
      // CardHeader title) lands behind the close button.
      const chromeRowFloor = platform === 'android' ? 56 : platform === 'tdesktop' ? 0 : 64;
      // --- Vertical chrome reserve ---
      // 2026-07-30: publish the SDK's own safe-area top alongside the
      // reserve. The strip that holds the store title needs to know
      // which slice of `--app-chrome-reserve` is device safe-area
      // (notch / dynamic island) and which is Telegram's actual button
      // row, so it can center the title on the BUTTONS rather than on
      // the whole strip. It used to derive that from CSS
      // `--app-safe-top` — `max(env(safe-area-inset-top), 16px)` — a
      // different source of truth with a 16px floor the SDK value
      // doesn't have, so the two disagreed and the title rendered a
      // few px below the Close / ⋯ centerline.
      document.documentElement.style.setProperty(
        '--app-chrome-safe-top',
        `${tg.safeAreaInset?.top ?? 0}px`,
      );
      const contentTop = tg.contentSafeAreaInset?.top;
      if (typeof contentTop === 'number' && contentTop > 0) {
        const safeTop = tg.safeAreaInset?.top ?? 0;
        const minReserve = safeTop + chromeRowFloor;
        const reserve = Math.max(contentTop, minReserve);
        document.documentElement.style.setProperty('--app-chrome-reserve', `${reserve}px`);
      } else {
        const safeTop = tg.safeAreaInset?.top;
        // chromeRowFloor (declared above) carries the empirical
        // values: Android 56 / iOS 64 / tdesktop 0. iOS bumped from
        // M3.42's 36 to 64 because the close button is a floating
        // overlay that extends beyond the standard chrome row, and
        // the old 36-px reserve let the first-card header land
        // behind it.
        if (typeof safeTop === 'number') {
          document.documentElement.style.setProperty(
            '--app-chrome-reserve',
            `${safeTop + chromeRowFloor}px`,
          );
        } else {
          // No SDK telemetry. Fall back to env() (handled in the CSS
          // var default below) — leaves the var unset.
          document.documentElement.style.removeProperty('--app-chrome-reserve');
        }
      }
      // --- Horizontal chrome pad (M3.46, 2026-05-22) ---
      // Telegram renders a Close button at top-LEFT and a ⋯ overflow
      // menu at top-RIGHT. With M3.42 our content sits BELOW the
      // chrome row vertically, but the chrome buttons stay anchored
      // in place over their slots — and sticky page headers that
      // put content at the left/right edge still got hidden by them.
      //
      // contentSafeAreaInset.left/right gives the precise overlay
      // widths on TG 8.0+ clients; fall back to platform-empirical
      // defaults otherwise. The values land on
      // `--app-chrome-pad-left` / `--app-chrome-pad-right` so any
      // sticky strip can opt in via padding.
      const contentLeft = tg.contentSafeAreaInset?.left;
      const contentRight = tg.contentSafeAreaInset?.right;
      // Empirical: Android Close button ~56px, ⋯ overflow + menu ~96px.
      // iOS slightly smaller — but 56/96 over-pads safely; under-pads
      // are the visible bug, over-pads just shrink the title area.
      // tdesktop: no chrome — 0.
      const defaultLeft = platform === 'tdesktop' ? 0 : platform === 'android' ? 56 : 56;
      const defaultRight = platform === 'tdesktop' ? 0 : platform === 'android' ? 96 : 96;
      const padLeft =
        typeof contentLeft === 'number' && contentLeft > 0 ? contentLeft : defaultLeft;
      const padRight =
        typeof contentRight === 'number' && contentRight > 0 ? contentRight : defaultRight;
      document.documentElement.style.setProperty('--app-chrome-pad-left', `${padLeft}px`);
      document.documentElement.style.setProperty('--app-chrome-pad-right', `${padRight}px`);
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
