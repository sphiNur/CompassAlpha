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
 * The word lists and allow-lists the rules read are in terms.ts, under the
 * same section numbers. An allow-list entry is a decision, so it carries the
 * reason; add one only when the flagged text is right as written.
 *
 * Rules
 *   1. Every language has the keys English has, no more, and each key
 *      carries the same placeholders in all four languages. Plural is the
 *      only ICU block the formatter reads: no select / selectordinal.
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
 * ../__tests__/catalog-lint.test.ts runs RULES on the four catalogs and
 * feeds each rule a small hand-made catalog with the mistake it exists
 * for, so a rule that silently stops matching fails too. The rules lived in
 * that test file until review TEST4-13 (2026-11-10).
 */
import { CJK, placeholders, splitPlurals, visibleTexts } from './icu';
import { chinesePunctuationErrors, uzbekApostropheErrors } from './text';
import { LANGS, type Catalogs, type Lang } from './langs';
import {
  BANNED_TERMS,
  COPY_BANNED,
  DEV_TERMS,
  DEV_TERMS_ALLOW_PREFIX,
  INVARIANT_AFTER_COUNT,
  MUST_DIFFER,
  PLURAL_ALLOW,
  REQUIRED_CATEGORIES,
  RU_MASCULINE_ALLOW,
  RU_MASCULINE_PERSON,
  SAME_AS_EN_ALLOW,
  TEXT_VARS,
  VOID_WORD,
  ZH_KEEPS_APART,
} from './terms';

// ── 1. Keys and placeholders ────────────────────────────────────────────

/**
 * Review TEST4-11 (2026-11): key parity was left to the type checker, and
 * the placeholder rule below reads only English's keys, so a key missing
 * in one language without a placeholder showed nowhere in the lint.
 */
export function keyParity(cats: Catalogs): string[] {
  const english = new Set(Object.keys(cats.en));
  const found: string[] = [];
  for (const lang of LANGS) {
    const keys = new Set(Object.keys(cats[lang]));
    for (const key of english) if (!keys.has(key)) found.push(`${lang} ${key}: missing`);
    for (const key of keys) if (!english.has(key)) found.push(`${lang} ${key}: not in en`);
  }
  return found;
}

/**
 * Review TEST4-11: the formatter (../index.ts) and this lint read plural
 * blocks only. A select or selectordinal block would be shown as written,
 * and the rules here would read its cases as plain text.
 */
export function unsupportedIcu(cats: Catalogs): string[] {
  const found: string[] = [];
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(cats[lang])) {
      const m = value.match(/\{\s*\w+\s*,\s*(selectordinal|select)\s*,/);
      if (m) found.push(`${lang} ${key}: "${m[1]}" is not supported, only plural`);
    }
  }
  return found;
}

export function placeholderMismatches(cats: Catalogs): string[] {
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

export function uzbekApostrophes(cats: Catalogs): string[] {
  const found: string[] = [];
  for (const [key, value] of Object.entries(cats.uz)) {
    for (const text of visibleTexts(value)) {
      for (const problem of uzbekApostropheErrors(text)) found.push(`uz ${key}: ${problem}`);
    }
  }
  return found;
}

// ── 3. Developer vocabulary ─────────────────────────────────────────────

export function devTerms(cats: Catalogs): string[] {
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

function isCountVar(name: string): boolean {
  return !TEXT_VARS.has(name);
}

export function countsOutsidePlural(cats: Catalogs): string[] {
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

export function pluralShortcuts(cats: Catalogs): string[] {
  const found: string[] = [];
  for (const [key, value] of Object.entries(cats.en)) {
    if (/\((?:s|es)\)/.test(value)) found.push(`en ${key}: ${value}`);
  }
  for (const [key, value] of Object.entries(cats.ru)) {
    if (/\p{L}\((?:ов|ей|и|ы|я)\)/u.test(value)) found.push(`ru ${key}: ${value}`);
  }
  return found;
}

export function pluralCategories(cats: Catalogs): string[] {
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

export function uzbekPluralAfterCount(cats: Catalogs): string[] {
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

export function chinesePunctuation(cats: Catalogs): string[] {
  const found: string[] = [];
  for (const [key, value] of Object.entries(cats.zh)) {
    // A placeholder is filled with arbitrary text, often Chinese, so treat
    // it as a Chinese character for the neighbour test.
    const text = visibleTexts(value)
      .join('\n')
      .replace(/\{\w+\}/g, '中');
    for (const problem of chinesePunctuationErrors(text)) {
      found.push(`zh ${key}: ${problem} in "${value}"`);
    }
  }
  return found;
}

// ── 6. Small consistency rules ──────────────────────────────────────────

export function russianYo(cats: Catalogs): string[] {
  return Object.entries(cats.ru)
    .filter(([, v]) => /(?<!\p{L})[еЕ]ще(?!\p{L})/u.test(v))
    .map(([k, v]) => `ru ${k}: ${v}`);
}

export function englishApostrophes(cats: Catalogs): string[] {
  return Object.entries(cats.en)
    .filter(([, v]) => /\p{L}[’‘]\p{L}|\p{L}’(?!\p{L})/u.test(v))
    .map(([k, v]) => `en ${k}: ${v}`);
}

/** R2-COPY-8 (2026-10-31): en quotes with ASCII "…", uz with «…». */
export function quoteStyle(cats: Catalogs): string[] {
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

export function untranslated(cats: Catalogs): string[] {
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

export function terminology(cats: Catalogs): string[] {
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
export function approveIsNotConfirm(cats: Catalogs): string[] {
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
export function htmlEntities(cats: Catalogs): string[] {
  const found: string[] = [];
  for (const lang of LANGS) {
    for (const [k, v] of Object.entries(cats[lang])) {
      if (/&(?:[a-z][a-z0-9]*|#\d+|#x[0-9a-f]+);/i.test(v)) found.push(`${lang} ${k}: ${v}`);
    }
  }
  return found;
}

// ── 10. Words the copy review took out (D23, 18-设计技能评审/03) ──────────

export function copyBanned(cats: Catalogs): string[] {
  const found: string[] = [];
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(cats[lang])) {
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
export function mojibakeAndIsoDates(cats: Catalogs): string[] {
  const found: string[] = [];
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(cats[lang])) {
      const m = value.match(/â€|Ã[\u0080-¿]|Â[\u00a0-¿]|\uFFFD/);
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
export function russianGenderShortcuts(cats: Catalogs): string[] {
  return Object.entries(cats.ru)
    .filter(([, v]) => /\p{L}\((?:а|ла|на)\)/u.test(v))
    .map(([k, v]) => `ru ${k}: ${v}`);
}

export function russianMasculinePerson(cats: Catalogs): string[] {
  return Object.entries(cats.ru)
    .filter(([k, v]) => !RU_MASCULINE_ALLOW[`ru ${k}`] && RU_MASCULINE_PERSON.test(v))
    .map(([k, v]) => `ru ${k}: ${v}`);
}

// ── 13. Words that must not mean two things ─────────────────────────────

export function voidIsOneWord(cats: Catalogs): string[] {
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
export function uzbekResetIsNotRestore(cats: Catalogs): string[] {
  const found: string[] = [];
  for (const [key, english] of Object.entries(cats.en)) {
    if (!/\b(?:reset|wipe|clear)/i.test(english)) continue;
    const uzbek = cats.uz[key] ?? '';
    if (/tikla/i.test(uzbek)) found.push(`uz ${key}: "${uzbek}" — tiklash means restore`);
  }
  return found;
}

export function distinctActions(cats: Catalogs): string[] {
  const found: string[] = [];
  for (const lang of LANGS) {
    for (const [a, b, where] of MUST_DIFFER) {
      const va = cats[lang][a];
      const vb = cats[lang][b];
      // Review TEST4-11: a pair whose key was renamed used to be skipped,
      // so the rule stopped guarding it without a word.
      for (const [key, value] of [
        [a, va],
        [b, vb],
      ] as const) {
        if (value === undefined) found.push(`${lang} ${key}: missing (MUST_DIFFER, ${where})`);
      }
      if (va !== undefined && va === vb) found.push(`${lang} ${a} = ${b} = "${va}" (${where})`);
    }
  }
  return found;
}

export function chineseWordsKeepApart(cats: Catalogs): string[] {
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

export const RULES: ReadonlyArray<readonly [name: string, rule: (cats: Catalogs) => string[]]> = [
  ['every language has exactly the keys English has', keyParity],
  ['no ICU select / selectordinal: the formatter reads plural only', unsupportedIcu],
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
