import { isCatalogKey, lookup, type Locale } from '@compass/i18n';

/**
 * A plan's name in the reader's language (review WALK-05). The catalogs
 * name the built-in plans; a plan added since shows the name stored with
 * it, which was every plan's name in every language. Review COREWEB1-31
 * (2026-11-12): the key is checked, not cast.
 */
export function planName(code: string, storedName: string, locale: Locale): string {
  const key = `subscription.plans.${code}`;
  return (isCatalogKey(key) ? lookup(key, locale) : undefined) ?? storedName;
}
