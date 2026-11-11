import type { CatalogKey } from '@compass/i18n';

/**
 * The JSON answers for a path nothing claims and for an unhandled error.
 * Review COREAPI-37: the key a client reads must be in the catalogs, which
 * the type now checks; the 404's `common.notFound` was in none.
 */
export const NOT_FOUND_BODY = {
  code: 'NOT_FOUND',
  i18nKey: 'common.errors.notFound',
} as const satisfies { code: string; i18nKey: CatalogKey };

export const INTERNAL_BODY = {
  code: 'INTERNAL',
  i18nKey: 'common.errors.internal',
} as const satisfies { code: string; i18nKey: CatalogKey };
