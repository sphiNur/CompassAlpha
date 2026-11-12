import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type Theme = 'native' | 'apple' | 'dark';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (t: Theme) => void;
  /** When `theme === 'native'`, the resolved color scheme from Telegram. */
  colorScheme: 'light' | 'dark';
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = 'compass.theme';

interface TgWebApp {
  colorScheme?: 'light' | 'dark';
  initData?: string;
  onEvent?: (name: string, cb: () => void) => void;
  offEvent?: (name: string, cb: () => void) => void;
}

/**
 * Telegram's WebApp when Telegram really hosts the page. The SDK script
 * loads in a plain browser too and then reports colorScheme 'light' by
 * default; only signed initData means Telegram (atlas SHL-4).
 */
function hostTelegram(): TgWebApp | null {
  const tg = (window as { Telegram?: { WebApp?: TgWebApp } }).Telegram?.WebApp;
  return tg?.initData && tg.colorScheme ? tg : null;
}

/**
 * The scheme to start with: Telegram's, else the phone's, as the effect
 * below finds it. COREWEB1-26 (2026-11-11): it started as 'light', and
 * the first commit wrote that over the 'dark' public/boot-guard.js had
 * set before the first paint: one light frame on a dark Telegram.
 */
function startingScheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  const tg = hostTelegram();
  if (tg?.colorScheme) return tg.colorScheme;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * The theme saved on this device, else `fallback`. Review UI-27
 * (2026-11-12): storage can throw when it is blocked or disabled (on
 * reading `localStorage` itself, or on getItem); that threw out of
 * ThemeProvider's first render, and the whole app showed its error page.
 * Exported for tests.
 */
export function savedTheme(
  storage: () => Pick<Storage, 'getItem'> | null | undefined,
  fallback: Theme,
): Theme {
  try {
    const stored = storage()?.getItem(STORAGE_KEY);
    if (stored === 'native' || stored === 'apple' || stored === 'dark') return stored;
  } catch {
    // Storage blocked: the default theme.
  }
  return fallback;
}

interface ThemeProviderProps {
  children: ReactNode;
  defaultTheme?: Theme;
  /** Called on every theme change so the host can sync (e.g. to Telegram's setHeaderColor). */
  onChange?: (theme: Theme) => void;
}

export function ThemeProvider({
  children,
  defaultTheme = 'native',
  onChange,
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(() =>
    typeof window === 'undefined'
      ? defaultTheme
      : savedTheme(() => window.localStorage, defaultTheme),
  );

  const [colorScheme, setColorScheme] = useState<'light' | 'dark'>(startingScheme);

  // Detect color scheme + listen for live changes.
  //   - Inside Telegram: pull colorScheme on mount AND subscribe to
  //     `themeChanged`. Telegram fires this when the user toggles
  //     OS dark/light without leaving the Mini App.
  //   - Outside Telegram (web preview): use the media-query listener.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const tg = hostTelegram();
    if (tg && typeof tg.onEvent === 'function') {
      const sync = () => {
        if (tg.colorScheme) setColorScheme(tg.colorScheme);
      };
      sync();
      tg.onEvent('themeChanged', sync);
      return () => {
        if (typeof tg.offEvent === 'function') tg.offEvent('themeChanged', sync);
      };
    }
    // Fallback: prefers-color-scheme.
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    setColorScheme(mq.matches ? 'dark' : 'light');
    const handler = (e: MediaQueryListEvent) => setColorScheme(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.colorScheme = colorScheme;
    onChange?.(theme);
  }, [theme, colorScheme, onChange]);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    try {
      if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not saved (storage blocked or full): it applies until a reload (UI-27).
    }
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, setTheme, colorScheme }),
    [theme, setTheme, colorScheme],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
