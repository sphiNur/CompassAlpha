/**
 * Review MWD-15 (modern-web-guidance: privacy): "scrub Personally
 * Identifiable Information (PII) from application logs. Use automated
 * masking for emails, tokens, and IDs."
 *
 * Client log lines (`system.log`) carried free-form error messages and
 * stacks as they came: a failed fetch could hold a bearer token, a URL
 * with Telegram's launch data (`#tgWebAppData=…`, `initData` with its
 * `user=` and `hash=`), or a phone number or e-mail someone typed. They
 * were stored for 30 days and mirrored to the journal, which keeps its
 * own copy. Every log line passes `system.log`, so the masking is done
 * there, once, before either copy is written; the web bundle stays as it
 * is.
 *
 * Pure and line-based: what is masked becomes a marker naming what it
 * was, so a log still reads ("Bearer [token]", "[email]", "[phone]").
 */

/** `Authorization: Bearer …` and the like. */
const BEARER = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

/** A JWT (header.payload[.signature]); a cut-off one too. */
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g;

/**
 * A URL fragment that holds Telegram's launch parameters
 * (`#tgWebAppData=…&tgWebAppVersion=…`): the whole fragment goes.
 */
const TG_FRAGMENT = /#[^\s"'<>]*tgWebApp[^\s"'<>]*/gi;

/**
 * Query or form parameters that carry Telegram's init data or a secret:
 * the value goes, the name stays. `user=` holds the person's name and
 * id, `hash=` / `signature=` sign the launch data.
 */
const SECRET_PARAM =
  /\b(tgWebAppData|init_?data|hash|signature|user|receiver|chat|chat_instance|query_id|(?:access|refresh|id)_?token|token|password|secret|api_?key)=[^&\s"'<>#]*/gi;

/** An e-mail address. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/**
 * A phone-like run: an optional "+", then digits with spaces, dashes or
 * brackets between them. Not after a letter, digit, "." or "-", so ids,
 * hex, versions and `file.js:12:345` stay.
 */
const PHONE_LIKE = /(?<![\w.+-])\+?\(?\d[\d ()-]{7,22}\d(?![\w.-])/g;

/** 9 to 15 digits is a phone number (E.164 allows 15). */
const PHONE_MIN_DIGITS = 9;
const PHONE_MAX_DIGITS = 15;
/**
 * A bare run of digits (no "+", no separators) is a phone only at 9, 11
 * or 12 digits (a local number, a Chinese mobile, a number without its
 * "+"). 10 digits is taken as epoch seconds (Telegram's `auth_date`),
 * 13 and more as epoch ms or an id.
 */
const BARE_PHONE_DIGITS = new Set([9, 11, 12]);

function maskPhone(match: string): string {
  const digits = match.replace(/\D/g, '').length;
  if (digits < PHONE_MIN_DIGITS || digits > PHONE_MAX_DIGITS) return match;
  if (/^\d+$/.test(match) && !BARE_PHONE_DIGITS.has(digits)) return match;
  // A date and time ("2026-11-14 12:30") is not a phone.
  if (/^\d{4}-\d{2}-\d{2}\b/.test(match)) return match;
  return '[phone]';
}

/** `text` with tokens, Telegram launch data, e-mails and phone numbers masked. */
export function redactLogText(text: string): string {
  if (!text) return text;
  return text
    .replace(BEARER, (_m, scheme: string) => `${scheme} [token]`)
    .replace(JWT, '[jwt]')
    .replace(TG_FRAGMENT, '#[telegram]')
    .replace(SECRET_PARAM, (_m, name: string) => `${name}=[redacted]`)
    .replace(EMAIL, '[email]')
    .replace(PHONE_LIKE, maskPhone);
}

/** Below this depth a value is left as it is (capLogData already bounds the size). */
const MAX_DEPTH = 8;

/**
 * The same masking for every string inside a JSON value (the `data`
 * field): keys and non-strings stay.
 */
export function redactLogValue<T>(value: T, depth = 0): T {
  if (typeof value === 'string') return redactLogText(value) as T;
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactLogValue(v, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactLogValue(v, depth + 1);
  }
  return out as T;
}
