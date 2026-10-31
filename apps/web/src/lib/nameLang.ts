/**
 * A11Y-3 (2026-10-31): which language a product name is written in, so the
 * element showing it can carry `lang` and a screen reader reads it with the
 * right voice. Kept apart from the hook so it is testable without React.
 */

/**
 * The language of the name {@link pickName} returns for `locale`: the
 * locale itself when the product has a name in it, otherwise the first
 * fallback that has one (same order as pickName). Undefined when the
 * product has no name in a known language.
 */
export function nameLang(
  names: Record<string, string> | null | undefined,
  locale: string,
): string | undefined {
  const n = names ?? {};
  for (const code of [locale, 'en', 'ru', 'zh', 'uz']) if (n[code] != null) return code;
  return undefined;
}

/** `lang` only when it differs from the page's language. */
export function otherLang(lang: string | undefined, uiLocale: string): string | undefined {
  return lang && lang !== uiLocale ? lang : undefined;
}
