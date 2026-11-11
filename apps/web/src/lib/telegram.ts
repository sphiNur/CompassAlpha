/**
 * The Telegram WebApp SDK outside React: the SDK object, whether the page
 * runs as a Mini App, haptics, and the colours of Telegram's own frame.
 * The hooks that wire the SDK into components (start-up, BackButton,
 * SettingsButton) are in hooks/useTelegram.ts.
 *
 * Review COREWEB2-14 (2026-11-11): these lived in hooks/useTelegram.ts, so
 * lib modules (confirm, fileDownload, the error toast) imported a hooks
 * file to reach the SDK.
 */

/** The SDK object; its one shape is the global in src/types/telegram.d.ts. */
type TelegramWebApp = TelegramWebAppGlobal;

/**
 * Read window.Telegram.WebApp with safe optional chaining.
 *
 * M3.18 (2026-05-16): the `(window as { Telegram?: ... })` cast was
 * duplicated across main.tsx / App.tsx / Shell.tsx / theme.tsx. The
 * global `Window.Telegram` augmentation now lives in src/types/
 * telegram.d.ts so callers can write `window.Telegram?.WebApp`
 * directly. This function remains the canonical accessor inside
 * the SDK wrapper module.
 */
export function getTg(): TelegramWebApp | null {
  if (typeof window === 'undefined') return null;
  return window.Telegram?.WebApp ?? null;
}

/**
 * Are we ACTUALLY running inside a Telegram client? (2026-07-30)
 *
 * `getTg()` above answers a different question — "is the WebApp SDK
 * object present" — and `index.html` loads telegram-web-app.js from a
 * static <script> tag, so it is TRUE in every browser. Six call sites had
 * been using it (or `!!window.Telegram`) to decide whether Telegram's
 * native chrome would render something for us, and therefore always chose
 * the "Telegram is here, it'll provide the affordance" branch:
 *
 *   - AdminPage's SectionFrame hid its in-page back chevron, so admin
 *     drill-down had NO way back outside Telegram (and the section is
 *     persisted, so a reload landed on the same page).
 *   - Shell rendered the Telegram chrome-reserve strip instead of its own
 *     header, so the app never showed a title or the org name.
 *   - Three sheets suppressed their own submit button in favour of a
 *     native MainButton that M3.49 had permanently hidden — leaving the
 *     dish editor, stocktake/wastage and the qty quick-pick with no way
 *     to confirm at all.
 *
 * `initData` is the honest signal: Telegram populates it (a signed query
 * string) only when the page is opened as a Mini App. AuthGate has been
 * using exactly this check for its dev-bypass path since M1.
 *
 * Use `getTg()` when you just want to CALL the SDK — haptics,
 * showConfirm, MainButton.hide() — where a no-op outside Telegram is
 * fine. Use this when the answer changes what we RENDER.
 */
export function isInTelegram(): boolean {
  const tg = getTg();
  return !!tg?.initData && tg.initData.length > 0;
}

/**
 * Trigger Telegram's native haptic feedback. Safe to call outside
 * Telegram (no-op). Prefer this over the raw API so we have one
 * place to throttle / mute haptics later.
 *
 * Examples:
 *   - 'light' for +/- taps, list-row presses (cheap, frequent).
 *   - 'medium' for primary actions (Submit, Approve).
 *   - 'success' for confirmation toasts.
 *   - 'error' for failure toasts.
 */
export type HapticIntent = 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error';
export function haptic(intent: HapticIntent = 'light'): void {
  const tg = getTg();
  if (!tg?.HapticFeedback) return;
  try {
    if (intent === 'success' || intent === 'warning' || intent === 'error') {
      tg.HapticFeedback.notificationOccurred(intent);
    } else {
      tg.HapticFeedback.impactOccurred(intent);
    }
  } catch {
    /* never let haptics throw past the app */
  }
}

/** One canvas for every reading (review COREWEB2-26: one was made per call). */
let colorContext: CanvasRenderingContext2D | null | undefined;

/** Any CSS colour (the tokens are OKLCH) as #rrggbb, which Telegram needs. */
export function cssColorToHex(color: string): string | null {
  try {
    colorContext ??= document
      .createElement('canvas')
      .getContext('2d', { willReadFrequently: true });
    const ctx = colorContext;
    if (!ctx) return null;
    // As on a new canvas: clear, and black when `color` does not parse.
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((v) => (v ?? 0).toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return null;
  }
}

/**
 * A painter that passes on only a colour that differs from the last one
 * (review COREWEB2-26). Exported for tests.
 */
export function onColorChange(paint: (hex: string) => void): (hex: string | null) => void {
  let last: string | null = null;
  return (hex) => {
    if (!hex || hex === last) return;
    last = hex;
    paint(hex);
  };
}

/**
 * Paint Telegram's own header, background and bottom bar with the page's
 * background, so the frame around the app matches it in light and dark.
 */
export function paintTelegramChrome(tg: TelegramWebApp, hex: string): void {
  const atLeast = (v: string) => tg.isVersionAtLeast?.(v) ?? false;
  if (atLeast('6.9')) tg.setHeaderColor(hex);
  if (atLeast('6.1')) tg.setBackgroundColor(hex);
  if (atLeast('7.10')) tg.setBottomBarColor?.(hex);
}
