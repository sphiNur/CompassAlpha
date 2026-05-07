import { useMemo } from 'react';
import { createI18n, detectLocale, type Locale } from '@compass/i18n';
import { useAuthStore } from '../stores/authStore';

export function useI18n() {
  const locale = useAuthStore((s) => s.session?.user.locale ?? null);
  const tg = (window as { Telegram?: { WebApp?: { initDataUnsafe?: { user?: { language_code?: string } } } } }).Telegram?.WebApp;
  const fallback = tg?.initDataUnsafe?.user?.language_code ?? navigator.language;
  const resolved: Locale = (locale as Locale | null) ?? detectLocale(fallback);
  return useMemo(() => createI18n(resolved), [resolved]);
}

export function useProductName() {
  const i18n = useI18n();
  return (item: { names: Record<string, string> | null | undefined }): string => {
    const names = item.names ?? {};
    return (
      names[i18n.locale] ??
      names.en ??
      names.ru ??
      names.zh ??
      names.uz ??
      Object.values(names)[0] ??
      '—'
    );
  };
}
