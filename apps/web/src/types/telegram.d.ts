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
 * This is the one shape of the SDK in apps/web. Review COREWEB2-13
 * (2026-11): useTelegram.ts, fileDownload.ts and the two attendance
 * helpers each kept their own copy, every copy had fields the others
 * lacked, and `as` casts hid the difference. Add a field here, never a
 * local type. (packages/ui cannot see this file and keeps the few fields
 * it reads in telegramBackStack.ts and theme.tsx.)
 *
 * Fields marked with a Bot API version are missing on older clients:
 * check `isVersionAtLeast` before calling them.
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

  /** Bot API 8.0. */
  interface TelegramLocationData {
    latitude: number;
    longitude: number;
    horizontal_accuracy?: number | null;
  }

  /** Bot API 8.0. */
  interface TelegramLocationManagerGlobal {
    isInited: boolean;
    isLocationAvailable: boolean;
    isAccessRequested: boolean;
    isAccessGranted: boolean;
    init(cb?: () => void): void;
    getLocation(cb: (data: TelegramLocationData | null) => void): void;
    openSettings(): void;
  }

  /** Bot API 9.0. Callbacks are node-style: (error, value). */
  interface TelegramDeviceStorageGlobal {
    getItem(key: string, cb: (err: unknown, value?: string | null) => void): void;
    setItem(key: string, value: string, cb?: (err: unknown, ok?: boolean) => void): void;
  }

  interface TelegramWebAppGlobal {
    initData: string;
    initDataUnsafe: {
      /** Payload from https://t.me/<bot>?startapp=<payload>. */
      start_param?: string;
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
    /** Bot API 7.10. */
    setBottomBarColor?(color: string): void;
    /** Bot API 7.7: stop a downward swipe from minimising the Mini App. */
    disableVerticalSwipes?(): void;
    isVersionAtLeast?(version: string): boolean;
    openTelegramLink(url: string): void;
    openLink(url: string, options?: { try_instant_view?: boolean }): void;
    /** Bot API 8.0: Telegram's own download dialog. */
    downloadFile?(params: { url: string; file_name: string }, cb?: (ok: boolean) => void): void;
    /** Bot API 8.0. */
    LocationManager?: TelegramLocationManagerGlobal;
    /** Bot API 9.0. */
    DeviceStorage?: TelegramDeviceStorageGlobal;
  }

  interface Window {
    Telegram?: { WebApp?: TelegramWebAppGlobal };
  }
}

export {};
