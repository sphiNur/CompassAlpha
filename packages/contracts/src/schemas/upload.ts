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

/**
 * The largest photo an upload may be, in bytes. Review COREAPI-32
 * (2026-11-12): the API wrote 8 MB twice, in the input check and in
 * `upload.config`.
 */
export const UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
