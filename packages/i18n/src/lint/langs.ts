/**
 * What the catalog lint reads: one catalog per language. `Lang` is the
 * package's `Locale`, so adding a language makes the tables keyed by
 * language (terms.ts) and the test's CATALOGS fail to type-check until
 * they name it; add it to LANGS as well.
 */
import type { CatalogModule, Locale } from '../catalogs/index';

export type Lang = Locale;
export type Catalogs = Record<Lang, CatalogModule>;

/** The order findings are reported in. */
export const LANGS: readonly Lang[] = ['zh', 'en', 'ru', 'uz'];
