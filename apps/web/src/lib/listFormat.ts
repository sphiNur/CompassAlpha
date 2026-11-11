import type { Locale } from '@compass/i18n';

/**
 * A list of names or times in the UI language: "Manager, Staff and Cashier",
 * 「店长、员工和收银员」, "Менеджер, Сотрудник и Кассир". Review COREWEB1-19
 * (2026-11-12): lists were joined with ", " in every language, so Chinese
 * read 「店长, 员工」.
 *
 * Intl.ListFormat came to iOS in 14.5; an older WebView gets the list with
 * the language's separator and no "and".
 */
export function formatList(items: readonly string[], locale: Locale): string {
  if (typeof Intl.ListFormat === 'function') {
    try {
      return new Intl.ListFormat(locale, { type: 'conjunction' }).format(items);
    } catch {
      // A runtime without this language's data: the plain list below.
    }
  }
  return items.join(locale === 'zh' ? '、' : ', ');
}
