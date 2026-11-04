/**
 * Cross-language search match helpers (M1.10, 2026-05-08; ranking 2026-11-05).
 *
 * Why this exists: SKU rows carry `names: { uz, ru, en, zh }`. A
 * Russian-speaking cashier searching for "молоко" needs to find the
 * row even if the catalog's primary name is English ("Milk"). A
 * Chinese cook typing "牛肉" should match a SKU named "Beef" /
 * "Mol go'shti" / "Говядина". Without this helper, search would
 * only match the locale-resolved display name (via `useProductName`)
 * and miss the other 3.
 *
 *   - Lowercase + accent/punctuation normalization: case and the many
 *     Uzbek apostrophe variants shouldn't matter on a phone keyboard.
 *   - No transliteration: typing "moloko" should NOT match Russian
 *     "молоко". Cross-script magic surprises users.
 *   - Multi-word AND: "牛肉 1kg" matches a SKU named "Beef" with
 *     code "BEEF-1KG". Each whitespace-separated token must hit
 *     SOMETHING in the row. Order doesn't matter.
 *
 * RANKING (2026-11-05)
 *
 * Measured on the live catalogs (~315 products per workspace, all four
 * languages), filtering in catalog order put the product the user meant
 * first only 36–57 % of the time — typing "Yeast" listed the product
 * named "Yeast" 18th of 23 — and the typo fallback let unrelated rows in
 * ("sabzi" → takeaway boxes, "Чёрный" → Cherry Tomato). So each token now
 * scores its best hit across all fields:
 *
 *   100 the whole field          90 the field starts with it
 *    85 a whole word             80 a word starts with it
 *    60 contained anywhere
 *    30/20/10 typo (1/2/3 edits) — word by word, same first letter,
 *             a swap of two neighbours counts as one edit
 *
 * plus a small bonus when the hit is in the reader's own language. A
 * list search (`rankNameLike` / `rankStrings`) sorts by score, then
 * shorter name, then original order — and drops typo-only rows whenever
 * something matched literally, so typos only widen a search that found
 * nothing. The boolean helpers keep their old contract (any hit, typos
 * included) for callers that filter row by row.
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
 * True iff every token appears (literally or as a close typo) in at least
 * one of: name fields (any language), `code`. Use `normalizeQuery` to
 * produce the token array.
 */
export function matchesNameLike(item: NameLike, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  return scoreFields(nameFields(item, undefined), tokens) > 0;
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
  return scoreFields(stringFields(fields), tokens) > 0;
}

/**
 * Filter + sort `items` by relevance to `tokens` (from `normalizeQuery`).
 * `preferLang` (the UI locale) breaks ties toward names the reader can
 * read. Returns `items` unchanged when there are no tokens.
 */
export function rankNameLike<T>(
  items: readonly T[],
  tokens: string[] | null,
  get: (item: T) => NameLike,
  preferLang?: string,
): T[] {
  if (!tokens || tokens.length === 0) return items as T[];
  return rank(items, tokens, (it) => nameFields(get(it), preferLang));
}

/** `rankNameLike` for rows searched by plain strings (names, suppliers…). */
export function rankStrings<T>(
  items: readonly T[],
  tokens: string[] | null,
  get: (item: T) => Array<string | null | undefined>,
): T[] {
  if (!tokens || tokens.length === 0) return items as T[];
  return rank(items, tokens, (it) => stringFields(get(it)));
}

// ── scoring ─────────────────────────────────────────────────────────

const S_EXACT = 100;
const S_PREFIX = 90;
const S_WORD = 85;
const S_WORD_PREFIX = 80;
const S_CONTAINS = 60;
const S_TYPO = [0, 30, 20, 10] as const; // by edit distance
const LITERAL_MIN = S_CONTAINS;
const PREFERRED_BONUS = 3;

interface Field {
  idx: Indexed;
  preferred: boolean;
}

function nameFields(item: NameLike, preferLang: string | undefined): Field[] {
  const out: Field[] = [];
  if (item.names) {
    for (const [lang, v] of Object.entries(item.names)) {
      if (typeof v === 'string' && v) out.push({ idx: indexed(v), preferred: lang === preferLang });
    }
  }
  if (item.code) out.push({ idx: indexed(item.code), preferred: false });
  return out;
}

function stringFields(fields: Array<string | null | undefined>): Field[] {
  const out: Field[] = [];
  for (const f of fields) if (typeof f === 'string' && f) out.push({ idx: indexed(f), preferred: false });
  return out;
}

/** Sum of each token's best score; 0 if any token misses entirely. */
function scoreFields(fields: Field[], tokens: string[]): number {
  let total = 0;
  for (const raw of tokens) {
    const tok = indexedToken(raw);
    if (!tok) continue;
    let best = 0;
    for (const f of fields) {
      const s = scoreToken(f.idx, tok);
      if (s > 0) {
        const v = s + (f.preferred ? PREFERRED_BONUS : 0);
        if (v > best) best = v;
      }
    }
    if (best === 0) return 0;
    total += best;
  }
  return total;
}

function rank<T>(items: readonly T[], tokens: string[], fieldsOf: (it: T) => Field[]): T[] {
  const hits: Array<{ it: T; score: number; literal: boolean; len: number; i: number }> = [];
  const literalFloor = LITERAL_MIN * tokens.length;
  items.forEach((it, i) => {
    const fields = fieldsOf(it);
    const score = scoreFields(fields, tokens);
    if (score <= 0) return;
    // Literal: every token hit without a typo (min literal score each).
    const literal = tokens.every((raw) => {
      const tok = indexedToken(raw);
      return !tok || fields.some((f) => scoreToken(f.idx, tok) >= LITERAL_MIN);
    });
    const len = Math.min(...fields.map((f) => f.idx.norm.length));
    hits.push({ it, score, literal: literal && score >= literalFloor, len, i });
  });
  const anyLiteral = hits.some((h) => h.literal);
  return hits
    .filter((h) => !anyLiteral || h.literal)
    .sort((a, b) => b.score - a.score || a.len - b.len || a.i - b.i)
    .map((h) => h.it);
}

/** Score one normalized token against one indexed field (0 = no hit). */
function scoreToken(f: Indexed, t: IndexedToken): number {
  const { norm, compact, words } = f;
  if (norm === t.norm || (t.compact && compact === t.compact)) return S_EXACT;
  if (norm.startsWith(t.norm) || (t.compact && compact.startsWith(t.compact))) return S_PREFIX;
  const tw = t.compact || t.norm;
  if (words.includes(tw)) return S_WORD;
  for (const w of words) if (w.startsWith(tw)) return S_WORD_PREFIX;
  if (norm.includes(t.norm) || (t.compact && compact.includes(t.compact))) return S_CONTAINS;
  if (!t.fuzzy) return 0;
  // Typo fallback, word by word. People rarely mistype the first letter,
  // and requiring it is what keeps unrelated words out.
  let bestD = t.maxD + 1;
  for (const w of words) {
    if (w[0] !== t.compact[0]) continue;
    // Whole word, or (while still typing) the word's leading part.
    for (const cand of w.length > t.compact.length + t.maxD ? [w, w.slice(0, t.compact.length)] : [w]) {
      if (cand.length < 3) continue;
      const d = damerau(t.compact, cand, t.maxD);
      if (d < bestD) bestD = d;
    }
    if (bestD === 1) break;
  }
  return bestD <= t.maxD ? S_TYPO[bestD] ?? 0 : 0;
}

// ── normalization + per-string index (cached) ───────────────────────

interface Indexed {
  norm: string;
  compact: string;
  /** compacted words, split on spaces and punctuation */
  words: string[];
}
interface IndexedToken {
  norm: string;
  compact: string;
  fuzzy: boolean;
  maxD: number;
}

// Perf (2026-11-05): the order page matches ~300 products × 4 languages on
// every keystroke; the names never change between keystrokes, so cache
// their normalized index. Bounded so a long session can't grow it forever.
const CACHE_MAX = 20_000;
const normalizedCache = new Map<string, string>();
const indexCache = new Map<string, Indexed>();
const tokenCache = new Map<string, IndexedToken | null>();
function cached<V>(cache: Map<string, V>, raw: string, fn: (s: string) => V): V {
  let v = cache.get(raw);
  if (v === undefined && !cache.has(raw)) {
    if (cache.size >= CACHE_MAX) cache.clear();
    v = fn(raw);
    cache.set(raw, v);
  }
  return v as V;
}

function normalizeText(raw: string): string {
  return cached(normalizedCache, raw, (s) =>
    s
      .normalize('NFKD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .replace(/[’‘`´ʻʼ]/g, "'")
      .replace(/[‐-―]/g, '-')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

function compactToken(raw: string): string {
  return raw.replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

function indexed(raw: string): Indexed {
  return cached(indexCache, raw, (s) => {
    const norm = normalizeText(s);
    return {
      norm,
      compact: compactToken(norm),
      // "Ice-Cream", "go'shti", "(3kg)": split on anything that isn't a
      // letter/number or an in-word apostrophe, then compact each word.
      words: norm
        .split(/[^\p{Letter}\p{Number}']+/u)
        .map(compactToken)
        .filter(Boolean),
    };
  });
}

function indexedToken(raw: string): IndexedToken | null {
  return cached(tokenCache, raw, (s) => {
    const norm = normalizeText(s);
    if (!norm) return null;
    const compact = compactToken(norm);
    const fuzzy = compact.length >= 4 && !/\p{Script=Han}/u.test(compact);
    return { norm, compact, fuzzy, maxD: maxDistance(compact.length) };
  });
}

function maxDistance(len: number): number {
  if (len <= 5) return 1;
  if (len <= 8) return 2;
  return 3;
}

/**
 * Optimal-string-alignment distance (Levenshtein + adjacent swap = 1),
 * bailing out once it exceeds `max`.
 */
function damerau(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = b.length;
  let prev2 = new Array<number>(n + 1).fill(0);
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    [prev2, prev, curr] = [prev, curr, prev2];
  }
  return prev[n]!;
}
