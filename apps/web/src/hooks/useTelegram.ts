import { useEffect, useRef } from 'react';

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
 * Drive Telegram's MainButton from React without the flicker that the
 * naive useEffect approach produced.
 *
 * The bug we used to have: every dependency change re-ran the effect,
 * the cleanup called `button.hide()`, and the re-run called
 * `button.show()` again. iOS Telegram animates show/hide with a brief
 * slide — so on every qty +/- tap (which changes `text`), the user
 * saw the button "pop out" and slide back in. Looked broken.
 *
 * Fix: separate the bind-once side-effects (onClick handler, mount/
 * unmount) from the per-render updates (text, active, visible). We
 * only call setText when the text actually changed; show/hide only
 * when visibility actually flipped; enable/disable only on edge.
 * Click handler is bound ONCE to a ref-tracked callback so the
 * onClick identity stays stable across renders.
 */
export function usePageMainButton(
  text: string,
  onClick: () => void,
  opts?: { visible?: boolean; active?: boolean },
): void {
  const onClickRef = useRef(onClick);
  onClickRef.current = onClick;
  const lastTextRef = useRef<string | null>(null);
  const lastVisibleRef = useRef<boolean | null>(null);
  const lastActiveRef = useRef<boolean | null>(null);

  // Bind the click handler ONCE. The actual callback lives behind a
  // ref so React state changes don't require re-binding (which would
  // cause Telegram to deregister + reregister the listener — itself
  // sometimes a visible blip on iOS).
  useEffect(() => {
    const tg = getTg();
    if (!tg) return;
    const handler = () => onClickRef.current();
    tg.MainButton.onClick(handler);
    return () => {
      tg.MainButton.offClick(handler);
    };
  }, []);

  // Per-render updates. ONLY call the imperative API methods when the
  // value actually changes. Telegram's setText / show / hide each
  // trigger a native UI update on iOS; calling them on every React
  // render produces visible animation jitter even when nothing changed.
  useEffect(() => {
    const tg = getTg();
    if (!tg) return;
    const button = tg.MainButton;
    const wantVisible = opts?.visible !== false;
    const wantActive = opts?.active !== false;
    const safeText = (text ?? '').trim();

    // Empty text → hide. Telegram throws WebAppBottomButtonParamInvalid
    // if you try to setText('') on a visible button.
    if (!wantVisible || !safeText) {
      if (lastVisibleRef.current !== false) {
        button.hide();
        lastVisibleRef.current = false;
      }
      return;
    }

    if (lastTextRef.current !== safeText) {
      button.setText(safeText);
      lastTextRef.current = safeText;
    }
    if (lastActiveRef.current !== wantActive) {
      if (wantActive) button.enable();
      else button.disable();
      lastActiveRef.current = wantActive;
    }
    if (lastVisibleRef.current !== true) {
      button.show();
      lastVisibleRef.current = true;
    }
  }, [text, opts?.visible, opts?.active]);

  // Only hide on UNMOUNT, not on every dep change. The previous code's
  // cleanup ran on every text change because it lived on the same
  // effect. Splitting these out fixes the flicker.
  useEffect(() => {
    return () => {
      const tg = getTg();
      if (!tg) return;
      tg.MainButton.hide();
      lastVisibleRef.current = false;
      lastTextRef.current = null;
      lastActiveRef.current = null;
    };
  }, []);
}
