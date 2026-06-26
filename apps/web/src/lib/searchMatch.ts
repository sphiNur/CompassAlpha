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
 * Strategy: normalized substring match across ALL language values
 * present, plus the optional `code` field (short identifier like
 * "BEEF-RIB-1KG"). When substring misses, Latin/Cyrillic tokens get a
 * light edit-distance fallback so mobile typos like "tomto" still find
 * "tomato" without turning short CJK searches into noise.
 *
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
  return trimmed.split(/\s+/).map(normalizeText).filter(Boolean);
}

/**
 * True iff every token appears as a substring or close fuzzy hit in at
 * least one of: name fields (any language), `code`. Use
 * `normalizeQuery` to produce the token array.
 */
export function matchesNameLike(item: NameLike, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack: string[] = [];
  if (item.names) {
    for (const v of Object.values(item.names)) {
      if (typeof v === 'string' && v) haystack.push(normalizeText(v));
    }
  }
  if (item.code) haystack.push(normalizeText(item.code));
  // Every token must be found in at least one haystack entry.
  // We normalize tokens defensively so callers who forgot to run
  // them through `normalizeQuery` still get correct results.
  return tokens.every((rawTok) => {
    const tok = normalizeText(rawTok);
    return haystack.some((s) => fuzzyIncludes(s, tok));
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
    .map((f) => normalizeText(f));
  return tokens.every((rawTok) => {
    const tok = normalizeText(rawTok);
    return haystack.some((s) => fuzzyIncludes(s, tok));
  });
}

function normalizeText(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function compactToken(raw: string): string {
  return raw.replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

function isFuzzyEligible(token: string): boolean {
  const compact = compactToken(token);
  if (compact.length < 4) return false;
  if (/\p{Script=Han}/u.test(compact)) return false;
  return /\p{Letter}|\p{Number}/u.test(compact);
}

function maxDistance(len: number): number {
  if (len <= 4) return 1;
  if (len <= 8) return 2;
  return 3;
}

function fuzzyIncludes(haystack: string, rawToken: string): boolean {
  const token = rawToken.trim();
  if (!token) return true;
  if (haystack.includes(token)) return true;

  const compactHaystack = compactToken(haystack);
  const compactTok = compactToken(token);
  if (!compactTok) return true;
  if (compactHaystack.includes(compactTok)) return true;
  if (!isFuzzyEligible(compactTok)) return false;

  const candidates = new Set<string>();
  for (const part of haystack.split(/[\s,;:/\\()[\]{}"'·|+*_]+/u)) {
    const compact = compactToken(part);
    if (compact.length >= Math.max(3, compactTok.length - 2)) candidates.add(compact);
  }
  if (compactHaystack.length >= compactTok.length - 2) candidates.add(compactHaystack);

  const allowed = maxDistance(compactTok.length);
  for (const candidate of candidates) {
    if (candidate.length < 3) continue;
    if (Math.abs(candidate.length - compactTok.length) > allowed) continue;
    if (boundedLevenshtein(compactTok, candidate, allowed) <= allowed) return true;
  }
  return false;
}

function boundedLevenshtein(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0]!;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
      if (curr[j]! < rowMin) rowMin = curr[j]!;
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}
