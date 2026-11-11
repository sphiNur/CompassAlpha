/**
 * Tiny ICU-aware i18n runtime.
 *
 * Catalogs are loaded per-locale (see ./catalogs/index.ts): all four,
 * en included, are dynamic imports resolved on demand (M3.14-D,
 * 2026-05-16; en since DX-PFE-2, 2026-11-01). Lookup walks
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
export {
  loadCatalog,
  ensureCatalog,
  preloadCatalog,
  isLoaded,
  isCatalogKey,
  getLoadedCatalog,
} from './catalogs/index';

// Walk order: requested locale → en (when loaded) → other-loaded
// locales in a stable order. The "other loaded" tail is rarely hit
// (only when the active locale's catalog is mid-load and a key is
// missing from en — should be ~never).
const TAIL: Locale[] = ['en', 'ru', 'zh', 'uz'];

/**
 * Each language's name in that language, for language pickers and the
 * "name in <language>" fields. One list so the Uzbek name is spelled with
 * the real oʻ (U+02BB) everywhere — it used to be "O'zbekcha" in three
 * hand-copied lists.
 */
export const LANGUAGE_NATIVE_NAMES: Record<Locale, string> = {
  uz: 'Oʻzbekcha',
  ru: 'Русский',
  en: 'English',
  zh: '中文',
};

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
  template = selectPlurals(template, locale, vars, key);
  return template.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const value = vars[name];
    return value === undefined ? missingVariable(key, name) : String(value ?? '');
  });
}

/**
 * A variable the template names and the call did not pass (review
 * I18N1-24). A screen gets an empty string, as before: "Enter  or more"
 * reads oddly, but nothing breaks for the user. A test run (`bun test`
 * sets NODE_ENV=test) gets an error naming the key, so the call that
 * forgot it fails where it is written instead of passing unnoticed.
 */
function missingVariable(key: string, name: string): string {
  if (inTestRun()) throw new Error(`i18n: ${key} needs {${name}}, and the call passed none.`);
  return '';
}

function inTestRun(): boolean {
  // Through globalThis: the web build has no `process`, and no Node types.
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  return env?.NODE_ENV === 'test';
}

/**
 * How `#` prints a count: the app's one number format (`formatQty` in the
 * web), comma thousands and up to three decimals in every language. It
 * printed `String(count)`, so Russian read "1500 товаров" next to
 * "1,500" everywhere else (review I18N1-24).
 */
const COUNT_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 3 });

/**
 * The number a plural block counts by. A string is read the way the app
 * writes numbers (comma thousands), so a formatted "1,000" counts as 1000;
 * `Number("1,000")` was NaN, and `#` printed "NaN". Missing counts as 0, as
 * before, except in a test run. Text that is not a number at all picks the
 * `other` form and `#` shows the text as it was given.
 */
function pluralCount(
  key: string,
  name: string,
  raw: string | number | undefined,
): { count: number; shown: string } {
  if (raw === undefined) {
    missingVariable(key, name);
    return { count: 0, shown: '0' };
  }
  const count = typeof raw === 'number' ? raw : Number(raw.replace(/,/g, '').trim() || '0');
  if (Number.isFinite(count)) return { count, shown: COUNT_FORMAT.format(count) };
  if (inTestRun()) throw new Error(`i18n: ${key} counts {${name}}, and "${raw}" is not a number.`);
  return { count, shown: String(raw) };
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
 * body is replaced with the count, in the app's number format (1,500). Nested `{var}` in a case body is left for
 * the caller's interpolation pass. `other` is required in practice; if it is
 * missing and nothing matches, the block renders empty rather than throwing.
 *
 * Brace matching is depth-counted (not regex) — that was the original bug.
 */
function selectPlurals(input: string, locale: Locale, vars: FormatVars, key: string): string {
  // Perf (2026-11-05): every t() call came through here and was walked char by
  // char; most strings have no plural block at all.
  if (!input.includes('plural')) return input;
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
      const { count, shown } = pluralCount(key, varName, vars[varName]);
      const body = block.slice(header[0].length, -1);
      out += pickPluralCase(body, count, shown, locale);
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
// Perf (2026-11-05): lists format a plural (unit labels, counts) per row, so
// these ran hundreds of times per render. `new Intl.PluralRules` is costly to
// construct, and a case body never changes once parsed — cache both.
const pluralRulesByLocale = new Map<string, Intl.PluralRules | null>();
function pluralRules(locale: Locale): Intl.PluralRules | null {
  let r = pluralRulesByLocale.get(locale);
  if (r === undefined) {
    try {
      r = new Intl.PluralRules(locale);
    } catch {
      r = null; // Unknown locale tag — callers fall through to `other`.
    }
    pluralRulesByLocale.set(locale, r);
  }
  return r;
}
const parsedPluralBodies = new Map<string, Map<string, string>>();

function pickPluralCase(body: string, count: number, shown: string, locale: Locale): string {
  let cases = parsedPluralBodies.get(body);
  if (!cases) {
    cases = parsePluralCases(body);
    parsedPluralBodies.set(body, cases);
  }
  const exact = cases.get('=' + String(count));
  if (exact !== undefined) return exact.replace(/#/g, shown);
  const category = (Number.isFinite(count) && pluralRules(locale)?.select(count)) || 'other';
  const chosen = cases.get(category) ?? cases.get('other') ?? '';
  return chosen.replace(/#/g, shown);
}

function parsePluralCases(body: string): Map<string, string> {
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
  return cases;
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
