/**
 * The hooks that wire the Telegram WebApp SDK into components: start-up
 * (viewport height, swipes, frame colours), the BackButton and the
 * SettingsButton. The SDK itself (getTg, isInTelegram, haptic) is in
 * lib/telegram.ts (review COREWEB2-14).
 */
import { useEffect, useRef } from 'react';
import { pushTelegramBackHandler } from '@compass/ui';
import {
  cssColorToHex,
  getTg,
  isInTelegram,
  onColorChange,
  paintTelegramChrome,
} from '../lib/telegram';

/** Below this a measured viewport height is taken for a glitch. */
const MIN_VIEWPORT_PX = 200;

export function useTelegramInit(): void {
  useEffect(() => {
    const tg = getTg();
    const applyViewportHeight = () => {
      const sdkHeight =
        typeof tg?.viewportStableHeight === 'number' && tg.viewportStableHeight > 0
          ? tg.viewportStableHeight
          : typeof tg?.viewportHeight === 'number' && tg.viewportHeight > 0
            ? tg.viewportHeight
            : null;
      const browserHeight =
        typeof window.visualViewport?.height === 'number'
          ? window.visualViewport.height
          : window.innerHeight;
      // Review COREWEB2-27 (2026-11-12): the floor only stops a passing
      // nonsense value from collapsing the layout. At 320 it lifted real
      // heights: a phone on its side has about 280-310 px under Telegram's
      // header, and with <html> not scrolling, the bottom nav and main
      // button were cut off.
      const next = Math.max(MIN_VIEWPORT_PX, Math.round(sdkHeight ?? browserHeight));
      document.documentElement.style.setProperty('--app-viewport-h', `${next}px`);
    };

    tg?.ready();
    tg?.expand();
    applyViewportHeight();

    // Inside Telegram only (a plain browser also loads the SDK): a downward
    // swipe at the top of a long list must scroll, not minimise the app,
    // and Telegram's frame takes the page colour, again on theme changes.
    let themeObserver: MutationObserver | null = null;
    if (tg && isInTelegram()) {
      if (tg.isVersionAtLeast?.('7.7')) tg.disableVerticalSwipes?.();
      const paint = onColorChange((hex) => paintTelegramChrome(tg, hex));
      const sync = () =>
        requestAnimationFrame(() =>
          paint(cssColorToHex(getComputedStyle(document.body).backgroundColor)),
        );
      sync();
      themeObserver = new MutationObserver(sync);
      // The theme is ThemeProvider's data-theme and data-color-scheme.
      // Review COREWEB2-26: not `style`, which takes the viewport's CSS
      // variables on every resize, keyboard and drag; each one used to
      // send Telegram the same colours three times.
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-color-scheme', 'data-theme', 'class'],
      });
    }

    window.addEventListener('resize', applyViewportHeight);
    window.visualViewport?.addEventListener('resize', applyViewportHeight);
    if (tg?.onEvent && tg.offEvent) {
      tg.onEvent('viewportChanged', applyViewportHeight);
      return () => {
        themeObserver?.disconnect();
        window.removeEventListener('resize', applyViewportHeight);
        window.visualViewport?.removeEventListener('resize', applyViewportHeight);
        tg.offEvent?.('viewportChanged', applyViewportHeight);
      };
    }
    return () => {
      themeObserver?.disconnect();
      window.removeEventListener('resize', applyViewportHeight);
      window.visualViewport?.removeEventListener('resize', applyViewportHeight);
    };
  }, []);
}

/**
 * Wire Telegram's BackButton to a React callback.
 *
 * - Mount: BackButton.show() and registers the click handler.
 * - Unmount: hide() and remove handler.
 * - Outside Telegram: no-op (web preview just doesn't show the back arrow).
 *
 * Use this in any sub-page that has a "back" semantic — admin section
 * detail views, sheets that swallow a navigation depth, etc. The
 * Telegram top-left arrow is the single source of truth for going
 * back; in-page chevron buttons can be removed once this is wired.
 */
export function useTelegramBackButton(onBack: () => void, enabled = true): void {
  const cbRef = useRef(onBack);
  cbRef.current = onBack;
  useEffect(() => {
    if (!enabled) return;
    // 2026-10-21 audit CA-34 / E-23: register on the shared owner stack
    // (also used by every Sheet) instead of show()/hide() directly — the
    // last registrant owns the button and unmount restores the previous
    // owner rather than hiding it for everyone.
    return pushTelegramBackHandler(() => cbRef.current());
  }, [enabled]);
}

/**
 * Wire Telegram's app-level SettingsButton (gear in the bot's overflow
 * menu) to a React callback (added 2026-05-05).
 *
 * Why this matters: the language picker used to live as a 🌐 button
 * stuck in the OrderPage header. The user noted that's the wrong
 * location — language is a settings-grade concern, not a per-page
 * action. Telegram already has a slot for this: `SettingsButton`
 * appears as a gear icon in the bot's `⋯` overflow menu, available
 * to ALL users on every page without consuming layout space.
 *
 * Falls back gracefully on older Telegram clients (button is
 * `undefined` — we just no-op). The Admin → Organization screen
 * also exposes a Language row so admins on the web preview without
 * Telegram chrome still have a way in.
 */
export function useTelegramSettingsButton(onClick: () => void, enabled = true): void {
  const cbRef = useRef(onClick);
  cbRef.current = onClick;
  useEffect(() => {
    if (!enabled) return;
    const tg = getTg();
    const btn = tg?.SettingsButton;
    if (!btn) return; // Older Telegram or web preview — silent no-op.
    const handler = () => cbRef.current();
    btn.onClick(handler);
    btn.show();
    return () => {
      btn.offClick(handler);
      btn.hide();
    };
  }, [enabled]);
}
