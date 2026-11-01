import { createElement, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  createI18n,
  detectLocale,
  ensureCatalog,
  isLoaded,
  type Locale,
} from '@compass/i18n';
import { startLocale } from '../lib/startLocale';
import { ALL_LOCALES, shownLocaleFor } from '../lib/shownLocale';
import { useAuthStore } from '../stores/authStore';
import { makeDateFormatters } from '../lib/dateFormat';
import { unitLabeller } from '../lib/unitLabel';
import { roleLabeller } from '../lib/roleLabels';
import { nameLang, otherLang } from '../lib/nameLang';

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
 * when it lands. No-op if already loaded. When it cannot be fetched,
 * English is loaded instead (ensureCatalog).
 *
 * Until the load resolves, useI18n keeps drawing in the language that
 * was on screen (see shownLocale) — no catalog is bundled any more, so
 * there is no English to fall back on for that moment (DX-PFE-2).
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
    void ensureCatalog(locale).then(() => {
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
  // boot-guard.js sets <html lang> from the Telegram / browser language;
  // the account's own locale wins once it is known. Screen readers use it,
  // and so does the `:lang(ru)` / `:lang(uz)` rule in styles/index.css.
  useEffect(() => {
    if (document.documentElement.lang !== resolved) document.documentElement.lang = resolved;
  }, [resolved]);
  const shown = shownLocaleFor(resolved);
  // A new object once the catalog is in, so memoized children that take
  // `i18n` as a prop draw again with the real words, not the keys the
  // hidden first render used (I18nGate).
  const shownReady = isLoaded(shown);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- shownReady is the point: see above
  return useMemo(() => createI18n(shown), [shown, shownReady]);
}

/**
 * Hides what it wraps until a catalog for the language the app opens in
 * has loaded (or English, when that one cannot be fetched). No catalog is
 * in the startup chunk since DX-PFE-2, and the screens would otherwise
 * show raw keys for that moment.
 *
 * Hidden, not held back: the tree renders and its queries start at once,
 * so the data and the catalog download side by side (holding the pages
 * back cost the order screen ~450 ms on slow 4G, measured). The wrapper
 * is `display: contents` — no box, the layout is the same — and stays in
 * place after, so nothing remounts when it turns visible. main.tsx starts
 * the same fetch before React renders. Only the first start waits: later
 * language changes go through shownLocale.
 */
export function I18nGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(() => ALL_LOCALES.some((l) => isLoaded(l)));
  useEffect(() => {
    if (ready) return;
    let live = true;
    void ensureCatalog(startLocale()).then(() => {
      if (live) setReady(true);
    });
    return () => {
      live = false;
    };
  }, [ready]);
  return createElement(
    'div',
    {
      style: ready ? GATE_OPEN : GATE_HIDDEN,
      'aria-busy': ready ? undefined : true,
      'data-i18n-gate': ready ? 'open' : 'loading',
    },
    children,
  );
}

const GATE_OPEN = { display: 'contents' } as const;
const GATE_HIDDEN = { display: 'contents', visibility: 'hidden' } as const;

/**
 * Locale-bound date/time formatters (2026-07-30, flow review).
 *
 * Every `toLocaleDateString` / `toLocaleString` call site passed either
 * `undefined` or `[]` as the locale, which means "use the BROWSER's
 * locale" — not the app's. A Chinese operator on a phone set to English
 * therefore saw "Thursday, July 30" as the review-sheet subtitle and
 * "JUNE 2026" as the run-history month header, in an otherwise fully
 * Chinese UI. The user's language choice lives in the session and drives
 * every other string; dates were the one thing ignoring it.
 *
 * Formatter instances are memoized per locale — `Intl.DateTimeFormat`
 * construction is the expensive part, and the run-history header builds
 * one per month group on every render.
 *
 * Accepts `Date | string | number | null`; returns '' for nullish input so
 * call sites can pipe possibly-absent server values straight through.
 */
export function useDateFormat() {
  const i18n = useI18n();
  return useMemo(() => makeDateFormatters(i18n.locale), [i18n.locale]);
}

/** Built-in role names and permission descriptions; see lib/roleLabels.ts. */
export function useRoleLabels() {
  const i18n = useI18n();
  return useMemo(() => roleLabeller(i18n.t), [i18n]);
}

/**
 * Hook for localized unit labels (M3.34, 2026-05-19).
 *
 * Backend stores unit as a short canonical string per the SKU schema
 * (kg / L / pcs / pack / pair / bunch / roll / box). The user
 * pointed out that "kg" / "pcs" / "bunch" displayed verbatim doesn't
 * read like the rest of a Chinese/Russian/Uzbek UI. This hook returns
 * a `(unit) => label` function that maps the canonical string to its
 * localized form via i18n key `unit.<canonical>`. Falls back to the
 * raw unit string if a key is missing or the unit is empty (extras
 * may carry exotic free-text units pre-M3.34).
 */
export function useUnitLabel() {
  const i18n = useI18n();
  return useMemo(() => unitLabeller(i18n.t), [i18n]);
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
      }): ProductNameParts => {
        const primary = pickName(item.names, i18n.locale);
        // A11Y-3 (2026-10-31): say which language a name is in when it is
        // not the interface's, so a screen reader switches voice for it.
        const primaryLang = otherLang(nameLang(item.names, i18n.locale), i18n.locale);
        if (!secondaryLocale || secondaryLocale === i18n.locale) {
          return { primary, secondary: null, primaryLang };
        }
        const secondary = pickName(item.names, secondaryLocale);
        if (!secondary || secondary === primary) return { primary, secondary: null, primaryLang };
        return {
          primary,
          secondary,
          primaryLang,
          secondaryLang: otherLang(nameLang(item.names, secondaryLocale), i18n.locale),
        };
      },
    [i18n.locale, secondaryLocale],
  );
}

export interface ProductNameParts {
  primary: string;
  secondary: string | null;
  /** Set only when the name shown is in another language than the UI. */
  primaryLang?: string;
  secondaryLang?: string;
}

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
    return unitLabeller(t);
  }, [i18n, secondaryLocale]);
}
