/**
 * Tiny ICU-aware i18n runtime.
 *
 * Catalogs are loaded per-locale (see ./catalogs/index.ts). en is
 * statically imported as the fallback; zh/ru/uz are dynamic imports
 * resolved on demand (M3.14-D, 2026-05-16). Lookup walks
 * locale → en → any-other-loaded so missing keys degrade gracefully.
 *
 * Interpolation is `{name}`; plurals are real ICU `{n, plural, ...}` blocks
 * selected via `Intl.PluralRules` (see selectPlurals below — it replaced a
 * stub that silently dropped the plural noun in en/ru/uz). Dependency-free;
 * swap in @formatjs/intl-messageformat if we ever need select/date/number
 * sub-formats too.
 */
import { getLoadedCatalog, type Locale, type CatalogKey } from './catalogs/index';

export type { Locale, CatalogKey, CatalogModule } from './catalogs/index';
export { loadCatalog, preloadCatalog, isLoaded, getLoadedCatalog } from './catalogs/index';

// Walk order: requested locale → en (always loaded) → other-loaded
// locales in a stable order. The "other loaded" tail is rarely hit
// (only when the active locale's catalog is mid-load and a key is
// missing from en — should be ~never).
const TAIL: Locale[] = ['en', 'ru', 'zh', 'uz'];

export function detectLocale(input: string | undefined | null): Locale {
  if (!input) return 'en';
  const lower = input.toLowerCase();
  if (lower.startsWith('zh')) return 'zh';
  if (lower.startsWith('ru')) return 'ru';
  if (lower.startsWith('uz')) return 'uz';
  if (lower.startsWith('en')) return 'en';
  return 'en';
}

export function lookup(key: CatalogKey, locale: Locale): string | undefined {
  const tried = new Set<Locale>();
  for (const l of [locale, ...TAIL]) {
    if (tried.has(l)) continue;
    tried.add(l);
    const cat = getLoadedCatalog(l);
    if (!cat) continue;
    const v = cat[key];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

export interface FormatVars {
  [key: string]: string | number | undefined;
}

export function format(key: CatalogKey, locale: Locale, vars: FormatVars = {}): string {
  let template = lookup(key, locale) ?? key;
  template = selectPlurals(template, locale, vars);
  return template.replace(/\{(\w+)\}/g, (_m, name: string) => String(vars[name] ?? ''));
}

/**
 * ICU plural selection (2026-07-30).
 *
 * WHAT WAS HERE BEFORE
 *
 * `stripPluralWrappers`, which found each `{n, plural, ...}` block and
 * replaced the WHOLE block with the bare count. It was introduced as a
 * "safety net" after an earlier regex-based attempt rendered garbage, with a
 * comment saying call sites must branch on count themselves until
 * @formatjs/intl-messageformat lands in M2.
 *
 * That net turned a visible bug into an invisible one. 24 keys in en, 20 in
 * ru and 8 in uz were authored in ICU plural form anyway, and every one of
 * them silently lost its noun:
 *
 *   approval.contributorsCount  n=3  ->  "3"          (want "3 contributors")
 *   run.label.sessionsCount     n=4  ->  "4"
 *   run.label.itemsHint         n=7  ->  "7 · x"      (want "7 items · x")
 *   admin.label.memberCount     n=5  ->  "5"
 *
 * zh has zero plural blocks — Chinese doesn't inflect for number — which is
 * exactly why this survived: the primary locale looked perfect while the
 * English and Russian UI had been dropping plural nouns for months.
 *
 * WHY IMPLEMENT RATHER THAN REWRITE THE KEYS
 *
 * The alternative was rephrasing 24 keys into count-agnostic forms
 * ("Contributors: 3"). But Russian needs three forms (одна роль / две роли /
 * пять ролей) and no amount of rephrasing makes `{n} ролей` correct for
 * n=1. The selection has to happen somewhere, and `Intl.PluralRules` is in
 * every runtime we target — it already knows every locale's rules, so this
 * is ~30 lines rather than a dependency.
 *
 * SUPPORTED SYNTAX
 *
 *   {name, plural, =0 {…} =1 {…} one {…} few {…} many {…} other {…}}
 *
 * Exact `=N` matches win over category matches, per ICU. `#` inside a case
 * body is replaced with the count. Nested `{var}` in a case body is left for
 * the caller's interpolation pass. `other` is required in practice; if it is
 * missing and nothing matches, the block renders empty rather than throwing.
 *
 * Brace matching is depth-counted (not regex) — that was the original bug.
 */
function selectPlurals(input: string, locale: Locale, vars: FormatVars): string {
  let out = '';
  let i = 0;
  while (i < input.length) {
    if (input[i] !== '{') {
      out += input[i++];
      continue;
    }
    // Walk to the matching close brace, counting nesting.
    const start = i;
    let depth = 0;
    let j = i;
    while (j < input.length) {
      const c = input[j]!;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
      j++;
    }
    if (depth !== 0) {
      // Unmatched — emit the remainder as-is rather than looping forever.
      out += input.slice(start);
      return out;
    }
    const block = input.slice(start, j);
    const header = block.match(/^\{\s*(\w+)\s*,\s*plural\s*,/);
    if (header) {
      const varName = header[1]!;
      const raw = vars[varName];
      const count = typeof raw === 'number' ? raw : Number(raw ?? 0);
      const body = block.slice(header[0].length, -1);
      out += pickPluralCase(body, count, locale);
    } else {
      // A plain `{name}` placeholder — leave it for the interpolation pass.
      out += block;
    }
    i = j;
  }
  return out;
}

/**
 * Parse `=0 {…} one {…} other {…}` and return the body matching `count`.
 * Exact `=N` selectors take precedence over CLDR categories.
 */
function pickPluralCase(body: string, count: number, locale: Locale): string {
  const cases = new Map<string, string>();
  let i = 0;
  while (i < body.length) {
    // Selector: skip whitespace, then read until '{'.
    while (i < body.length && /\s/.test(body[i]!)) i++;
    if (i >= body.length) break;
    const selStart = i;
    while (i < body.length && body[i] !== '{') i++;
    if (i >= body.length) break;
    const selector = body.slice(selStart, i).trim();
    // Body: depth-counted so nested {var} survives.
    let depth = 0;
    const bodyStart = i;
    while (i < body.length) {
      const c = body[i]!;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
      i++;
    }
    if (depth !== 0) break;
    cases.set(selector, body.slice(bodyStart + 1, i - 1));
  }

  const exact = cases.get('=' + String(count));
  if (exact !== undefined) return exact.replace(/#/g, String(count));

  let category = 'other';
  try {
    category = new Intl.PluralRules(locale).select(count);
  } catch {
    // Unknown locale tag — fall through to `other`.
  }
  const chosen = cases.get(category) ?? cases.get('other') ?? '';
  return chosen.replace(/#/g, String(count));
}

export interface I18n {
  locale: Locale;
  t: (key: CatalogKey, vars?: FormatVars) => string;
}

export function createI18n(locale: Locale): I18n {
  return {
    locale,
    t: (key, vars) => format(key, locale, vars),
  };
}
