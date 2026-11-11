/**
 * Product names in the languages a user reads. The hooks in
 * hooks/useI18n.ts add the locale and memoisation; the choices are made
 * here, where they are testable without React (review TEST3-08,
 * 2026-11-10).
 */
import { nameLang, otherLang } from './nameLang';

type Names = Record<string, string> | null | undefined;

/**
 * The name in `locale`, else in the first fallback language that has one
 * (the order of {@link nameLang}), else any name the product has, else "—".
 */
export function pickName(names: Names, locale: string): string {
  const n = names ?? {};
  const lang = nameLang(n, locale);
  return (lang === undefined ? Object.values(n)[0] : n[lang]) ?? '—';
}

/**
 * M3.45 (2026-05-22): "Primary (Secondary)" for a user who reads a second
 * language (Settings → market-stall language), so an operator can match
 * what they see with what the vendor reads in the copied message. One
 * name when there is no second language, it is the interface's, or the
 * product's name is the same in both.
 */
export function productName(names: Names, locale: string, secondaryLocale: string | null): string {
  const { primary, secondary } = productNameParts(names, locale, secondaryLocale);
  return secondary === null ? primary : `${primary} (${secondary})`;
}

export interface ProductNameParts {
  primary: string;
  secondary: string | null;
  /** Set only when the name shown is in another language than the UI. */
  primaryLang?: string;
  secondaryLang?: string;
}

/**
 * UI-4 (2026-07): the same choice as {@link productName}, as two parts, so
 * a row shows the second name as its own muted line instead of doubling
 * the row's width. A11Y-3 (2026-10-31): each part says which language it
 * is in when that is not the interface's, so a screen reader switches
 * voice for it.
 */
export function productNameParts(
  names: Names,
  locale: string,
  secondaryLocale: string | null,
): ProductNameParts {
  const primary = pickName(names, locale);
  const primaryLang = otherLang(nameLang(names, locale), locale);
  if (!secondaryLocale || secondaryLocale === locale) {
    return { primary, secondary: null, primaryLang };
  }
  const secondary = pickName(names, secondaryLocale);
  if (!secondary || secondary === primary) return { primary, secondary: null, primaryLang };
  return {
    primary,
    secondary,
    primaryLang,
    secondaryLang: otherLang(nameLang(names, secondaryLocale), locale),
  };
}

/** The language of text for the vendor (copy lists): the second language when the user set one. */
export function vendorLocale<L extends string>(locale: L, secondaryLocale: L | null): L {
  return secondaryLocale && secondaryLocale !== locale ? secondaryLocale : locale;
}
