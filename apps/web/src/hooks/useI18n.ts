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
  // M3.10 (2026-05-16): memoize the callback by locale so passing
  // `productName` as a prop into a React.memo-wrapped row component
  // doesn't bust referential equality on every parent render. The
  // returned function depends only on i18n.locale; if the user
  // doesn't switch locale mid-session it's the same reference for
  // the lifetime of the component, and React.memo can short-circuit
  // 187 SKU rows down to just the one whose qty actually changed.
  return useMemo(
    () =>
      (item: { names: Record<string, string> | null | undefined }): string => {
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
      },
    [i18n.locale],
  );
}
