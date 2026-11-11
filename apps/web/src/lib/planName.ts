import { lookup, type CatalogKey, type Locale } from '@compass/i18n';

/**
 * A plan's name in the reader's language (review WALK-05). The catalogs
 * name the built-in plans; a plan added since shows the name stored with
 * it, which was every plan's name in every language.
 */
export function planName(code: string, storedName: string, locale: Locale): string {
  return lookup(`subscription.plans.${code}` as CatalogKey, locale) ?? storedName;
}
