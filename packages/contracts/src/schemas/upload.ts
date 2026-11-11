/**
 * Photo uploads (`upload.requestPresign`). Zod-free, so the web can import
 * it without pulling zod into the bundle.
 *
 * Review COREWEB2-29 (2026-11-12): the kinds were listed in the API's
 * upload router and again, by hand, in the web's photo hook.
 */

/** What a photo is of; it names the folder of the stored object's key. */
export const PHOTO_KINDS = ['receipt', 'issue', 'avatar', 'sku'] as const;
export type PhotoKind = (typeof PHOTO_KINDS)[number];
