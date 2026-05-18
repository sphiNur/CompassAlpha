import { useEffect, useMemo, useState } from 'react';
import {
  createI18n,
  detectLocale,
  isLoaded,
  loadCatalog,
  type Locale,
} from '@compass/i18n';
import { useAuthStore } from '../stores/authStore';

/**
 * Module-level "loaded locales" version counter. Incremented every
 * time a dynamic catalog import resolves. useI18n subscribes via a
 * useState below and re-renders so the new strings flow through.
 *
 * Why this instead of useSyncExternalStore: the surface is tiny
 * (single Set of subscribers) and we want to keep @compass/i18n
 * framework-agnostic. The hook lives in apps/web because the
 * re-render mechanism is React-specific.
 */
const subs = new Set<() => void>();
function notifyLoaded(): void {
  for (const cb of subs) cb();
}

/**
 * Ensure the given locale's catalog is loaded; trigger a re-render
 * when it lands. No-op if already loaded.
 *
 * Until the load resolves, lookup() returns undefined for keys not
 * in the en fallback, and `format()` falls through to the raw key.
 * The user sees English copy for the ~1-frame load window.
 */
function useEnsureLocale(locale: Locale): void {
  // Versioned re-render trigger.
  const [, force] = useState(0);
  useEffect(() => {
    const sub = () => force((n) => n + 1);
    subs.add(sub);
    return () => {
      subs.delete(sub);
    };
  }, []);

  useEffect(() => {
    if (isLoaded(locale)) return;
    let cancelled = false;
    void loadCatalog(locale).then(() => {
      if (cancelled) return;
      notifyLoaded();
    });
    return () => {
      cancelled = true;
    };
  }, [locale]);
}

export function useI18n() {
  const locale = useAuthStore((s) => s.session?.user.locale ?? null);
  // M3.18: window.Telegram is globally typed via src/types/telegram.d.ts.
  const fallback =
    window.Telegram?.WebApp?.initDataUnsafe?.user?.language_code ?? navigator.language;
  const resolved: Locale = (locale as Locale | null) ?? detectLocale(fallback);
  useEnsureLocale(resolved);
  return useMemo(() => createI18n(resolved), [resolved]);
}

/**
 * Hook for localized unit labels (M3.34, 2026-05-19).
 *
 * Backend stores unit as a short canonical string per the SKU schema
 * (kg / g / L / ml / pcs / pack / pair / bunch / roll). The user
 * pointed out that "kg" / "pcs" / "bunch" displayed verbatim doesn't
 * read like the rest of a Chinese/Russian/Uzbek UI. This hook returns
 * a `(unit) => label` function that maps the canonical string to its
 * localized form via i18n key `unit.<canonical>`. Falls back to the
 * raw unit string if a key is missing or the unit is empty (extras
 * may carry exotic free-text units pre-M3.34).
 */
export function useUnitLabel() {
  const i18n = useI18n();
  return useMemo(() => {
    return (unit: string | null | undefined): string => {
      if (!unit) return '';
      const canonical = unit.toLowerCase();
      // i18n.t falls back to the key itself when missing; we want to
      // fall back to the original unit string (with original case)
      // so SKU-level lowercase fix doesn't hide non-canonical units.
      const key = ('unit.' + canonical) as Parameters<typeof i18n.t>[0];
      const localized = i18n.t(key);
      return localized === key ? unit : localized;
    };
  }, [i18n]);
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
