import { isLoaded, type Locale } from '@compass/i18n';

export const ALL_LOCALES: readonly Locale[] = ['en', 'zh', 'ru', 'uz'];

/** The last language drawn with its catalog in place. */
let shownLocale: Locale | null = null;

/**
 * Which language to draw in while `wanted` may still be loading: the
 * wanted one once its catalog is in; until then the one already on
 * screen (switching language in Settings keeps the old words for the
 * moment the new chunk takes), or whichever catalog is loaded at all
 * (ensureCatalog's English fallback when offline).
 */
export function shownLocaleFor(
  wanted: Locale,
  loaded: (locale: Locale) => boolean = isLoaded,
): Locale {
  if (loaded(wanted)) {
    shownLocale = wanted;
    return wanted;
  }
  if (shownLocale && loaded(shownLocale)) return shownLocale;
  return ALL_LOCALES.find((l) => loaded(l)) ?? wanted;
}

/** Tests only: forget the language on screen. */
export function resetShownLocale(): void {
  shownLocale = null;
}
