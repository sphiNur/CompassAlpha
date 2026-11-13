/**
 * The app's own words in the walk's language, so the walk finds controls
 * the way a person reading that language does.
 */
import { format, loadCatalog, type CatalogKey, type FormatVars, type Locale } from '@compass/i18n';

export type T = (key: CatalogKey, vars?: FormatVars) => string;

export async function translator(lang: Locale): Promise<T> {
  await loadCatalog('en');
  await loadCatalog(lang);
  return (key, vars) => format(key, lang, vars);
}
