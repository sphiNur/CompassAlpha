import { useEffect, useMemo, useRef, useState } from 'react';
import { pushTelegramBackHandler } from '@compass/ui';
import { createOwnerStack, type OwnerHandle } from '../lib/ownerStack';

export interface TelegramMainButton {
  text: string;
  isVisible: boolean;
  isActive: boolean;
  show(): void;
  hide(): void;
  enable(): void;
  disable(): void;
  setText(text: string): void;
  onClick(cb: () => void): void;
  offClick(cb: () => void): void;
  setParams(params: {
    text?: string;
    color?: string;
    text_color?: string;
    is_visible?: boolean;
    is_active?: boolean;
  }): void;
}

export interface TelegramBackButton {
  isVisible: boolean;
  show(): void;
  hide(): void;
  onClick(cb: () => void): void;
  offClick(cb: () => void): void;
}

/**
 * Telegram WebApp's built-in "settings" button — a gear icon that
 * appears in the bot's overflow menu (the `⋯` next to the bot title).
 * Available since Bot API 6.10. Older Telegram clients silently no-op.
 * Per Telegram docs the button is one-per-WebApp; show/hide controls
 * its visibility globally, onClick fires for any tap.
 */
export interface TelegramSettingsButton {
  isVisible: boolean;
  show(): void;
  hide(): void;
  onClick(cb: () => void): void;
  offClick(cb: () => void): void;
}

interface TelegramWebApp {
  initData: string;
  initDataUnsafe: {
    /** Payload from https://t.me/<bot>?startapp=<payload>. */
    start_param?: string;
    user?: { id: number; first_name: string; username?: string; language_code?: string };
  };
  themeParams: Record<string, string>;
  colorScheme: 'light' | 'dark';
  viewportHeight: number;
  viewportStableHeight?: number;
  isExpanded: boolean;
  expand(): void;
  ready(): void;
  close(): void;
  MainButton: TelegramMainButton;
  BackButton: TelegramBackButton;
  /** Optional — may be undefined on older Telegram clients. */
  SettingsButton?: TelegramSettingsButton;
  HapticFeedback: {
    impactOccurred(style: 'light' | 'medium' | 'heavy'): void;
    notificationOccurred(type: 'error' | 'success' | 'warning'): void;
  };
  showAlert(message: string, cb?: () => void): void;
  showConfirm(message: string, cb: (ok: boolean) => void): void;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  /** Bot API 7.10+. */
  setBottomBarColor?: (color: string) => void;
  /** Bot API 7.7+: stop a downward swipe from minimising the Mini App. */
  disableVerticalSwipes?: () => void;
  isVersionAtLeast?: (version: string) => boolean;
  openTelegramLink(url: string): void;
  openLink(url: string, options?: { try_instant_view?: boolean }): void;
  onEvent?: (name: string, cb: () => void) => void;
  offEvent?: (name: string, cb: () => void) => void;
}

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
  // Cast to local TelegramWebApp (richer than the d.ts mirror that
  // is intentionally minimal to avoid runtime imports).
  return (window.Telegram?.WebApp as TelegramWebApp | undefined) ?? null;
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

/** Any CSS colour (the tokens are OKLCH) as #rrggbb, which Telegram needs. */
function cssColorToHex(color: string): string | null {
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((v) => (v ?? 0).toString(16).padStart(2, '0')).join('')}`;
  } catch {
    return null;
  }
}

/**
 * Paint Telegram's own header, background and bottom bar with the page's
 * background, so the frame around the app matches it in light and dark.
 */
function syncTelegramChrome(tg: TelegramWebApp): void {
  const hex = cssColorToHex(getComputedStyle(document.body).backgroundColor);
  if (!hex) return;
  const atLeast = (v: string) => tg.isVersionAtLeast?.(v) ?? false;
  if (atLeast('6.9')) tg.setHeaderColor(hex);
  if (atLeast('6.1')) tg.setBackgroundColor(hex);
  if (atLeast('7.10')) tg.setBottomBarColor?.(hex);
}

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
      const next = Math.max(320, Math.round(sdkHeight ?? browserHeight));
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
      const sync = () => requestAnimationFrame(() => syncTelegramChrome(tg));
      sync();
      themeObserver = new MutationObserver(sync);
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-color-scheme', 'data-theme', 'class', 'style'],
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

/**
 * Page-primary-action state — M3.49 (2026-05-23).
 *
 * Was: drove Telegram's native MainButton via tg.MainButton.show()/
 * setText()/onClick(). That button lives BELOW the WebView, which
 * meant our bottom nav shifted up whenever a primary action was
 * present. The user wanted the bottom nav to stay anchored to the
 * screen bottom at ALL times — non-negotiable.
 *
 * Now: usePageMainButton writes to a module-level store, and Shell.tsx
 * renders <PageMainButton /> as an in-DOM sticky bar ABOVE the nav.
 * Telegram's native MainButton stays permanently hidden (one
 * tg.MainButton.hide() in Shell on mount). The nav is now the last
 * flex child in Shell, so it owns the bottom edge regardless of
 * whether a primary action is showing.
 *
 * Trade-offs accepted:
 *   - Loses Telegram's native MainButton look. We render a styled
 *     button with the same action accent color, sized comparably.
 *   - Need to call haptic() manually on tap (existing call sites
 *     already do so on success — no behavior loss).
 *   - Button + nav now share thumb-reach space. Mitigated by the
 *     ~8px gap + bg-color contrast.
 */
interface PageMainButtonState {
  text: string;
  onClick: () => void;
  visible: boolean;
  active: boolean;
  /**
   * A11Y-2 (2026-10-31): set when the page can say why the button is
   * inactive (fields to correct). The button then stays focusable with
   * aria-disabled instead of `disabled`, and a tap runs this (the
   * settlement page jumps to the first field to fix).
   */
  onInactiveClick?: () => void;
}

let _pageMainButton: PageMainButtonState | null = null;
const _pageMainButtonListeners = new Set<() => void>();

// 2026-10-21 audit CA-34 / E-23: was a single slot (last write wins, first
// unmount clears it for everyone). Owners now stack; the top one renders.
const _pageMainButtonStack = createOwnerStack<PageMainButtonState>((top) => {
  _pageMainButton = top;
  _pageMainButtonListeners.forEach((l) => l());
});

/**
 * Subscribe React to the page-main-button state. Used by the
 * <PageMainButton /> component in Shell.tsx.
 */
export function usePageMainButtonState(): PageMainButtonState | null {
  const [, force] = useState(0);
  useEffect(() => {
    const sub = () => force((n) => n + 1);
    _pageMainButtonListeners.add(sub);
    return () => {
      _pageMainButtonListeners.delete(sub);
    };
  }, []);
  return _pageMainButton;
}

export function usePageMainButton(
  text: string,
  onClick: () => void,
  opts?: { visible?: boolean; active?: boolean; onInactiveClick?: () => void },
): void {
  // Keep the click callback in a ref so re-renders don't republish
  // state — we only republish when text/visible/active actually flip.
  const onClickRef = useRef(onClick);
  onClickRef.current = onClick;
  const onInactiveRef = useRef(opts?.onInactiveClick);
  onInactiveRef.current = opts?.onInactiveClick;
  const hasInactiveClick = !!opts?.onInactiveClick;
  const inactiveClick = useMemo(
    () => (hasInactiveClick ? () => onInactiveRef.current?.() : undefined),
    [hasInactiveClick],
  );
  const safeText = (text ?? '').trim();
  const wantVisible = opts?.visible !== false && !!safeText;
  const wantActive = opts?.active !== false;
  const stateRef = useRef<PageMainButtonState>({
    text: safeText,
    onClick: () => onClickRef.current(),
    visible: wantVisible,
    active: wantActive,
  });
  stateRef.current = {
    ...stateRef.current,
    text: safeText,
    visible: wantVisible,
    active: wantActive,
    onInactiveClick: inactiveClick,
  };
  const handleRef = useRef<OwnerHandle<PageMainButtonState> | null>(null);
  // Register once per mount so a text/visibility change never reorders
  // this owner above one that mounted later.
  useEffect(() => {
    const handle = _pageMainButtonStack.push(stateRef.current);
    handleRef.current = handle;
    return () => {
      handleRef.current = null;
      handle.release();
    };
  }, []);
  useEffect(() => {
    handleRef.current?.update({
      ...stateRef.current,
      text: safeText,
      visible: wantVisible,
      active: wantActive,
      onInactiveClick: inactiveClick,
    });
  }, [safeText, wantVisible, wantActive, inactiveClick]);
}
