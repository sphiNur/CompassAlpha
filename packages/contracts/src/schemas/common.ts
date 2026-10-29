import { z } from 'zod';

export const UuidSchema = z.string().uuid();
/**
 * A calendar date, YYYY-MM-DD. B11 (2026-10-30): the pattern alone let
 * "2026-02-31" or "2026-13-01" through, and the query then failed in
 * Postgres as a 500; it must also be a day that exists.
 */
export const DateStringSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
  .refine((value) => {
    const day = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
  }, 'not a calendar date');
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
export const TimeZoneSchema = z.string().trim().min(1).max(64).refine(isTimeZone, 'unknown time zone');

export const LocaleSchema = z.enum(['en', 'zh', 'ru', 'uz']);
export type Locale = z.infer<typeof LocaleSchema>;

/** i18n names map: { en: '...', zh: '...', ru: '...', uz: '...' } — partial allowed, fallback graph en→ru→zh→uz. */
export const I18nNamesSchema = z.record(z.string()).refine((v) => Object.keys(v).length > 0, {
  message: 'at least one locale required',
});

/** Decimal as string. We keep it stringly-typed to avoid float drift across the wire. */
export const DecimalStringSchema = z
  .string()
  .regex(/^-?\d+(\.\d{1,3})?$/, 'invalid decimal');

/**
 * ORD-9 (2026-10-30): an order line quantity. A mistyped 1,000,000,000
 * overflowed numeric(12,3) as a 500, and 9,999,999 kg was saved without
 * a word. A million of anything per line is far beyond a kitchen order.
 */
export const OrderQtySchema = DecimalStringSchema.refine((v) => Math.abs(Number(v)) < 1_000_000, {
  message: 'too large',
});

/**
 * Strictly positive decimal — for money / actual-purchase qty fields where
 * a 0 or negative value is always a bug. Domain commands check this too,
 * but pulling the rule into the contract layer makes the API reject
 * earlier (no DB load) and gives the FE form-validation errors that line
 * up with what the server would have said.
 *
 * Added 2026-05-05 (audit finding): `unit_price` on `run.purchaseItem`
 * was previously typed as plain DecimalStringSchema, so a buggy client
 * could submit `0` or a negative price and only the projector would
 * catch the math anomaly downstream — corrupting the run total.
 */
export const PositiveDecimalStringSchema = z
  .string()
  .regex(/^\d+(\.\d{1,3})?$/, 'invalid decimal')
  .refine((s) => Number(s) > 0, { message: 'must be > 0' });

export const PaginationSchema = z.object({
  cursor: z.string().nullish(),
  limit: z.number().int().min(1).max(200).default(50),
});

export const IdempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_\-:.]+$/, 'invalid idempotency key');

/** Standard error response shape (also tRPC errorFormatter output). */
export const DomainErrorShape = z.object({
  code: z.enum(['VALIDATION', 'FORBIDDEN', 'CONFLICT', 'NOT_FOUND', 'PRECONDITION_FAILED', 'RATE_LIMITED', 'INTERNAL']),
  i18nKey: z.string(),
  context: z.record(z.unknown()).optional(),
});
