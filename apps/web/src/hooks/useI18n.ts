import { useEffect, useMemo, useState } from 'react';
import {
  createI18n,
  detectLocale,
  isLoaded,
  loadCatalog,
  type Locale,
} from '@compass/i18n';
import { useAuthStore } from '../stores/authStore';

const VALID_LOCALES = ['en', 'zh', 'ru', 'uz'] as const;
function asLocale(v: string | null | undefined): Locale | null {
  return v && (VALID_LOCALES as readonly string[]).includes(v) ? (v as Locale) : null;
}

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

/**
 * Pick the best available name from a multi-locale SKU, with a
 * documented fallback chain. Pure — no React state involved — so it
 * can be reused by the bilingual hook below + by tests.
 */
function pickName(
  names: Record<string, string> | null | undefined,
  locale: string,
): string {
  const n = names ?? {};
  return (
    n[locale] ??
    n.en ??
    n.ru ??
    n.zh ??
    n.uz ??
    Object.values(n)[0] ??
    '—'
  );
}

export function useProductName() {
  const i18n = useI18n();
  // M3.45 (2026-05-22): bilingual display. When the user has set a
  // secondary locale (Settings → "市场摊位语言"), product names
  // render as "Primary (Secondary)" so a Chinese-speaking operator
  // can cross-reference what they're looking at against what the
  // Uzbek-speaking vendor will see in the copy-paste message. Null
  // secondaryLocale (default) keeps the legacy single-language
  // behavior — invisible to users who don't opt in.
  //
  // The dedup guard (primary === secondary) covers two cases:
  //   1. User chose the same locale for primary + secondary (no-op).
  //   2. The SKU's secondary-locale name is identical to the primary
  //      (e.g. a SKU only typed in English).
  const secondaryLocale = useAuthStore((s) => s.session?.user.secondaryLocale ?? null);
  // M3.10 (2026-05-16): memoize the callback by locale so passing
  // `productName` as a prop into a React.memo-wrapped row component
  // doesn't bust referential equality on every parent render.
  return useMemo(
    () =>
      (item: { names: Record<string, string> | null | undefined }): string => {
        const primary = pickName(item.names, i18n.locale);
        if (!secondaryLocale || secondaryLocale === i18n.locale) return primary;
        const secondary = pickName(item.names, secondaryLocale);
        if (!secondary || secondary === primary) return primary;
        return `${primary} (${secondary})`;
      },
    [i18n.locale, secondaryLocale],
  );
}

/**
 * UI-4 (2026-07): the two-line form of {@link useProductName}. Returns the
 * primary-locale name and (when the user opted into a secondary locale and
 * it differs) the secondary name SEPARATELY, so a row can render the primary
 * on its own line and the secondary as a muted second line — instead of the
 * `primary (secondary)` inline form that doubled row width and truncated the
 * transliteration mid-word ("To'g'ralgan s…"). `secondary` is null whenever
 * there is no distinct second name (default single-language users see no
 * change). Memoized by locale for the same memo-stability reason as
 * useProductName.
 */
export function useProductNameParts() {
  const i18n = useI18n();
  const secondaryLocale = useAuthStore((s) => s.session?.user.secondaryLocale ?? null);
  return useMemo(
    () =>
      (item: {
        names: Record<string, string> | null | undefined;
      }): { primary: string; secondary: string | null } => {
        const primary = pickName(item.names, i18n.locale);
        if (!secondaryLocale || secondaryLocale === i18n.locale) return { primary, secondary: null };
        const secondary = pickName(item.names, secondaryLocale);
        if (!secondary || secondary === primary) return { primary, secondary: null };
        return { primary, secondary };
      },
    [i18n.locale, secondaryLocale],
  );
}

/**
 * M3.45 (2026-05-22): returns ONLY the secondary-locale name (no
 * parenthetical, no primary). Used by per-vendor copy templates —
 * when the operator pastes the list into the vendor's chat the
 * message should be pure Uzbek (or whatever secondary is), no
 * Chinese noise the vendor can't read.
 *
 * Falls back to the primary locale name when secondaryLocale is
 * null OR matches primary (so the copy still works for users who
 * haven't opted into bilingual mode).
 */
export function useVendorName() {
  const i18n = useI18n();
  const secondaryLocale = useAuthStore((s) => s.session?.user.secondaryLocale ?? null);
  return useMemo(
    () =>
      (item: { names: Record<string, string> | null | undefined }): string => {
        const effective =
          secondaryLocale && secondaryLocale !== i18n.locale
            ? secondaryLocale
            : i18n.locale;
        return pickName(item.names, effective);
      },
    [i18n.locale, secondaryLocale],
  );
}

/**
 * Vendor-locale unit-label resolver — companion to useVendorName.
 * Returns the SKU's canonical unit (kg / bunch / pcs / …) localized
 * to the SECONDARY locale when set, else the primary locale.
 *
 * Why this exists: the copy-list templates were emitting the RAW
 * canonical unit ("bunch") because they read `sku.unit` directly —
 * which is the storage value, never the display value. Chinese users
 * saw "bunch" instead of "把"; once vendor-language is on, the same
 * leak would show "kg" instead of "kg" (fine for kg, but "bunch" → "bog'lam"
 * was the real ask).
 *
 * Ensures the secondary catalog is loaded so the lookup hits without
 * a first-paint delay.
 */
export function useVendorUnitLabel() {
  const i18n = useI18n();
  const rawSecondary = useAuthStore((s) => s.session?.user.secondaryLocale ?? null);
  const secondaryLocale = asLocale(rawSecondary);
  // Pre-load secondary catalog. If null, ensure primary (no-op).
  useEnsureLocale(secondaryLocale ?? i18n.locale);
  return useMemo(() => {
    const effective: Locale =
      secondaryLocale && secondaryLocale !== i18n.locale
        ? secondaryLocale
        : i18n.locale;
    const t = effective === i18n.locale ? i18n.t : createI18n(effective).t;
    return (unit: string | null | undefined): string => {
      if (!unit) return '';
      const canonical = unit.toLowerCase();
      const key = ('unit.' + canonical) as Parameters<typeof t>[0];
      const localized = t(key);
      return localized === key ? unit : localized;
    };
  }, [i18n, secondaryLocale]);
}
