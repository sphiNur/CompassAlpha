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
 *      (ASCII ') and one quote style (ASCII "); uz quotes with «».
 *   7. A value identical to the English one is a missed translation unless
 *      allow-listed (brand names, unit symbols).
 *   8. The decided terminology (D15, 2026-10-31): one word per concept and
 *      language, so a new key cannot bring back 审批 / SKU / buyer.
 *   9. No HTML entities. React renders catalog values as text, so `&apos;`
 *      reached Uzbek store staff literally on every inventory row.
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

/**
 * Every placeholder name in a value, including plural variables. A case
 * body is plain text, so `one {pair}` names no placeholder `pair`.
 */
function placeholders(value: string): string[] {
  const names = new Set<string>();
  const walk = (text: string) => {
    const { outside, blocks } = splitPlurals(text);
    for (const m of outside.matchAll(/\{\s*(\w+)\s*\}/g)) names.add(m[1]!);
    for (const block of blocks) {
      names.add(block.variable);
      for (const body of block.cases.values()) walk(body);
    }
  };
  walk(value);
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
  // R2-COPY-1 (2026-10-31): the words 11-文案 C8 still found after the
  // first pass. A recipe is a recipe, a date field is a date field.
  { pattern: /\bBOM\b|\bTSV\b|\bKPIs?\b/, what: 'technical abbreviation' },
  { pattern: /YYYY|ГГГГ/, what: 'date format mask' },
  { pattern: /onboarding|онбординг/i, what: 'internal flow name (say first sign-in)' },
  { pattern: /\bbindings?\b|绑定|store-scoped/i, what: 'role binding (say role assignment / per-store)' },
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

/**
 * Placeholders that carry text, money or a date — never a count.
 *
 * R2-COPY-1 (2026-10-31): this used to be the opposite, a fixed list of
 * count names, and every count it did not know slipped through: "{qty}
 * units" rendered "1 units", «{eff} действует» never agreed. Now every
 * placeholder is treated as a count unless it is named here, so a new
 * count is checked from the day it is added. Add a name only for a value
 * that is not a number of things.
 */
const TEXT_VARS = new Set([
  // people and places
  'actor',
  'member',
  'name',
  'who',
  'prev',
  'store',
  'org',
  'role',
  'permission',
  'item',
  'sku',
  'label',
  'tab',
  'status',
  'object',
  'verb',
  'reason',
  'value',
  'slug',
  'locale',
  'language',
  'supplier',
  // money and amounts
  'amount',
  'money',
  'total',
  'currency',
  'price',
  'last',
  'next',
  // dates and times
  'date',
  'time',
  'when',
  'timezone',
  // bounds and positions, not counts: "{min} or more", "21–40 of 87"
  'min',
  'max',
  'from',
  'to',
]);

function isCountVar(name: string): boolean {
  return !TEXT_VARS.has(name);
}

/**
 * Words that may follow a bare count without agreeing with it: unit
 * abbreviations, prepositions and (en) participles / adjectives, which do not
 * inflect. Anything else after `{n}` is a noun or a verb that has to agree,
 * so it belongs in a plural block.
 */
const INVARIANT_AFTER_COUNT: Record<'en' | 'ru', RegExp> = {
  en: /^(?:of|min|m|h|d|n\/a|new|selected|skipped|left|more|already|still|bought|priced|unpriced|unknown|unavailable|from|so|effective|confirmed|or|is|and|to|in|for|by|K)$/,
  ru: /^(?:из|с|без|нет|старше|мин|ч|дн|дн\.|поз\.|ед\.|шт\.|куп\.|ост\.|тыс\.)$/,
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
        if (!isCountVar(variable) || !/^\p{L}/u.test(word)) continue;
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
        // R2-COPY-2 (2026-10-31): ru `one` also matches 21, 31, 101 … A
        // block whose other cases print the count (`#`) must print it in
        // `one` too, or 21 orders read as «Новый заказ» (one order). A
        // block without any `#` only picks a word form for a number shown
        // elsewhere ("10 {пара/пары/пар}") and is fine.
        if (lang === 'ru') {
          const one = block.cases.get('one');
          const printsCount = [...block.cases.values()].some((b) => b.includes('#'));
          if (one !== undefined && printsCount && !one.includes('#')) {
            found.push(`ru ${key}: case "one" does not print the count (#) — it also covers 21`);
          }
        }
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
        if (m[1] && !isCountVar(m[1])) continue;
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

/** R2-COPY-8 (2026-10-31): en quotes with ASCII "…", uz with «…». */
function quoteStyle(cats: Catalogs): string[] {
  return [
    ...Object.entries(cats.en)
      .filter(([, v]) => /[“”]/.test(v))
      .map(([k, v]) => `en ${k}: use ASCII "" instead of “” in ${v}`),
    ...Object.entries(cats.uz)
      .filter(([, v]) => /[“”"]/.test(v))
      .map(([k, v]) => `uz ${k}: use «» in ${v}`),
  ];
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
  'uz nav.short.admin': '«Admin» is the usual Uzbek word too (adminlar); «Boshqaruv» does not fit the nav',
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

// ── 8. Terminology (D15) ────────────────────────────────────────────────

/**
 * The owner's terminology decision D15 (2026-10-31), one word per concept:
 *
 *   concept           zh        en                   ru               uz
 *   order review      审核      review / approve     проверка /       tekshiruv /
 *                                                   одобрить         maʼqullash
 *   receiving         验收      receiving            приёмка          qabul
 *   confirm button    确认收货  Confirm receipt      Подтвердить      Qabulni
 *                                                   приёмку          tasdiqlash
 *   catalog item      商品      product              товар            mahsulot
 *   purchaser         采购员    purchaser            закупщик         xaridor
 *   daily close       日结      daily close          закрытие дня     kun yakuni
 *
 * Each entry is a word that names one of these concepts the other way.
 */
const BANNED_TERMS: Record<Lang, Array<{ pattern: RegExp; use: string }>> = {
  zh: [
    { pattern: /审批/, use: '审核' },
    { pattern: /签收/, use: '验收 / 确认收货' },
    { pattern: /SKU/, use: '商品' },
    { pattern: /买手/, use: '采购员' },
    { pattern: /结算/, use: '日结 (or 计算 for run totals)' },
  ],
  en: [
    { pattern: /\bSKUs?\b/, use: 'product' },
    { pattern: /\bbuyers?\b/i, use: 'purchaser' },
    { pattern: /\bapprovers?\b/i, use: 'reviewer' },
    { pattern: /\bsettlements?\b|re-settle/i, use: 'daily close' },
    { pattern: /\bsigned for\b/i, use: 'received' },
  ],
  ru: [
    { pattern: /SKU/, use: 'товар' },
    { pattern: /[Сс]огласов/, use: 'проверка / одобрить' },
    { pattern: /[Пп]окупател/, use: 'закупщик' },
    { pattern: /[Рр]асч[её]т/, use: 'закрытие дня / разбивка' },
  ],
  uz: [
    { pattern: /SKU/, use: 'mahsulot' },
    { pattern: /xaridchi/i, use: 'xaridor' },
    { pattern: /taʼminotchi/i, use: 'yetkazib beruvchi' },
  ],
};

function terminology(cats: Catalogs): string[] {
  const found: string[] = [];
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(cats[lang])) {
      const text = visibleTexts(value).join(' ');
      for (const { pattern, use } of BANNED_TERMS[lang]) {
        const m = text.match(pattern);
        if (m) found.push(`${lang} ${key}: "${m[0]}" — D15 says ${use}`);
      }
    }
  }
  return found;
}

// ── 9. HTML entities ────────────────────────────────────────────────────

/** CMP-COPY-1 (2026-10-31): `&apos;`, `&amp;`, `&#39;` show up as written. */
function htmlEntities(cats: Catalogs): string[] {
  const found: string[] = [];
  for (const lang of LANGS) {
    for (const [k, v] of Object.entries(cats[lang])) {
      if (/&(?:[a-z][a-z0-9]*|#\d+|#x[0-9a-f]+);/i.test(v)) found.push(`${lang} ${k}: ${v}`);
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
  ['en quotes with "", uz with «»', quoteStyle],
  ['no value is left in English', untranslated],
  ['D15 terminology: one word per concept', terminology],
  ['no HTML entities in any language', htmlEntities],
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

  test('CMP-CAT-3: archiving an expense template does not promise runs skip it', () => {
    // Templates are shortcuts in the expense sheet; nothing is attached to
    // a run automatically, so "future runs will skip it" was not true.
    expect(en['admin.confirm.archiveExpenseTemplate']).not.toMatch(/future runs/i);
    expect(zh['admin.confirm.archiveExpenseTemplate']).not.toContain('自动带入');
    expect(ru['admin.confirm.archiveExpenseTemplate']).not.toContain('пропустят');
    expect(uz['admin.confirm.archiveExpenseTemplate']).not.toContain('qoldirib ketadi');
  });

  test('"remove" (take out of a list) and "delete" are different words', () => {
    // CMP-COPY-1: ru and uz used to write «Удалить» / «Oʻchirish» for both.
    for (const lang of LANGS) {
      expect(CATALOGS[lang]['common.remove'], lang).not.toBe(CATALOGS[lang]['common.delete']);
    }
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
  test('a one-word plural case is text, not a placeholder', () => {
    const cats = one({
      en: '{n, plural, one {pair} other {pairs}}',
      zh: '{n, plural, other {副}}',
      ru: '{n, plural, one {пара} few {пары} many {пар} other {пары}}',
      uz: '{n, plural, other {juft}}',
    });
    expect(placeholderMismatches(cats)).toEqual([]);
  });

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
      'Recipe (BOM)',
      'Copy as TSV',
      'Enter a date (YYYY-MM-DD)',
      'after onboarding',
      'Mirror role bindings',
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

  test('R2-COPY-2: a ru `one` case that drops the count', () => {
    const bad =
      '{n, plural, one {Новый заказ} few {# новых заказа} many {# новых заказов} other {# новых заказа}}';
    expect(pluralCategories(one({ ru: bad }))).toEqual([
      'ru k: case "one" does not print the count (#) — it also covers 21',
    ]);
    // `=1` may drop it; a pure word-form block has no # anywhere.
    const exact =
      '{n, plural, =1 {Новый заказ} one {# новый заказ} few {# новых заказа} many {# новых заказов} other {# новых заказа}}';
    expect(pluralCategories(one({ ru: exact }))).toEqual([]);
    const form = '{n, plural, one {пара} few {пары} many {пар} other {пары}}';
    expect(pluralCategories(one({ ru: form }))).toEqual([]);
  });

  test('R2-COPY-1: a count the old whitelist did not know', () => {
    // {qty} and {eff} were not on the list, so "1 units" passed.
    expect(countsOutsidePlural(one({ en: '{qty} units' }))).toHaveLength(1);
    expect(countsOutsidePlural(one({ ru: '{eff} действует' }))).toHaveLength(1);
    expect(countsOutsidePlural(one({ en: '{name} submitted · {date} closed' }))).toEqual([]);
  });

  test('D15 terminology and quote styles', () => {
    expect(terminology(one({ zh: '撤销审批' }))).toHaveLength(1);
    expect(terminology(one({ en: 'New SKU' }))).toHaveLength(1);
    expect(terminology(one({ ru: 'Нет прав на согласование' }))).toHaveLength(1);
    expect(terminology(one({ uz: 'SKU qidirish' }))).toHaveLength(1);
    expect(terminology(one({ zh: '撤销审核', en: 'New product' }))).toEqual([]);
    expect(quoteStyle(one({ en: 'Joined “{org}”' }))).toHaveLength(1);
    expect(quoteStyle(one({ uz: '“{org}”ga qoʻshiling' }))).toHaveLength(1);
    expect(quoteStyle(one({ en: 'Joined "{org}"', uz: '«{org}»ga qoʻshiling' }))).toEqual([]);
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

  test('CMP-COPY-1: HTML entities are shown as written', () => {
    expect(htmlEntities(one({ uz: 'Yo&apos;qotish' }))).toEqual(['uz k: Yo&apos;qotish']);
    expect(htmlEntities(one({ en: 'Salt &amp; pepper' }))).toHaveLength(1);
    expect(htmlEntities(one({ ru: 'Д&#39;Артаньян' }))).toHaveLength(1);
    expect(htmlEntities(one({ en: 'Salt & pepper; to taste' }))).toEqual([]);
  });
});
