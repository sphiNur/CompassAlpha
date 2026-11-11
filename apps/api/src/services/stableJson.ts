/**
 * JSON with object keys sorted, so the same value always gives the same
 * text: `{b, a}` equals `{a, b}`, whichever order JSONB or a client put the
 * keys in. Arrays keep their order. A property whose value is undefined is
 * left out, as JSON.stringify leaves it out; a Date is its ISO string.
 *
 * Review CONF-09 (2026-11): one copy. The idempotency middleware, the daily
 * close and the admin audit each had their own, and the daily close's
 * printed `undefined` and turned a Date into `{}`. This is the
 * middleware's: the request hashes of keys already stored do not change.
 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
