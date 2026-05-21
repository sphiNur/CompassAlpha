/**
 * Global Window.Telegram typing (M3.18, launch hardening 2026-05-16).
 *
 * Earlier, every call site that needed window.Telegram.WebApp carried
 * its own ad-hoc cast such as
 *     (window as { Telegram?: { WebApp?: ... } }).Telegram?.WebApp
 * which (a) duplicated the type literal across 4+ files, (b) drifted
 * between files (some had themeChanged, others did not), and (c)
 * required readers to mentally reassemble the same shape every time.
 *
 * Declaring the interface globally here lets call sites write the
 * direct window.Telegram?.WebApp and TypeScript picks the right type.
 *
 * The canonical shape lives in apps/web/src/hooks/useTelegram.ts as
 * TelegramWebApp. We re-declare a minimal-but-compatible shape here
 * so this file stays a true ambient declaration (no runtime imports).
 * Hooks that need the full typed interface should still call getTg()
 * from useTelegram.ts.
 *
 * The trailing 'export {}' turns this file into a module, which is
 * required for the 'declare global' block to be additive instead of
 * shadowing the existing lib.dom Window.
 */

declare global {
  interface TelegramMainButtonGlobal {
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

  interface TelegramBackButtonGlobal {
    isVisible: boolean;
    show(): void;
    hide(): void;
    onClick(cb: () => void): void;
    offClick(cb: () => void): void;
  }

  interface TelegramSettingsButtonGlobal {
    isVisible: boolean;
    show(): void;
    hide(): void;
    onClick(cb: () => void): void;
    offClick(cb: () => void): void;
  }

  interface TelegramSafeAreaInset {
    top: number;
    bottom: number;
    left: number;
    right: number;
  }

  interface TelegramWebAppGlobal {
    initData: string;
    initDataUnsafe: {
      user?: {
        id: number;
        first_name: string;
        username?: string;
        language_code?: string;
      };
    };
    themeParams: Record<string, string>;
    colorScheme: 'light' | 'dark';
    viewportHeight: number;
    /**
     * M3.42 (2026-05-22): viewport height when settled (not mid-resize).
     * Used as a stable measure for layout calculations.
     */
    viewportStableHeight?: number;
    /**
     * M3.42: platform string from Telegram. Known values: 'android',
     * 'ios', 'tdesktop', 'macos', 'unknown', 'unigram', 'weba'.
     * Drives the Android-specific chrome-reserve override since
     * `env(safe-area-inset-top)` returns 0 on Android Telegram WebView.
     */
    platform?: string;
    /**
     * M3.42: Telegram WebApp 8.0+ device safe-area inset (status bar /
     * notch). Available on newer clients; may be undefined on
     * older versions — code MUST fall back to env() / platform default.
     */
    safeAreaInset?: TelegramSafeAreaInset;
    /**
     * M3.42: Telegram WebApp 8.0+ "content" safe-area inset (includes
     * Telegram's own chrome — close button + bot title row). When
     * available this is THE most accurate value to push our page
     * content below; we layer it on top of safeAreaInset.top.
     */
    contentSafeAreaInset?: TelegramSafeAreaInset;
    isExpanded: boolean;
    expand(): void;
    ready(): void;
    close(): void;
    MainButton: TelegramMainButtonGlobal;
    BackButton: TelegramBackButtonGlobal;
    SettingsButton?: TelegramSettingsButtonGlobal;
    HapticFeedback: {
      impactOccurred(style: 'light' | 'medium' | 'heavy'): void;
      notificationOccurred(type: 'error' | 'success' | 'warning'): void;
    };
    onEvent?(name: string, cb: () => void): void;
    offEvent?(name: string, cb: () => void): void;
    showAlert(message: string, cb?: () => void): void;
    showConfirm(message: string, cb: (ok: boolean) => void): void;
    setHeaderColor(color: string): void;
    setBackgroundColor(color: string): void;
    openTelegramLink(url: string): void;
    openLink(url: string, options?: { try_instant_view?: boolean }): void;
  }

  interface Window {
    Telegram?: { WebApp?: TelegramWebAppGlobal };
  }
}

export {};
