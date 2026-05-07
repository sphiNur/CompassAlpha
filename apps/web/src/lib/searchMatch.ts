/**
 * Cross-language search match helpers (M1.10, 2026-05-08).
 *
 * Why this exists: SKU rows carry `names: { uz, ru, en, zh }`. A
 * Russian-speaking cashier searching for "молоко" needs to find the
 * row even if the catalog's primary name is English ("Milk"). A
 * Chinese cook typing "牛肉" should match a SKU named "Beef" /
 * "Mol go'shti" / "Говядина". Without this helper, search would
 * only match the locale-resolved display name (via `useProductName`)
 * and miss the other 3.
 *
 * Strategy: lowercase substring match across ALL language values
 * present, plus the optional `code` field (short identifier like
 * "BEEF-RIB-1KG"). This is the pragmatic shape:
 *
 *   - Substring (not fuzzy): operators know what they're looking for.
 *     Fuzzy matches add false positives that scroll past the real one.
 *   - Lowercase normalization: case shouldn't matter on a phone
 *     keyboard. Unicode-safe via `String.prototype.toLowerCase()`.
 *   - No transliteration: typing "moloko" should NOT match Russian
 *     "молоко". Cross-script magic surprises users; if they want
 *     to type Latin, they type the Latin name.
 *   - Multi-word AND: "牛肉 1kg" matches a SKU named "Beef" with
 *     code "BEEF-1KG". Each whitespace-separated token must hit
 *     SOMETHING in the row. Order doesn't matter.
 *
 * We intentionally avoid returning a relevance score — the FE just
 * filters in source order. The dataset is small enough (≤ a few
 * hundred SKUs) that scroll-to-find is fine once the list is
 * narrowed.
 */

interface NameLike {
  /** Multi-language names. May omit fields. */
  names?: Record<string, string> | null;
  /** Optional short identifier. */
  code?: string | null;
}

/**
 * Normalize a query for matching: lowercase + trim + collapse
 * runs of whitespace. Returns null when the result is empty so
 * callers can skip the filter entirely (which is what they want
 * when the search box is blank).
 */
export function normalizeQuery(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Split on Unicode whitespace. CJK doesn't use spaces, but a user
  // typing CJK won't include spaces between characters either, so
  // single-token still works.
  return trimmed.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * True iff every token in `tokens` appears as a substring in at
 * least one of: name fields (any language), `code`. Use
 * `normalizeQuery` to produce the token array.
 */
export function matchesNameLike(item: NameLike, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack: string[] = [];
  if (item.names) {
    for (const v of Object.values(item.names)) {
      if (typeof v === 'string' && v) haystack.push(v.toLowerCase());
    }
  }
  if (item.code) haystack.push(item.code.toLowerCase());
  // Every token must be found in at least one haystack entry.
  // We lowercase tokens defensively so callers who forgot to run
  // them through `normalizeQuery` still get correct results.
  return tokens.every((rawTok) => {
    const tok = rawTok.toLowerCase();
    return haystack.some((s) => s.includes(tok));
  });
}

/**
 * Plain-string variant for objects that don't have a `names` map —
 * e.g. members (search by displayName + tgUsername) or stores
 * (name + code). Pass an array of nullable strings; falsy values
 * are skipped.
 */
export function matchesAnyString(
  fields: Array<string | null | undefined>,
  tokens: string[],
): boolean {
  if (tokens.length === 0) return true;
  const haystack = fields
    .filter((f): f is string => typeof f === 'string' && f.length > 0)
    .map((f) => f.toLowerCase());
  return tokens.every((rawTok) => {
    const tok = rawTok.toLowerCase();
    return haystack.some((s) => s.includes(tok));
  });
}
