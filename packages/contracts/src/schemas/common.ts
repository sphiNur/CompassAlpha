import { z } from 'zod';
import { ORDER_QTY_MAX, QTY_TEXT_RE } from '../limits';
import { PHOTO_KINDS, UPLOAD_MAX_BYTES } from './upload';

// Zod-free limits live in ../limits so the web can import them without
// pulling zod into its main chunk (P-5); re-exported for the barrel.
export {
  BACKDATE_LIMIT_DAYS,
  ORDER_QTY_MAX,
  STOCKTAKE_COUNT_MAX,
  STOCKTAKE_COUNT_MESSAGE,
  isoDateDaysBefore,
  stocktakeCountProblem,
} from '../limits';
export type { StocktakeCountProblem } from '../limits';

export const UuidSchema = z.string().uuid();

/**
 * A photo the app shows and links: an http(s) URL, or a data:image URI
 * (the base64 fallback when the upload store is not there), at most
 * 300,000 characters. Review RUNAPI-24: receipt photos took any string,
 * `javascript:` included; delivery photos had this rule since DLV-7.
 */
export const PhotoUrlSchema = z
  .string()
  .max(300_000)
  .regex(/^(https?:\/\/|data:image\/)/i, 'common.errors.invalidPhotoUrl');

/** `upload.requestPresign`: where to put one photo. */
export const RequestPresignInputSchema = z.object({
  kind: z.enum(PHOTO_KINDS),
  contentType: z.string().min(1).max(64),
  /** Caller's hint at file size in bytes, at most UPLOAD_MAX_BYTES. */
  contentLength: z.number().int().min(1).max(UPLOAD_MAX_BYTES).optional(),
  /** Optional original filename. Accepted for older clients and ignored:
   *  AUTH-24 (2026-10-30) — the key's extension came from it, so a signed
   *  image/png upload could land under "….html". */
  filename: z.string().max(200).optional(),
});

/**
 * True when the text holds a C0/C1 control character (U+0000–U+001F,
 * U+007F–U+009F). Security scan F10 (2026-10-31): names a tenant admin
 * types are later printed raw by the operator's maintenance scripts, and
 * an escape sequence in a store name could rewrite what the terminal
 * showed before a destructive `--apply`. Names and codes refuse them.
 */
export function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

export const CONTROL_CHARS_MESSAGE = 'common.errors.controlCharacters';

/**
 * The message of a check only a faulty client can fail: a field the app
 * fills in itself, a choice from a list it offers, or a field no screen
 * asks for (review ADM1-26, 2026-11-12). It is the generic key the server
 * puts on every schema refusal, so the app shows the caller's own failure
 * sentence. A check a person can fail by what they type has a key of its
 * own.
 */
export const CLIENT_FAULT_MESSAGE = 'common.errors.validation';

/** A one-line name: no control characters (F10). */
export const noControlChars = (text: string): boolean => !hasControlChars(text);
/**
 * A calendar date, YYYY-MM-DD. B11 (2026-10-30): the pattern alone let
 * "2026-02-31" or "2026-13-01" through, and the query then failed in
 * Postgres as a 500; it must also be a day that exists.
 */
export const DateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'common.errors.invalidDate')
  .refine(isCalendarDate, 'common.errors.invalidDate');

/**
 * Years the app accepts in a date (B11 / BUY-15 / RE-AUTH-3, 2026-10-31).
 * JavaScript reads "0000-01-01" as a real day, Postgres has no year 0, so
 * it got past the check above and failed in the query as a 500. Business
 * dates live comfortably inside this window; a 90-day look-back from its
 * first day still lands on a year Postgres has.
 */
export const MIN_DATE_YEAR = 1900;
export const MAX_DATE_YEAR = 2999;

/** "YYYY-MM-DD" naming a day that exists, between MIN/MAX_DATE_YEAR. */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  if (year < MIN_DATE_YEAR || year > MAX_DATE_YEAR) return false;
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
}
/** An IANA time zone the runtime knows ("Asia/Tashkent", "UTC"). */
export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * CLS-7 (2026-10-30): a store saved with "Mars/Olympus" made every
 * business-date read for it fail, so its daily close never loaded.
 */
/**
 * Messages are catalog keys (2026-10-31): a zod sentence such as
 * "unknown time zone" reached the admin form as a bare "出错了".
 */
export const TimeZoneSchema = z
  .string()
  .trim()
  .min(1, 'admin.errors.timeZoneUnknown')
  .max(64, 'admin.errors.timeZoneUnknown')
  .refine(isTimeZone, 'admin.errors.timeZoneUnknown');

export const LocaleSchema = z.enum(['en', 'zh', 'ru', 'uz']);
export type Locale = z.infer<typeof LocaleSchema>;

/** Decimal as string. We keep it stringly-typed to avoid float drift across the wire. */
export const DecimalStringSchema = z
  .string()
  .regex(/^-?\d+(\.\d{1,3})?$/, 'common.errors.invalidDecimal');

/** ORD-9: the order line quantity cap (defined in ../limits, zod-free). */
export const OrderQtySchema = DecimalStringSchema.refine((v) => Math.abs(Number(v)) <= ORDER_QTY_MAX, {
  message: 'order.errors.qtyTooLarge',
});

/**
 * A strictly positive quantity (at most three decimals, QTY_TEXT_RE), for
 * fields where 0 or below is always a bug. Domain commands check this too,
 * but pulling the rule into the contract layer makes the API reject
 * earlier (no DB load) and gives the FE form-validation errors that line
 * up with what the server would have said.
 *
 * Added 2026-05-05 (audit finding) for `run.purchaseItem`, whose price
 * took 0 or a negative number. Review ORD-16 (2026-11): not for money any
 * more; a price has at most two decimals and its own schema
 * (PurchasePriceSchema).
 */
export const PositiveDecimalStringSchema = z
  .string()
  .regex(QTY_TEXT_RE, 'common.errors.positiveDecimal')
  .refine((s) => Number(s) > 0, { message: 'common.errors.positiveDecimal' });

/** 8–128 characters, generated by the client. */
export const IdempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_\-:.]{8,128}$/, CLIENT_FAULT_MESSAGE);
