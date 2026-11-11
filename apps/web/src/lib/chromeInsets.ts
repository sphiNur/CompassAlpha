/**
 * Where Telegram's own buttons sit over the Mini App, in px, from what its
 * SDK reports. hooks/useTelegramChromeInsets.ts writes these to CSS
 * variables; the strip under the buttons (app/shell/TopBar.tsx) and the
 * sticky page bars read them.
 *
 * Review COREWEB1-10 (2026-11-12): out of Shell.tsx, so it can be tested.
 */

export interface ChromeInsets {
  /** `--app-chrome-safe-top`: the device's safe area alone (notch, island). */
  safeTop: number;
  /**
   * `--app-chrome-reserve`: the safe area and Telegram's button row. Null
   * when the SDK reports no inset; the stylesheet's fallback applies then.
   */
  reserve: number | null;
  /** `--app-chrome-pad-left`: Telegram's Close button. */
  padLeft: number;
  /** `--app-chrome-pad-right`: Telegram's ⋯ menu. */
  padRight: number;
}

export type ChromeReport = Pick<
  TelegramWebAppGlobal,
  'platform' | 'safeAreaInset' | 'contentSafeAreaInset'
>;

export function chromeInsets(tg: ChromeReport): ChromeInsets {
  const platform = tg.platform ?? 'unknown';
  // M3.47 (2026-05-22): even when the SDK reports a number,
  // floor it at the platform-empirical chrome-row value.
  // contentSafeAreaInset.top has been observed to UNDER-report
  // on iOS Telegram when the floating Close button extends
  // beyond the standard chrome row. Without the floor, page
  // content (e.g. PreviewSummaryCard's "可以生成采购单"
  // CardHeader title) lands behind the close button.
  //
  // The floors: Android 56 / iOS 64 / tdesktop 0. iOS went from M3.42's
  // 36 to 64 because the close button is a floating overlay that extends
  // beyond the standard chrome row, and the old 36-px reserve let the
  // first-card header land behind it.
  const chromeRowFloor = platform === 'android' ? 56 : platform === 'tdesktop' ? 0 : 64;
  // 2026-07-30: the SDK's own safe-area top is published alongside the
  // reserve. The strip that holds the store title needs to know which
  // slice of `--app-chrome-reserve` is device safe-area (notch / dynamic
  // island) and which is Telegram's actual button row, so it can center
  // the title on the BUTTONS rather than on the whole strip. It used to
  // derive that from CSS `--app-safe-top` — `max(env(safe-area-inset-top),
  // 16px)` — a different source of truth with a 16px floor the SDK value
  // doesn't have, so the two disagreed and the title rendered a few px
  // below the Close / ⋯ centerline.
  const safeTop = tg.safeAreaInset?.top;
  const contentTop = tg.contentSafeAreaInset?.top;
  let reserve: number | null = null;
  if (typeof contentTop === 'number' && contentTop > 0) {
    reserve = Math.max(contentTop, (safeTop ?? 0) + chromeRowFloor);
  } else if (typeof safeTop === 'number') {
    reserve = safeTop + chromeRowFloor;
  }
  // M3.46 (2026-05-22): Telegram renders a Close button at top-LEFT and a
  // ⋯ overflow menu at top-RIGHT. With M3.42 our content sits BELOW the
  // chrome row vertically, but the chrome buttons stay anchored in place
  // over their slots — and sticky page headers that put content at the
  // left/right edge still got hidden by them.
  //
  // contentSafeAreaInset.left/right gives the precise overlay widths on
  // TG 8.0+ clients; fall back to platform-empirical defaults otherwise.
  // Empirical: Android Close button ~56px, ⋯ overflow + menu ~96px. iOS
  // slightly smaller — but 56/96 over-pads safely; under-pads are the
  // visible bug, over-pads just shrink the title area. tdesktop: no
  // chrome — 0. Review COREWEB1-27 (2026-11-12): one default for every
  // other platform; an Android branch gave the same numbers.
  const contentLeft = tg.contentSafeAreaInset?.left;
  const contentRight = tg.contentSafeAreaInset?.right;
  const defaultLeft = platform === 'tdesktop' ? 0 : 56;
  const defaultRight = platform === 'tdesktop' ? 0 : 96;
  return {
    safeTop: safeTop ?? 0,
    reserve,
    padLeft: typeof contentLeft === 'number' && contentLeft > 0 ? contentLeft : defaultLeft,
    padRight: typeof contentRight === 'number' && contentRight > 0 ? contentRight : defaultRight,
  };
}
