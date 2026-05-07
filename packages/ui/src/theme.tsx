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
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof window === 'undefined') return defaultTheme;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'native' || stored === 'apple' || stored === 'dark') return stored;
    return defaultTheme;
  });

  const [colorScheme, setColorScheme] = useState<'light' | 'dark'>('light');

  // Detect color scheme + listen for live changes.
  //   - Inside Telegram: pull colorScheme on mount AND subscribe to
  //     `themeChanged`. Telegram fires this when the user toggles
  //     OS dark/light without leaving the Mini App.
  //   - Outside Telegram (web preview): use the media-query listener.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    interface TgWebApp {
      colorScheme?: 'light' | 'dark';
      onEvent?: (name: string, cb: () => void) => void;
      offEvent?: (name: string, cb: () => void) => void;
    }
    const tg = (window as { Telegram?: { WebApp?: TgWebApp } }).Telegram?.WebApp;
    if (tg?.colorScheme && typeof tg.onEvent === 'function') {
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
    if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, next);
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
