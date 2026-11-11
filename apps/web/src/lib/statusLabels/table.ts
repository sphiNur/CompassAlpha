/**
 * UI-2: a status is shown in the reader's language, from one place. Each
 * file of this folder names the catalog key for every value one status can
 * take, so a value added to its enum fails type-check there; a value this
 * build does not know (a newer server) reads as "unknown status", never as
 * the raw value or a key.
 *
 * Review RUNWEB1-26, ADM2-16 and COREWEB1-31 (2026-11-12): the keys were
 * composed from strings and cast at each call site, which turned the key
 * check off, and the run's step was mapped twice in RunPage, one of them
 * falling back to the raw status.
 *
 * One file per status, so a page loads only its own: the order page is in
 * the startup chunk (app/shell/pages.tsx), and from one shared file the
 * run, receiving and subscription tables joined it there (CI's startup
 * budget, scripts/check-entry-budget.ts).
 */
import type { CatalogKey, I18n } from '@compass/i18n';

export type Translate = Pick<I18n, 't'>;

function isIn<S extends string>(table: Record<S, CatalogKey>, value: string): value is S {
  // Not Object.hasOwn: older iOS WebViews lack it, and nothing polyfills it.
  return Object.prototype.hasOwnProperty.call(table, value);
}

/** The word for `status` from `table`, or "Unknown status". */
export function labelIn<S extends string>(
  i18n: Translate,
  table: Record<S, CatalogKey>,
  status: string | null | undefined,
): string {
  return i18n.t(status != null && isIn(table, status) ? table[status] : 'common.unknownStatus');
}
