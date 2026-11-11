/**
 * The four-language names of categories, products and dishes, as their
 * editors hold them. Review ADM2-11 (2026-11-11): the category and product
 * drafts had a field per language and the dish draft a map, each with its
 * own copy of the "drop the empty ones" step.
 */
import type { Locale } from '@compass/i18n';

/** The order the name fields show: Uzbek first, the working language here. */
export const CATALOG_LOCALES = ['uz', 'ru', 'en', 'zh'] as const satisfies readonly Locale[];

export type CatalogNames = Record<Locale, string>;

export const EMPTY_NAMES: CatalogNames = { uz: '', ru: '', en: '', zh: '' };

/** A saved name map as an editor's draft: every language, '' where none. */
export function namesForEdit(
  names: Partial<Record<string, string>> | null | undefined,
): CatalogNames {
  return {
    uz: names?.uz ?? '',
    ru: names?.ru ?? '',
    en: names?.en ?? '',
    zh: names?.zh ?? '',
  };
}

/**
 * The names to save: trimmed, and empty languages left out rather than
 * sent as '' (2026-10-21 CA-40), so the readers' fallback shows another
 * language instead of a blank.
 */
export function cleanNames(names: Partial<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const locale of CATALOG_LOCALES) {
    const name = names[locale]?.trim();
    if (name) out[locale] = name;
  }
  return out;
}

/** One name in any language is enough (CAT-10, the server's rule). */
export function hasAnyName(names: Partial<Record<string, string>>): boolean {
  return Object.keys(cleanNames(names)).length > 0;
}
