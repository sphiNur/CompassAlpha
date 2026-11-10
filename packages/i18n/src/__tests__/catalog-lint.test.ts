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
 *  10. Workspace, never organization (D23), and no internal words the copy
 *      review took out (收件箱, 产品, 冻结, 步长, 认领 / 释放 …).
 *  11. No mojibake (â€™ — UTF-8 read as Latin-1) and no ISO dates written
 *      into a sentence (D16: dates follow the interface language).
 *  12. ru: no «(а)» gender shortcuts; say it without the past tense.
 *  13. Words that must not mean two things (DX-COPY-1/2/3): uz «tiklash»
 *      (restore) is never a reset; void / undo / revoke buttons never read
 *      like Cancel; "separate price" is not "store expense".
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

/**
 * The namespaces of permission keys (`delivery.confirm`): the catalog's
 * own permission groups, `permission.group.<prefix>`, which a web test
 * keeps in step with the seeded permissions. A new namespace is covered
 * without a list here; the old list missed attendance, delivery, dishes,
 * prices, org and system (review TEST4-09). `catalog` is kept from it.
 */
const PERMISSION_NAMESPACES: readonly string[] = [
  ...Object.keys(en)
    .filter((key) => key.startsWith('permission.group.'))
    .map((key) => key.slice('permission.group.'.length)),
  'catalog',
];

const DEV_TERMS: Array<{ pattern: RegExp; what: string }> = [
  // The role's display name (Super admin / Суперадмин / Superadmin) is fine;
  // the id and its hyphenated spellings are not.
  { pattern: /super_admin|super-admin|супер-админ|super-administrator/i, what: 'role id' },
  { pattern: /\boutbox\b/i, what: 'table name' },
  { pattern: /db:seed|pnpm |bun run/, what: 'developer command' },
  { pattern: /\bM\d+(?:\.\d+)*[a-z]?\b/, what: 'milestone name' },
  {
    pattern: new RegExp(`\\b(?:${PERMISSION_NAMESPACES.join('|')})s?\\.[a-z_]+\\b`),
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
  // DX-COPY-26 (2026-11-01): the words 19-前端全面诊断/11 still found. A
  // kitchen worker has no server, a ru order is not a «сессия», and a
  // change kept on the phone is "waiting to send", not "to sync".
  { pattern: /привязк/i, what: 'role binding (say назначение)' },
  { pattern: /(?<!\p{L})[Сс]есси/u, what: 'session (say заказ / вход)' },
  { pattern: /\bservers?\b|сервер|服务器|服务端/i, what: 'server (say what happened to the user)' },
  { pattern: /\bsync(?:s|ed|ing)?\b|синхрон|sinxron|同步/i, what: 'sync (say send / 发送)' },
  // Review I18N1-06 (2026-11-10): the transaction words a member transfer
  // explained itself with, and zh's words for session, parameter and
  // cascade. ru «откатить» stays: undoing a purchase is a real action.
  { pattern: /会话/, what: 'session (say 登录)' },
  {
    pattern:
      /事务|原子|回滚|\btransactions?\b|\batomic|\brolls? back\b|\brolled back\b|транзакци|атомарн|tranzaksiya|atomar/i,
    what: 'transaction (say "in one step" / "nothing is changed")',
  },
  { pattern: /入参/, what: 'parameter (say 输入内容)' },
  { pattern: /级联|cascade|каскад|kaskad/i, what: 'cascade (say "deleted with it")' },
];

/** `lang key` prefixes whose screens only developers see. */
const DEV_TERMS_ALLOW_PREFIX: Array<[string, string]> = [
  ['dev.', 'the local-development sign-in screen, never shown in production'],
];

function devTerms(cats: Catalogs): string[] {
  const found: string[] = [];
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(cats[lang])) {
      if (DEV_TERMS_ALLOW_PREFIX.some(([prefix]) => key.startsWith(prefix))) continue;
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
  ru: /^(?:из|с|без|нет|старше|мин|м|ч|дн|дн\.|поз\.|ед\.|шт\.|куп\.|ост\.|тыс\.)$/,
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
    // TEST4-10 (2026-11-10): a full stop, an ellipsis and a single quote
    // written the English way. A dot before a letter or digit is a file
    // name or a number ({month}.xlsx, 1.5), and three are the ellipsis.
    if (/[\u3400-\u9fff]\.(?![A-Za-z0-9.])/u.test(text)) {
      found.push(`zh ${key}: half-width "." in "${value}"`);
    }
    if (/\.{3}/.test(text)) found.push(`zh ${key}: use … instead of ... in "${value}"`);
    if (/'/.test(text)) found.push(`zh ${key}: use 「」 instead of ' in "${value}"`);
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
 * Something outside the catalog is therefore not a 商品: it is 其他物品 /
 * 目录外物品 (full review 2026-11, I18N1-03).
 */
const BANNED_TERMS: Record<Lang, Array<{ pattern: RegExp; use: string }>> = {
  zh: [
    { pattern: /审批/, use: '审核' },
    { pattern: /签收/, use: '验收 / 确认收货' },
    { pattern: /SKU/, use: '商品' },
    { pattern: /买手/, use: '采购员' },
    { pattern: /结算/, use: '日结 (or 计算 for run totals)' },
    { pattern: /其他商品|目录外商品/, use: '其他物品 / 目录外物品' },
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
    // Full review 2026-11 (I18N2-02): the manager has the role's name.
    { pattern: /[Рр]уководител|[Мм]енеджер/, use: 'управляющий (the role «Управляющий»)' },
  ],
  uz: [
    { pattern: /SKU/, use: 'mahsulot' },
    { pattern: /xaridchi/i, use: 'xaridor' },
    { pattern: /taʼminotchi/i, use: 'yetkazib beruvchi' },
    { pattern: /rahbar|menejer/i, use: 'boshqaruvchi (the role «Doʻkon boshqaruvchisi»)' },
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

/**
 * Full review 2026-11 (I18N2-03): D15 keeps approving an order apart from
 * confirming receipt (ru одобрить / подтвердить приёмку, uz maʼqullash /
 * Qabulni tasdiqlash). The review screen's button said «Maʼqullash» while
 * its hints said «tasdiqlang», and the ru admin tile counted approvals as
 * «подтверждения». An order-review string (approval.*) may not say uz
 * tasdiq-; a ru string whose English says approve may not say подтвер-.
 */
function approveIsNotConfirm(cats: Catalogs): string[] {
  const found: string[] = [];
  for (const [key, english] of Object.entries(cats.en)) {
    const uzbek = cats.uz[key] ?? '';
    const russian = cats.ru[key] ?? '';
    if (key.startsWith('approval.') && /tasdiq/i.test(uzbek)) {
      found.push(`uz ${key}: "${uzbek}" — approving an order is maʼqullash`);
    }
    if (/\bapprov/i.test(english) && /подтвер/i.test(russian)) {
      found.push(`ru ${key}: "${russian}" — approving is одобрить`);
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

// ── 10. Words the copy review took out (D23, 18-设计技能评审/03) ──────────

/**
 * 2026-10-31: decision D23 names the tenant 工作区 / workspace / рабочее
 * пространство / ish maydoni in every user-visible string, never 组织 /
 * organization. The copy review also replaced a metaphor the screen never
 * uses (收件箱 / inbox), the one 产品 left after D15, and words that only
 * make sense to whoever wrote the code: a run is not "frozen", an order
 * step is not a "step length", a permission is not "in the dictionary",
 * a run is not per "slot", and a review is not "claimed" and "released".
 * Placeholders ({org}) are code and are not checked.
 *
 * Full review 2026-11: a receipt is 收据 in zh, never 发票 (a tax invoice a
 * market stall cannot give), 票据, 小票 or 凭证 (I18N1-07); en spells
 * cancelled / cancelling one way (I18N1-05).
 */
const COPY_BANNED: Record<Lang, Array<{ pattern: RegExp; use: string }>> = {
  zh: [
    { pattern: /组织/, use: '工作区 (D23)' },
    { pattern: /收件箱/, use: '待审核 / 等你审核的订单' },
    { pattern: /产品/, use: '商品 (D15)' },
    { pattern: /冻结/, use: '已经结束或取消，不能再改' },
    { pattern: /步长/, use: '每次加减' },
    { pattern: /字典/, use: 'say what is missing' },
    { pattern: /时段/, use: 'say what happened' },
    { pattern: /认领/, use: '我来审核 / 接手' },
    { pattern: /释放/, use: '放回' },
    { pattern: /后台自动/, use: '稍后会…' },
    { pattern: /发票|票据|小票|凭证/, use: '收据' },
  ],
  en: [
    { pattern: /\borgs?\b|organi[sz]ation/i, use: 'workspace (D23)' },
    { pattern: /\bcancel(?:ed|ing)\b/i, use: 'cancelled / cancelling' },
    { pattern: /\binbox\b/i, use: 'orders waiting for review' },
    { pattern: /\bfrozen\b/i, use: 'finished or cancelled' },
    { pattern: /\bslot\b/i, use: 'say what happened' },
    { pattern: /\bdictionary\b/i, use: 'say what is missing' },
    { pattern: /\bclaim(?:s|ed|er|ing)?\b/i, use: 'review / take over / put back' },
  ],
  ru: [
    { pattern: /организац/i, use: 'рабочее пространство (D23)' },
    { pattern: /входящ/i, use: 'заказы на проверку' },
    { pattern: /заморож/i, use: 'завершена или отменена' },
    { pattern: /справочник/i, use: 'say what is missing' },
    { pattern: /(?<!\p{L})слот/iu, use: 'say what happened' },
  ],
  uz: [
    { pattern: /tashkilot/i, use: 'ish maydoni (D23)' },
    { pattern: /kiruvchi/i, use: 'tekshiruvni kutayotgan buyurtmalar' },
    { pattern: /muzlat/i, use: 'yakunlangan yoki bekor qilingan' },
    { pattern: /lugʻat/i, use: 'say what is missing' },
  ],
};

/** `lang key` → why the value may keep a word from COPY_BANNED. */
const COPY_BANNED_ALLOW: Record<string, string> = {};

function copyBanned(cats: Catalogs): string[] {
  const found: string[] = [];
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(cats[lang])) {
      if (COPY_BANNED_ALLOW[`${lang} ${key}`]) continue;
      const text = visibleTexts(value)
        .join(' ')
        .replace(/\{\w+\}/g, '');
      for (const { pattern, use } of COPY_BANNED[lang]) {
        const m = text.match(pattern);
        if (m) found.push(`${lang} ${key}: "${m[0]}" — use ${use}`);
      }
    }
  }
  return found;
}

// ── 11. Mojibake and ISO dates ──────────────────────────────────────────

/**
 * DX-COPY-18 / DX-COPY-15 (2026-11-01): "this storeâ€™s personnel" reached
 * English users (UTF-8 decoded as Latin-1 once), and every language taught
 * users to type "2026-10-31". Dates are formatted per language (D16), so a
 * literal ISO date in copy is always wrong.
 */
function mojibakeAndIsoDates(cats: Catalogs): string[] {
  const found: string[] = [];
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(cats[lang])) {
      const m = value.match(/â€|Ã[\u0080-¿]|Â[\u00a0-¿]|�/);
      if (m) found.push(`${lang} ${key}: mojibake "${m[0]}" in ${value}`);
      const d = value.match(/\b\d{4}-\d{2}-\d{2}\b/);
      if (d) found.push(`${lang} ${key}: ISO date "${d[0]}" — dates follow the interface language`);
    }
  }
  return found;
}

// ── 12. ru gender shortcuts ─────────────────────────────────────────────

/**
 * DX-COPY-10 (2026-11-01): «импортировал(а)», «удалён(а)» read as a form
 * being filled in. Name the role instead («участник … удалён») or drop the
 * past tense («отправитель: …»).
 */
function russianGenderShortcuts(cats: Catalogs): string[] {
  return Object.entries(cats.ru)
    .filter(([, v]) => /\p{L}\((?:а|ла|на)\)/u.test(v))
    .map(([k, v]) => `ru ${k}: ${v}`);
}

/**
 * Full review 2026-11 (I18N2-04): the same rule without the shortcut. A
 * woman was marked «Не пришёл» on her own attendance row and had to tap
 * «Согласен». Copy about a person says what happened, not who did it in
 * the masculine: «Неявка», «Своя отметка», «Даю согласие», «Понятно».
 * Generic subjects stay («Кто пришёл», «кто-то изменил», «Закупщик
 * добавил»), so only the forms that stand for a person are listed.
 */
const RU_MASCULINE_PERSON =
  /(?<!\p{L})(?:не пришёл|ушёл на|отметился|согласен|согласился|пропустил|посмотрел|ошибся|нажал|никогда не входил|самому|самого себя)(?!\p{L})/iu;

/** `ru key` → why it may keep a masculine form for now. */
const RU_MASCULINE_ALLOW: Record<string, string> = {
  'ru attendance.sheet.selfAt': 'I18N2-04 follow-up: changes after #253 merges',
  'ru attendance.consent.agree': 'I18N2-04 follow-up: changes after #260 merges',
  'ru attendance.flag.missedShift': 'I18N2-04 follow-up: changes after #260 merges',
  'ru attendance.export.flag.missedShift': 'I18N2-04 follow-up: changes after #260 merges',
};

function russianMasculinePerson(cats: Catalogs): string[] {
  return Object.entries(cats.ru)
    .filter(([k, v]) => !RU_MASCULINE_ALLOW[`ru ${k}`] && RU_MASCULINE_PERSON.test(v))
    .map(([k, v]) => `ru ${k}: ${v}`);
}

// ── 13. Words that must not mean two things ─────────────────────────────

/**
 * I18N2-01 (review, 2026-11-09): "void" is one word in each language, used
 * by attendance and sales alike, and not the word for cancel or delete. A
 * void keeps the record with its reason; the attendance hint says it is
 * "never deleted". uz had «Bekor qilish» (cancel) in attendance and
 * «Oʻchirish» (delete) in sales; ru had «Отмена» in the stock history.
 */
const VOID_WORD: Partial<Record<Lang, string>> = { ru: 'аннулир', uz: 'yaroqsiz', zh: '作废' };

function voidIsOneWord(cats: Catalogs): string[] {
  const found: string[] = [];
  for (const [key, english] of Object.entries(cats.en)) {
    if (!/\bvoid/i.test(english)) continue;
    for (const [lang, word] of Object.entries(VOID_WORD) as Array<[Lang, string]>) {
      const text = cats[lang][key] ?? '';
      if (!text.toLowerCase().includes(word)) {
        found.push(`${lang} ${key}: "${text}" — say «${word}…»`);
      }
    }
  }
  return found;
}

/**
 * DX-COPY-1 (2026-11-01): uz «tiklash» is "restore". It was the label of
 * every reset and wipe button, so "delete today's data" read "restore
 * today". A key whose English says reset / wipe / clear may not use it.
 */
function uzbekResetIsNotRestore(cats: Catalogs): string[] {
  const found: string[] = [];
  for (const [key, english] of Object.entries(cats.en)) {
    if (!/\b(?:reset|wipe|clear)/i.test(english)) continue;
    const uzbek = cats.uz[key] ?? '';
    if (/tikla/i.test(uzbek)) found.push(`uz ${key}: "${uzbek}" — tiklash means restore`);
  }
  return found;
}

/**
 * DX-COPY-2 / DX-COPY-3 (2026-11-01): one translation for two different
 * actions. uz wrote «Bekor qilish» for cancel, void, undo and revoke, so the
 * void-sale sheet had two identical buttons; en / ru / uz named the
 * purchaser's "separate price" exactly like a "store expense". Each pair
 * below sits on the same screen and must read differently in every
 * language.
 */
const MUST_DIFFER: Array<[string, string, string]> = [
  ['sales.void.confirmBtn', 'common.cancel', 'void-sale sheet'],
  ['sales.action.void', 'common.cancel', 'sales row'],
  // I18N2-01 (review, 2026-11-09): attendance came back with the same word
  // as cancel, and sales had moved to the word for delete.
  ['attendance.void.action', 'common.cancel', 'attendance review row'],
  ['attendance.void.confirm', 'common.cancel', 'void-clock-in sheet'],
  ['sales.action.void', 'common.delete', 'sales row'],
  ['run.action.undoPurchase', 'common.cancel', 'undo-purchase sheet'],
  ['approval.undo', 'common.cancel', 'approval undo toast'],
  ['approval.unapprove', 'common.cancel', 'reverse-approval sheet'],
  ['people.revokeInvite', 'common.cancel', 'invite row'],
  ['run.action.addItem.costModeSeparate', 'run.action.addExpense.scopeStore', 'add-item sheet'],
];

function distinctActions(cats: Catalogs): string[] {
  const found: string[] = [];
  for (const lang of LANGS) {
    for (const [a, b, where] of MUST_DIFFER) {
      const va = cats[lang][a];
      const vb = cats[lang][b];
      if (va !== undefined && va === vb) found.push(`${lang} ${a} = ${b} = "${va}" (${where})`);
    }
  }
  return found;
}

/**
 * Full review 2026-11 (I18N1-04, I18N1-05): zh used one word for two
 * things. A cancelled run was 作废 in its notification but 取消 on its
 * button, while 作废 is what voiding a sale or a clock-in says; the people
 * who added items to an order were 提交人, the word for the one person who
 * submitted it. A key whose English names the first may not use the word
 * for the second.
 */
const ZH_KEEPS_APART: Array<{ english: RegExp; zh: RegExp; why: string }> = [
  { english: /\bcancel/i, zh: /作废/, why: '作废 is void; a cancel is 取消' },
  { english: /\bvoid/i, zh: /取消/, why: '取消 is cancel; a void is 作废' },
  { english: /\bcontributor/i, zh: /提交人/, why: '提交人 is the submitter; say 参与人' },
];

function chineseWordsKeepApart(cats: Catalogs): string[] {
  const found: string[] = [];
  for (const [key, english] of Object.entries(cats.en)) {
    const chinese = cats.zh[key] ?? '';
    for (const rule of ZH_KEEPS_APART) {
      if (rule.english.test(english) && rule.zh.test(chinese)) {
        found.push(`zh ${key}: "${chinese}" — ${rule.why}`);
      }
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
  ['ru / uz: approving an order is not confirming', approveIsNotConfirm],
  ['no HTML entities in any language', htmlEntities],
  ['D23 and the copy review: workspace, no internal words', copyBanned],
  ['no mojibake and no ISO dates in copy', mojibakeAndIsoDates],
  ['ru: no «(а)» gender shortcuts', russianGenderShortcuts],
  ['ru: no masculine past tense for a person', russianMasculinePerson],
  ['uz: a reset is not «tiklash» (restore)', uzbekResetIsNotRestore],
  ['void is one word per language, not cancel or delete', voidIsOneWord],
  ['actions on the same screen read differently', distinctActions],
  ['zh: cancel, void and contributor keep their own words', chineseWordsKeepApart],
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
      // TEST4-09: namespaces the hand-written list did not have.
      'Needs delivery.confirm',
      'Only with attendance.manage',
      'Ask for prices.view',
      'Give dishes.manage',
      'org.admin only',
    ]) {
      expect(devTerms(one({ en: bad }))).not.toEqual([]);
    }
    expect(devTerms(one({ en: 'Super admin only · level {rank}' }))).toEqual([]);
  });

  test('TEST4-09: the permission namespaces come from the catalog', () => {
    for (const ns of ['order', 'run', 'attendance', 'delivery', 'dishes', 'prices', 'org']) {
      expect(PERMISSION_NAMESPACES).toContain(ns);
    }
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
    // «(а)» is not a plural; russianGenderShortcuts handles it.
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

  test('D23 workspace and the internal words the copy review removed', () => {
    expect(copyBanned(one({ zh: '这个组织还没有门店' }))).toHaveLength(1);
    expect(copyBanned(one({ zh: '收件箱为空' }))).toHaveLength(1);
    expect(copyBanned(one({ zh: '点击产品旁的 + 号' }))).toHaveLength(1);
    expect(copyBanned(one({ zh: '采购单已冻结' }))).toHaveLength(1);
    expect(copyBanned(one({ zh: '只有认领人可以释放' }))).toHaveLength(2);
    expect(copyBanned(one({ en: 'No stores in this org' }))).toHaveLength(1);
    expect(copyBanned(one({ en: 'Run already exists for this slot' }))).toHaveLength(1);
    expect(copyBanned(one({ en: 'Claimed for review' }))).toHaveLength(1);
    expect(copyBanned(one({ ru: 'В этой организации нет магазинов' }))).toHaveLength(1);
    expect(copyBanned(one({ uz: 'Bu tashkilotda doʻkon yoʻq' }))).toHaveLength(1);
    // A placeholder named {org} is code, not copy.
    expect(copyBanned(one({ en: 'Joined "{org}"', zh: '已加入「{org}」' }))).toEqual([]);
    expect(copyBanned(one({ zh: '工作区', en: 'Workspace', ru: 'Рабочее пространство' }))).toEqual(
      [],
    );
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

  test('TEST4-10: a full stop, an ellipsis and a single quote in Chinese', () => {
    expect(chinesePunctuation(one({ zh: '保存成功.' }))).toHaveLength(1);
    expect(chinesePunctuation(one({ zh: '已发给 {name}.' }))).toHaveLength(1);
    expect(chinesePunctuation(one({ zh: '加载中...' }))).toHaveLength(1);
    expect(chinesePunctuation(one({ zh: "点击'保存'" }))).toHaveLength(1);
    expect(chinesePunctuation(one({ zh: '保存成功。加载中…点击「保存」' }))).toEqual([]);
    expect(chinesePunctuation(one({ zh: '考勤-{store}-{month}.xlsx，约 1.5 公斤' }))).toEqual([]);
  });

  test('еще, curly English apostrophes and untranslated values', () => {
    expect(russianYo(one({ ru: 'и еще {n}' }))).toHaveLength(1);
    expect(englishApostrophes(one({ en: 'A built-in role’s level' }))).toHaveLength(1);
    expect(untranslated(one({ en: 'Import…', uz: 'Import…' }))).toHaveLength(1);
    expect(untranslated(one({ en: 'Shift Lead', zh: 'Shift Lead' }))).toHaveLength(1);
  });

  test('DX-COPY-26: server, sync, session and binding words', () => {
    expect(devTerms(one({ en: 'No answer from the server' }))).toHaveLength(1);
    expect(devTerms(one({ zh: '联网后自动同步' }))).toHaveLength(1);
    expect(devTerms(one({ ru: 'Сессия для этой даты уже существует' }))).toHaveLength(1);
    expect(devTerms(one({ ru: 'Продублировать привязки ролей' }))).toHaveLength(1);
    expect(devTerms(one({ uz: 'sinxronlanishni kutmoqda' }))).toHaveLength(1);
    expect(devTerms(one({ en: 'Saved offline — waiting to send' }))).toEqual([]);
    expect(devTerms(one({ en: 'Only for people on the server allowlist' }, 'dev.x'))).toEqual([]);
  });

  test('I18N1-06: transaction, session, parameter and cascade words', () => {
    expect(devTerms(one({ en: 'Atomic in one transaction:' }))).not.toEqual([]);
    expect(devTerms(one({ en: 'the whole transfer rolls back' }))).toHaveLength(1);
    expect(devTerms(one({ ru: 'Атомарно, в одной транзакции:' }))).toHaveLength(1);
    expect(devTerms(one({ uz: 'Bitta tranzaksiyada atomar bajariladi:' }))).toHaveLength(1);
    expect(devTerms(one({ zh: '会话已过期——请刷新' }))).toHaveLength(1);
    expect(devTerms(one({ zh: '入参' }))).toHaveLength(1);
    expect(devTerms(one({ en: 'see what gets cascade-deleted' }))).toHaveLength(1);
    expect(devTerms(one({ ru: 'посмотрите, что удалится каскадом' }))).toHaveLength(1);
    // Undoing a purchase is a real action in ru.
    expect(devTerms(one({ ru: 'Нельзя откатить — магазин уже принял' }))).toEqual([]);
    expect(devTerms(one({ en: 'All in one step:', zh: '登录已过期——请重新登录' }))).toEqual([]);
  });

  test('DX-COPY-18 / DX-COPY-15: mojibake and ISO dates', () => {
    expect(mojibakeAndIsoDates(one({ en: 'this storeâ€™s personnel' }))).toHaveLength(1);
    expect(mojibakeAndIsoDates(one({ ru: 'Пишите так: 2026-10-31.' }))).toHaveLength(1);
    expect(mojibakeAndIsoDates(one({ en: "this store's employees · {date}" }))).toEqual([]);
  });

  test('DX-COPY-10: ru gender shortcuts', () => {
    expect(russianGenderShortcuts(one({ ru: '{actor} импортировал(а) товары' }))).toHaveLength(1);
    expect(russianGenderShortcuts(one({ ru: '{actor}: участник {member} удалён' }))).toEqual([]);
  });

  test('I18N2-04: ru masculine past tense for a person', () => {
    for (const ru of ['Не пришёл', 'Отметился сам', 'Согласен', 'Посмотрел', 'Нажал по ошибке']) {
      expect(russianMasculinePerson(one({ ru }))).toHaveLength(1);
    }
    for (const ru of ['Неявка', 'Кто пришёл, график смен', 'Остаток ушёл в минус', 'Понятно']) {
      expect(russianMasculinePerson(one({ ru }))).toEqual([]);
    }
  });

  test('DX-COPY-1: uz reset written as restore', () => {
    expect(uzbekResetIsNotRestore(one({ en: 'Reset today', uz: 'Bugunni tiklash' }))).toHaveLength(1);
    expect(uzbekResetIsNotRestore(one({ en: 'Unarchive', uz: 'Tiklash' }))).toEqual([]);
    expect(
      uzbekResetIsNotRestore(one({ en: 'Reset today', uz: 'Bugungi maʼlumotlarni tozalash' })),
    ).toEqual([]);
  });

  test('I18N2-02 / I18N2-03: the manager role name, approve is not confirm', () => {
    expect(terminology(one({ ru: 'Попросите руководителя' }))).toHaveLength(1);
    expect(terminology(one({ ru: 'Менеджер вернул заказ' }))).toHaveLength(1);
    expect(terminology(one({ uz: 'Rahbar izohi' }))).toHaveLength(1);
    expect(terminology(one({ uz: 'doʻkon menejeri' }))).toHaveLength(1);
    expect(terminology(one({ ru: 'Попросите управляющего', uz: 'Boshqaruvchi izohi' }))).toEqual(
      [],
    );
    const approval = (uz: string) => one({ en: 'Approve once seen', uz }, 'approval.x');
    expect(approveIsNotConfirm(approval('Koʻrib chiqqach tasdiqlang.'))).toHaveLength(1);
    expect(approveIsNotConfirm(approval('Koʻrib chiqqach maʼqullang.'))).toEqual([]);
    expect(approveIsNotConfirm(one({ en: 'Confirm', uz: 'Tasdiqlash' }))).toEqual([]);
    expect(approveIsNotConfirm(one({ en: 'Approvals', ru: 'Ожидают подтверждения' }))).toHaveLength(
      1,
    );
    expect(approveIsNotConfirm(one({ en: 'Confirm receipt', ru: 'Подтвердить приёмку' }))).toEqual(
      [],
    );
  });

  test('DX-COPY-2: a void button that reads like Cancel', () => {
    const cats: Catalogs = {
      en: { 'sales.void.confirmBtn': 'Void sale', 'common.cancel': 'Cancel' },
      zh: { 'sales.void.confirmBtn': '确认作废', 'common.cancel': '取消' },
      ru: { 'sales.void.confirmBtn': 'Аннулировать', 'common.cancel': 'Отмена' },
      uz: { 'sales.void.confirmBtn': 'Bekor qilish', 'common.cancel': 'Bekor qilish' },
    };
    expect(distinctActions(cats)).toEqual([
      'uz sales.void.confirmBtn = common.cancel = "Bekor qilish" (void-sale sheet)',
    ]);
  });

  test('CMP-COPY-1: HTML entities are shown as written', () => {
    expect(htmlEntities(one({ uz: 'Yo&apos;qotish' }))).toEqual(['uz k: Yo&apos;qotish']);
    expect(htmlEntities(one({ en: 'Salt &amp; pepper' }))).toHaveLength(1);
    expect(htmlEntities(one({ ru: 'Д&#39;Артаньян' }))).toHaveLength(1);
    expect(htmlEntities(one({ en: 'Salt & pepper; to taste' }))).toEqual([]);
  });

  test('I18N1-03 / 04 / 05 / 07: other items, contributors, cancel and receipts', () => {
    expect(terminology(one({ zh: '+ 添加其他商品' }))).toHaveLength(1);
    expect(terminology(one({ zh: '目录外商品和开销' }))).toHaveLength(1);
    expect(terminology(one({ zh: '为别的商品盘点' }))).toEqual([]);
    expect(copyBanned(one({ zh: '发票（可选）' }))).toHaveLength(1);
    expect(copyBanned(one({ zh: '例如：小票上的单价看错了' }))).toHaveLength(1);
    expect(copyBanned(one({ zh: '收据照片' }))).toEqual([]);
    expect(copyBanned(one({ en: 'Run canceled' }))).toHaveLength(1);
    expect(copyBanned(one({ en: 'Why are you canceling?' }))).toHaveLength(1);
    expect(copyBanned(one({ en: 'Run cancelled · Cancel' }))).toEqual([]);
    expect(chineseWordsKeepApart(one({ en: 'Run cancelled', zh: '采购单已作废' }))).toHaveLength(1);
    expect(chineseWordsKeepApart(one({ en: 'Void sale', zh: '取消销售' }))).toHaveLength(1);
    expect(chineseWordsKeepApart(one({ en: '3 contributors', zh: '3 位提交人' }))).toHaveLength(1);
    expect(chineseWordsKeepApart(one({ en: 'Run cancelled', zh: '采购单已取消' }))).toEqual([]);
    expect(chineseWordsKeepApart(one({ en: 'Rejected', zh: '提交人会看到原因' }))).toEqual([]);
  });
});
