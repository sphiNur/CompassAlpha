/**
 * Catalog lint (2026-10-30).
 *
 * WHY THIS EXISTS
 *
 * The copy reviews (docs 12 §九, 14/11-文案) found the same mechanical
 * mistakes in every pass, and new keys kept repeating them: Uzbek written
 * with an ASCII apostrophe (968 places), «2 ЗАЯВОК» and "1 lines" because a
 * count was glued to a fixed noun, `super_admin` / `db:seed` / `M2.0c`
 * shown to store staff, half-width punctuation inside Chinese sentences.
 * Parity checking (same keys in every catalog) cannot see any of that. Each
 * rule below is one of those findings turned into a gate.
 *
 * Every rule has an explicit allow-list. An entry there is a decision, so it
 * carries the reason; add one only when the flagged text is right as written.
 *
 * Rules
 *   1. Every key carries the same placeholders in all four languages.
 *   2. Uzbek uses the official Latin letters: ʻ (U+02BB) in oʻ / gʻ and the
 *      tutuq belgisi ʼ (U+02BC) everywhere else — never ' ‘ ’ or `.
 *   3. No developer vocabulary reaches users (role ids, migration commands,
 *      milestone names, permission keys, table names, "rank").
 *   4. A count followed by a noun goes through the ICU plural mechanism in
 *      en and ru, and a ru plural block names all four CLDR categories
 *      (one / few / many / other). Uzbek nouns do not inflect after a
 *      numeral, so the uz rule is the opposite: no -lar after a count.
 *   5. Chinese uses full-width punctuation ，：？！；（）, quotes 「」 and the
 *      dash —— (11-文案 附 A).
 *   6. Small consistency rules: ru writes ещё with ё; en uses one apostrophe
 *      (ASCII ').
 *   7. A value identical to the English one is a missed translation unless
 *      allow-listed (brand names, unit symbols).
 *
 * The last block feeds each rule a small hand-made catalog with the mistake
 * it exists for, so a rule that silently stops matching fails too.
 */
import { describe, expect, test } from 'bun:test';
import { en } from '../catalogs/en';
import { ru } from '../catalogs/ru';
import { uz } from '../catalogs/uz';
import { zh } from '../catalogs/zh';
import { LANGUAGE_NATIVE_NAMES } from '../index';

type Lang = 'zh' | 'en' | 'ru' | 'uz';
type Catalogs = Record<Lang, Record<string, string>>;
const CATALOGS: Catalogs = { zh, en, ru, uz };
const LANGS: Lang[] = ['zh', 'en', 'ru', 'uz'];

// ── Parsing helpers ─────────────────────────────────────────────────────

interface PluralBlock {
  variable: string;
  cases: Map<string, string>;
}

/** Index just past the brace matching the `{` at `start`, or -1. */
function matchBrace(s: string, start: number): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function parseCases(body: string): Map<string, string> {
  const cases = new Map<string, string>();
  let i = 0;
  while (i < body.length) {
    const open = body.indexOf('{', i);
    if (open < 0) break;
    const end = matchBrace(body, open);
    if (end < 0) break;
    cases.set(body.slice(i, open).trim(), body.slice(open + 1, end - 1));
    i = end;
  }
  return cases;
}

/**
 * Split a value into its plural blocks and the text outside them. Each block
 * is replaced in `outside` by `⟦#⟧`, so a rule that reads the surrounding
 * sentence never mistakes a case body for plain text.
 */
function splitPlurals(value: string): { outside: string; blocks: PluralBlock[] } {
  const blocks: PluralBlock[] = [];
  let outside = '';
  let i = 0;
  while (i < value.length) {
    if (value[i] !== '{') {
      outside += value[i++];
      continue;
    }
    const end = matchBrace(value, i);
    if (end < 0) {
      outside += value.slice(i);
      break;
    }
    const block = value.slice(i, end);
    const header = block.match(/^\{\s*(\w+)\s*,\s*plural\s*,/);
    if (header) {
      blocks.push({
        variable: header[1]!,
        cases: parseCases(block.slice(header[0].length, -1)),
      });
      outside += '⟦#⟧';
    } else {
      outside += block;
    }
    i = end;
  }
  return { outside, blocks };
}

/** Every placeholder name in a value, including plural variables. */
function placeholders(value: string): string[] {
  const names = new Set<string>();
  for (const m of value.matchAll(/\{\s*(\w+)\s*(?:,\s*plural\s*,|\})/g)) names.add(m[1]!);
  return [...names].sort();
}

/** Every piece of literal text the user can see: outside text + case bodies. */
function visibleTexts(value: string): string[] {
  const { outside, blocks } = splitPlurals(value);
  return [outside, ...blocks.flatMap((b) => [...b.cases.values()])];
}

const CJK = /[\u3400-\u9fff]/u;

// ── 1. Placeholders ─────────────────────────────────────────────────────

function placeholderMismatches(cats: Catalogs): string[] {
  const found: string[] = [];
  for (const [key, english] of Object.entries(cats.en)) {
    const want = placeholders(english).join(',');
    for (const lang of LANGS) {
      const got = placeholders(cats[lang][key] ?? '').join(',');
      if (got !== want) found.push(`${lang} ${key}: {${got}} vs en {${want}}`);
    }
  }
  return found;
}

// ── 2. Uzbek apostrophes ────────────────────────────────────────────────

function uzbekApostrophes(cats: Catalogs): string[] {
  const found: string[] = [];
  for (const [key, value] of Object.entries(cats.uz)) {
    for (const text of visibleTexts(value)) {
      for (const m of text.matchAll(/['‘’`ʻʼ]/g)) {
        const want = /[oOgG]/.test(text[m.index! - 1] ?? '') ? 'ʻ' : 'ʼ';
        if (m[0] !== want) {
          const at = text.slice(Math.max(0, m.index! - 8), m.index! + 6);
          found.push(`uz ${key}: "${at}" uses ${JSON.stringify(m[0])}, want ${want}`);
        }
      }
    }
  }
  return found;
}

// ── 3. Developer vocabulary ─────────────────────────────────────────────

const DEV_TERMS: Array<{ pattern: RegExp; what: string }> = [
  // The role's display name (Super admin / Суперадмин / Superadmin) is fine;
  // the id and its hyphenated spellings are not.
  { pattern: /super_admin|super-admin|супер-админ|super-administrator/i, what: 'role id' },
  { pattern: /\boutbox\b/i, what: 'table name' },
  { pattern: /db:seed|pnpm |bun run/, what: 'developer command' },
  { pattern: /\bM\d+(?:\.\d+)*[a-z]?\b/, what: 'milestone name' },
  {
    pattern: /\b(?:users|inventory|sales|reports|catalog|orders?|runs?|settlement)\.[a-z_]+\b/,
    what: 'permission key',
  },
  // The buttons say Allow / Deny (Разрешить / Запретить …); lower-case
  // allow/deny is the stored override value.
  { pattern: /\b(?:allow|deny)\b/, what: 'override value' },
  { pattern: /\bMSA\b|\bslug\b|initData|VITE_/i, what: 'internal identifier' },
  { pattern: /\branks?\b|ранг/i, what: 'role rank (say level / уровень / 等级 / daraja)' },
];

function devTerms(cats: Catalogs): string[] {
  const found: string[] = [];
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(cats[lang])) {
      // Placeholder names ({slug}, {rank}) are code, not copy.
      const text = visibleTexts(value)
        .join(' ')
        .replace(/\{\w+\}/g, '');
      for (const { pattern, what } of DEV_TERMS) {
        const m = text.match(pattern);
        if (m) found.push(`${lang} ${key}: "${m[0]}" (${what})`);
      }
    }
  }
  return found;
}

// ── 4. Plurals ──────────────────────────────────────────────────────────

/** Placeholders that always carry a count. */
const COUNT_VARS = new Set([
  'n',
  'count',
  'days',
  'items',
  'stores',
  'orders',
  'runs',
  'skus',
  'categories',
  'suppliers',
  'members',
  'tables',
  'extras',
  'known',
  'unknown',
  'pending',
  'bought',
  'na',
  'ov',
  'sessions',
  'perms',
]);

/**
 * Words that may follow a bare count without agreeing with it: unit
 * abbreviations, prepositions and (en) participles / adjectives, which do not
 * inflect. Anything else after `{n}` is a noun or a verb that has to agree,
 * so it belongs in a plural block.
 */
const INVARIANT_AFTER_COUNT: Record<'en' | 'ru', RegExp> = {
  en: /^(?:of|min|m|h|d|n\/a|new|selected|skipped|left|more|already|still|bought|priced|unpriced|unknown|unavailable|from|so)$/,
  ru: /^(?:из|с|без|нет|старше|мин|ч|дн|дн\.|поз\.|ед\.|шт\.|куп\.|ост\.)$/,
};

/** `lang key` → why a count followed by a word is right as written. */
const PLURAL_ALLOW: Record<string, string> = {
  'en order.batches.rejectedTitle': '{n} is the batch number, not a count',
  'ru order.batches.rejectedTitle': '{n} is the batch number, not a count',
};

function countsOutsidePlural(cats: Catalogs): string[] {
  const found: string[] = [];
  for (const lang of ['en', 'ru'] as const) {
    for (const [key, value] of Object.entries(cats[lang])) {
      if (PLURAL_ALLOW[`${lang} ${key}`]) continue;
      const { outside } = splitPlurals(value);
      for (const m of outside.matchAll(/\{(\w+)\}(?:[ \u00a0]+|(?=\p{L}))([^\s{}]+)/gu)) {
        const [, variable, word] = m as unknown as [string, string, string];
        if (!COUNT_VARS.has(variable) || !/^\p{L}/u.test(word)) continue;
        const bare = word.replace(/[,;:!?)]+$/, '');
        const invariant = INVARIANT_AFTER_COUNT[lang];
        if (invariant.test(word) || invariant.test(bare)) continue;
        found.push(`${lang} ${key}: "{${variable}} ${word}" outside a plural block`);
      }
    }
  }
  return found;
}

function pluralShortcuts(cats: Catalogs): string[] {
  const found: string[] = [];
  for (const [key, value] of Object.entries(cats.en)) {
    if (/\((?:s|es)\)/.test(value)) found.push(`en ${key}: ${value}`);
  }
  for (const [key, value] of Object.entries(cats.ru)) {
    if (/\p{L}\((?:ов|ей|и|ы|я)\)/u.test(value)) found.push(`ru ${key}: ${value}`);
  }
  return found;
}

/**
 * The CLDR categories each language's plural blocks must name. Exact `=N`
 * cases are extra. ru: 1/21 → one, 2–4 → few, 0/5–20 → many, 1.5 → other.
 */
const REQUIRED_CATEGORIES: Record<Lang, string[]> = {
  en: ['one', 'other'],
  ru: ['one', 'few', 'many', 'other'],
  uz: ['other'],
  zh: ['other'],
};

function pluralCategories(cats: Catalogs): string[] {
  const found: string[] = [];
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(cats[lang])) {
      for (const block of splitPlurals(value).blocks) {
        // en `one` is exactly 1, so `=1` covers it.
        const missing = REQUIRED_CATEGORIES[lang].filter(
          (c) => !block.cases.has(c) && !(lang === 'en' && c === 'one' && block.cases.has('=1')),
        );
        if (missing.length) found.push(`${lang} ${key}: missing ${missing.join(', ')}`);
        for (const [selector, body] of block.cases) {
          // A category case must print the count it was chosen for: ru
          // `one` also matches 21, so a literal 1 would be wrong there.
          if (!selector.startsWith('=') && /\d/.test(body.replace(/\{\w+\}/g, ''))) {
            found.push(`${lang} ${key}: case "${selector}" hardcodes a digit`);
          }
        }
      }
    }
  }
  return found;
}

function uzbekPluralAfterCount(cats: Catalogs): string[] {
  const found: string[] = [];
  for (const [key, value] of Object.entries(cats.uz)) {
    for (const text of visibleTexts(value)) {
      for (const m of text.matchAll(/(?:\{(\w+)\}|#)\s+(?:ta\s+)?(\p{L}+)/gu)) {
        if (m[1] && !COUNT_VARS.has(m[1])) continue;
        if (/lar(?:i|ni|ga|da|dan|ning)?$/u.test(m[2]!)) found.push(`uz ${key}: "${m[0]}"`);
      }
    }
  }
  return found;
}

// ── 5. Chinese punctuation ──────────────────────────────────────────────

/** zh keys whose half-width punctuation is deliberate, with the reason. */
const ZH_PUNCT_ALLOW: Record<string, string> = {};

function chinesePunctuation(cats: Catalogs): string[] {
  const found: string[] = [];
  for (const [key, value] of Object.entries(cats.zh)) {
    if (ZH_PUNCT_ALLOW[key]) continue;
    // A placeholder is filled with arbitrary text, often Chinese, so treat
    // it as a Chinese character for the neighbour test.
    const text = visibleTexts(value)
      .join('\n')
      .replace(/\{\w+\}/g, '中');
    if (!CJK.test(text)) continue;
    for (const m of text.matchAll(/[,:;!?]/g)) {
      const prev = text.slice(0, m.index!).trimEnd().slice(-1);
      const next = text
        .slice(m.index! + 1)
        .trimStart()
        .slice(0, 1);
      if (CJK.test(prev) || CJK.test(next) || /[」）]/.test(prev)) {
        found.push(`zh ${key}: half-width "${m[0]}" in "${value}"`);
      }
    }
    for (const m of text.matchAll(/\(([^()]*)\)/g)) {
      if (CJK.test(m[1]!)) found.push(`zh ${key}: half-width parentheses in "${value}"`);
    }
    if (/["“”]/.test(text)) found.push(`zh ${key}: use 「」 instead of "" / “” in "${value}"`);
    if (/—/.test(text.replace(/——/g, ''))) {
      found.push(`zh ${key}: use —— instead of a single dash in "${value}"`);
    }
  }
  return found;
}

// ── 6. Small consistency rules ──────────────────────────────────────────

function russianYo(cats: Catalogs): string[] {
  return Object.entries(cats.ru)
    .filter(([, v]) => /(?<!\p{L})[еЕ]ще(?!\p{L})/u.test(v))
    .map(([k, v]) => `ru ${k}: ${v}`);
}

function englishApostrophes(cats: Catalogs): string[] {
  return Object.entries(cats.en)
    .filter(([, v]) => /\p{L}[’‘]\p{L}|\p{L}’(?!\p{L})/u.test(v))
    .map(([k, v]) => `en ${k}: ${v}`);
}

// ── 7. Values left in English ───────────────────────────────────────────

/** `lang key` → why the value may equal the English one. */
const SAME_AS_EN_ALLOW: Record<string, string> = {
  'zh settings.profile.username': 'brand name',
  'zh admin.workspace.telegram': 'brand name',
  'ru settings.profile.username': 'brand name',
  'ru admin.workspace.telegram': 'brand name',
  'uz settings.profile.username': 'brand name',
  'uz admin.workspace.telegram': 'brand name',
  'ru confirm.status.ok': '«OK» is the usual Russian status word',
  'uz unit.kg': 'unit symbol',
  'uz unit.ml': 'unit symbol',
};

function untranslated(cats: Catalogs): string[] {
  const found: string[] = [];
  for (const lang of ['zh', 'ru', 'uz'] as const) {
    for (const [key, value] of Object.entries(cats[lang])) {
      if (SAME_AS_EN_ALLOW[`${lang} ${key}`]) continue;
      const words = /\p{L}{2,}/u.test(value.replace(/\{[^}]*\}/g, ''));
      const sameAsEnglish = value === cats.en[key];
      // zh copy without a single Chinese character is English in disguise.
      const latinOnlyZh = lang === 'zh' && !CJK.test(value);
      if (words && (sameAsEnglish || latinOnlyZh)) found.push(`${lang} ${key}: "${value}"`);
    }
  }
  return found;
}

// ── The gates ───────────────────────────────────────────────────────────

const RULES: Array<[string, (cats: Catalogs) => string[]]> = [
  ['every language uses the same placeholders as English', placeholderMismatches],
  ['uz: oʻ / gʻ use U+02BB and the tutuq belgisi U+02BC', uzbekApostrophes],
  ['no developer vocabulary in user copy', devTerms],
  ['en / ru: a count followed by a word goes through a plural block', countsOutsidePlural],
  ['en / ru: no "(s)" / "(ов)" shortcuts', pluralShortcuts],
  ['plural blocks name the CLDR categories each language needs', pluralCategories],
  ['uz: the noun after a count stays singular', uzbekPluralAfterCount],
  ['zh: full-width ，：？！；（）, quotes 「」, dash ——', chinesePunctuation],
  ['ru writes ещё with ё', russianYo],
  ['en uses the ASCII apostrophe throughout', englishApostrophes],
  ['no value is left in English', untranslated],
];

describe('catalog lint', () => {
  for (const [name, rule] of RULES) {
    test(name, () => {
      const found = rule(CATALOGS);
      // Printing the list makes the failure actionable without a debugger.
      expect(found, `\n${found.join('\n')}\n`).toEqual([]);
    });
  }

  test('the language pickers spell Oʻzbekcha with U+02BB', () => {
    // Shown in Settings, the language sheet and the catalog name fields;
    // it used to be "O'zbekcha" in three hand-copied lists.
    expect(LANGUAGE_NATIVE_NAMES.uz).toBe('O\u02bbzbekcha');
    expect(uzbekApostrophes(one({ uz: LANGUAGE_NATIVE_NAMES.uz }))).toEqual([]);
  });
});

// ── The rules catch what they exist for ─────────────────────────────────

/** A one-key catalog set; languages not given copy the English value. */
function one(values: Partial<Record<Lang, string>>, key = 'k'): Catalogs {
  const english = values.en ?? 'Fine';
  return {
    en: { [key]: english },
    zh: { [key]: values.zh ?? '好' },
    ru: { [key]: values.ru ?? 'Хорошо' },
    uz: { [key]: values.uz ?? 'Yaxshi' },
  };
}

describe('catalog lint rules catch the original findings', () => {
  test('a placeholder renamed in one language', () => {
    const cats = one({ en: '{n} items', zh: '{n} 项', ru: '{count} поз.', uz: '{n} ta' });
    expect(placeholderMismatches(cats)).toEqual(['ru k: {count} vs en {n}']);
  });

  test('Uzbek ASCII and curly apostrophes, and ʻ / ʼ swapped', () => {
    expect(uzbekApostrophes(one({ uz: "qo'shish" }))).toHaveLength(1);
    expect(uzbekApostrophes(one({ uz: 'qo‘shish' }))).toHaveLength(1);
    expect(uzbekApostrophes(one({ uz: 'maʻlumot' }))).toHaveLength(1);
    expect(uzbekApostrophes(one({ uz: 'qoʻshish · maʼlumot · bogʻlash' }))).toEqual([]);
  });

  test('role ids, commands, milestones, permission keys and rank', () => {
    for (const bad of [
      'Only super_admin',
      'Run db:seed',
      'so M2.0c can deduct',
      'You need users.manage',
      'outbox rows',
      'Higher rank',
      'allow (force on)',
    ]) {
      expect(devTerms(one({ en: bad }))).not.toEqual([]);
    }
    expect(devTerms(one({ en: 'Super admin only · level {rank}' }))).toEqual([]);
  });

  test('«2 ЗАЯВОК» and "1 lines": a count glued to a noun', () => {
    expect(countsOutsidePlural(one({ ru: '{n} заявок' }))).toHaveLength(1);
    expect(countsOutsidePlural(one({ en: '{n} lines were signed for' }))).toHaveLength(1);
    expect(countsOutsidePlural(one({ en: '{n} selected · {n} min' }))).toEqual([]);
    expect(countsOutsidePlural(one({ en: '{n, plural, one {# order} other {# orders}}' }))).toEqual(
      [],
    );
  });

  test('"(s)" and "(ов)" shortcuts', () => {
    expect(pluralShortcuts(one({ en: '{n} item(s)' }))).toHaveLength(1);
    expect(pluralShortcuts(one({ ru: '{n} заказ(ов)' }))).toHaveLength(1);
    expect(pluralShortcuts(one({ ru: 'импортировал(а)' }))).toEqual([]);
  });

  test('a ru block without many, and a category case with a literal digit', () => {
    const ruBlock = '{n, plural, one {# роль} few {# роли} other {# ролей}}';
    expect(pluralCategories(one({ ru: ruBlock }))).toEqual(['ru k: missing many']);
    expect(pluralCategories(one({ en: '{n, plural, one {1 role} other {# roles}}' }))).toEqual([
      'en k: case "one" hardcodes a digit',
    ]);
  });

  test('Uzbek plural suffix after a count', () => {
    expect(uzbekPluralAfterCount(one({ uz: '{n} ta mahsulotlar' }))).toHaveLength(1);
    expect(uzbekPluralAfterCount(one({ uz: '{n} ta mahsulot' }))).toEqual([]);
  });

  test('half-width punctuation, quotes and single dashes in Chinese', () => {
    expect(chinesePunctuation(one({ zh: '归档「{name}」?' }))).toHaveLength(1);
    expect(chinesePunctuation(one({ zh: '支付方式: 现金' }))).toHaveLength(1);
    expect(chinesePunctuation(one({ zh: '清除测试数据(仅管理员)' }))).toHaveLength(1);
    expect(chinesePunctuation(one({ zh: '点击上方"记录"' }))).toHaveLength(1);
    expect(chinesePunctuation(one({ zh: '保存失败 — 请重试' }))).toHaveLength(1);
    expect(chinesePunctuation(one({ zh: '保存失败——请重试（{n} 项）：好？' }))).toEqual([]);
  });

  test('еще, curly English apostrophes and untranslated values', () => {
    expect(russianYo(one({ ru: 'и еще {n}' }))).toHaveLength(1);
    expect(englishApostrophes(one({ en: 'A built-in role’s level' }))).toHaveLength(1);
    expect(untranslated(one({ en: 'Import…', uz: 'Import…' }))).toHaveLength(1);
    expect(untranslated(one({ en: 'Shift Lead', zh: 'Shift Lead' }))).toHaveLength(1);
  });
});
