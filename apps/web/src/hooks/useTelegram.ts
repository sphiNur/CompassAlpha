import { useEffect, useRef, useState } from 'react';

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
  setParams(params: { text?: string; color?: string; text_color?: string; is_visible?: boolean; is_active?: boolean }): void;
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
  initDataUnsafe: { user?: { id: number; first_name: string; username?: string; language_code?: string } };
  themeParams: Record<string, string>;
  colorScheme: 'light' | 'dark';
  viewportHeight: number;
  isExpanded: boolean;
  expand(): void;
  ready(): void;
  close(): void;
  MainButton: TelegramMainButton;
  BackButton: TelegramBackButton;
  /** Optional — may be undefined on older Telegram clients. */
  SettingsButton?: TelegramSettingsButton;
  HapticFeedback: { impactOccurred(style: 'light' | 'medium' | 'heavy'): void; notificationOccurred(type: 'error' | 'success' | 'warning'): void };
  showAlert(message: string, cb?: () => void): void;
  showConfirm(message: string, cb: (ok: boolean) => void): void;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  openTelegramLink(url: string): void;
  openLink(url: string, options?: { try_instant_view?: boolean }): void;
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

export function useTelegramInit(): void {
  useEffect(() => {
    const tg = getTg();
    if (!tg) return;
    tg.ready();
    tg.expand();
    // Safe-area insets are set in tokens.css via CSS env() with sensible
    // floors. The earlier JS shim that looked at a non-existent
    // `--telegram-safe-top` always resolved to 0, making iOS Telegram
    // clip our sticky header. Removed.
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
    const tg = getTg();
    if (!tg) return;
    const handler = () => cbRef.current();
    tg.BackButton.onClick(handler);
    tg.BackButton.show();
    return () => {
      tg.BackButton.offClick(handler);
      tg.BackButton.hide();
    };
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
export function useTelegramSettingsButton(
  onClick: () => void,
  enabled = true,
): void {
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
}

let _pageMainButton: PageMainButtonState | null = null;
const _pageMainButtonListeners = new Set<() => void>();

function _setPageMainButton(s: PageMainButtonState | null): void {
  _pageMainButton = s;
  _pageMainButtonListeners.forEach((l) => l());
}

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
  opts?: { visible?: boolean; active?: boolean },
): void {
  // Keep the click callback in a ref so re-renders don't republish
  // state — we only republish when text/visible/active actually flip.
  const onClickRef = useRef(onClick);
  onClickRef.current = onClick;
  const safeText = (text ?? '').trim();
  const wantVisible = opts?.visible !== false && !!safeText;
  const wantActive = opts?.active !== false;
  useEffect(() => {
    _setPageMainButton({
      text: safeText,
      onClick: () => onClickRef.current(),
      visible: wantVisible,
      active: wantActive,
    });
    return () => _setPageMainButton(null);
  }, [safeText, wantVisible, wantActive]);
}
