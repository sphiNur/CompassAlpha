import type { Locale } from '@compass/i18n';
import { bootLocale } from './bootLocale';

/**
 * The language the app opens in, read before React and the auth store
 * have started (lib/bootLocale with this page's storage and platform
 * language). main.tsx fetches its catalog, I18nGate waits for it, and the
 * root error boundary draws in it.
 */
export function startLocale(): Locale {
  let storage: Storage | null = null;
  try {
    storage = window.localStorage;
  } catch {
    /* storage blocked */
  }
  return bootLocale(
    storage,
    window.Telegram?.WebApp?.initDataUnsafe?.user?.language_code ?? navigator.language,
  );
}
