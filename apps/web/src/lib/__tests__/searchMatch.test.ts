/**
 * Unit tests for cross-language search matcher (M1.10).
 *
 * Pins the cross-language guarantees so a "let's just lowercase
 * and substring on the en field" simplification can't sneak past
 * the suite.
 */
import { describe, expect, test } from 'bun:test';
import { normalizeQuery, matchesNameLike, matchesAnyString, rankNameLike, rankStrings } from '../searchMatch';

describe('normalizeQuery', () => {
  test('returns null for empty / whitespace-only input', () => {
    expect(normalizeQuery('')).toBeNull();
    expect(normalizeQuery('   ')).toBeNull();
    expect(normalizeQuery('\t\n')).toBeNull();
  });

  test('lowercases + splits on whitespace', () => {
    expect(normalizeQuery('Beef Rib')).toEqual(['beef', 'rib']);
    expect(normalizeQuery('  HELLO  WORLD  ')).toEqual(['hello', 'world']);
  });

  test('normalizes accents and punctuation variants', () => {
    expect(normalizeQuery('Qoʻy go‘shti')).toEqual(['qoy', "go'shti"]);
    expect(normalizeQuery('Crème-Fraîche')).toEqual(['creme-fraiche']);
  });

  test('preserves CJK + Cyrillic as single tokens', () => {
    expect(normalizeQuery('牛肉')).toEqual(['牛肉']);
    expect(normalizeQuery('говядина')).toEqual(['говядина']);
    // Mixed: a Russian cook typing "говядина 1кг".
    expect(normalizeQuery('говядина 1кг')).toEqual(['говядина', '1кг']);
  });

  test('does NOT transliterate — "moloko" stays "moloko"', () => {
    // The user's expectation: if I type Latin, I match Latin. We
    // never magically map "moloko" → "молоко".
    expect(normalizeQuery('moloko')).toEqual(['moloko']);
  });
});

describe('matchesNameLike', () => {
  const beef = {
    names: { en: 'Beef', ru: 'Говядина', uz: "Mol go'shti", zh: '牛肉' },
    code: 'BEEF-1KG',
  };

  test('hits when query matches the en name', () => {
    expect(matchesNameLike(beef, ['beef'])).toBe(true);
  });

  test('hits when query matches a non-locale name (cross-language)', () => {
    expect(matchesNameLike(beef, ['牛肉'])).toBe(true);
    expect(matchesNameLike(beef, ['говядина'])).toBe(true);
    expect(matchesNameLike(beef, ['mol'])).toBe(true);
  });

  test('hits when query matches the code', () => {
    expect(matchesNameLike(beef, ['beef-1kg'])).toBe(true);
    expect(matchesNameLike(beef, ['1kg'])).toBe(true);
  });

  test('fuzzy matches mobile typos in Latin and Cyrillic fields', () => {
    expect(matchesNameLike(beef, ['gohti'])).toBe(true);
    expect(matchesNameLike({ names: { en: 'Tomato', uz: 'Pomidor' } }, ['tomto'])).toBe(true);
    expect(matchesNameLike({ names: { ru: 'Помидор' } }, ['помдор'])).toBe(true);
  });

  test('case-insensitive', () => {
    expect(matchesNameLike(beef, ['BEEF'])).toBe(true);
    expect(matchesNameLike(beef, ['Говядина'.toLowerCase()])).toBe(true);
  });

  test('multi-token AND: every token must hit SOMETHING', () => {
    // "牛肉" hits zh; "1kg" hits code. Both true → match.
    expect(matchesNameLike(beef, ['牛肉', '1kg'])).toBe(true);
    // "牛肉" hits; "Pork" doesn't. Match fails.
    expect(matchesNameLike(beef, ['牛肉', 'pork'])).toBe(false);
  });

  test('empty token array always matches (search inactive)', () => {
    expect(matchesNameLike(beef, [])).toBe(true);
  });

  test('survives missing names / code', () => {
    expect(matchesNameLike({ names: null, code: null }, ['x'])).toBe(false);
    expect(matchesNameLike({ names: { en: 'Salt' } }, ['salt'])).toBe(true);
    expect(matchesNameLike({ code: 'SKU-X' }, ['sku'])).toBe(true);
  });

  test('does NOT cross-transliterate', () => {
    // Typing "govyadina" (Latin) should NOT match Cyrillic "Говядина".
    expect(matchesNameLike(beef, ['govyadina'])).toBe(false);
    // But typing the actual Cyrillic does work.
    expect(matchesNameLike(beef, ['говядина'])).toBe(true);
  });
});

describe('matchesAnyString', () => {
  test('matches against any non-null field', () => {
    expect(matchesAnyString(['Alice Liddell', '@alice'], ['alice'])).toBe(true);
    expect(matchesAnyString(['Bob', null, '@bobby'], ['bobby'])).toBe(true);
    expect(matchesAnyString(['Bob', null], ['carol'])).toBe(false);
  });

  test('multi-token AND across fields', () => {
    // "alice" hits the name; "wonder" hits the username.
    expect(matchesAnyString(['Alice Liddell', '@wonderland'], ['alice', 'wonder'])).toBe(true);
    // "alice" hits; "tea" doesn't.
    expect(matchesAnyString(['Alice Liddell', '@wonderland'], ['alice', 'tea'])).toBe(false);
  });

  test('empty tokens always matches', () => {
    expect(matchesAnyString(['anything'], [])).toBe(true);
  });
});

describe('rankNameLike (2026-11-05)', () => {
  const p = (en: string, extra: Record<string, string> = {}) => ({ names: { en, ...extra }, code: null });
  const get = (x: { names: Record<string, string>; code: null }) => x;
  const rank = (items: ReturnType<typeof p>[], q: string, lang?: string) =>
    rankNameLike(items, normalizeQuery(q), get, lang).map((x) => x.names.en);

  test('exact name first, then prefix, then word-prefix, then contains', () => {
    const items = [p('Instant Yeast Sachet'), p('Dry yeasty mix'), p('Yeast extract'), p('Yeast')];
    expect(rank(items, 'yeast')).toEqual(['Yeast', 'Yeast extract', 'Instant Yeast Sachet', 'Dry yeasty mix']);
  });

  test('shorter name wins a tie, then original order', () => {
    expect(rank([p('Beef Ribs Large'), p('Beef Ribs'), p('Beef Ribs Small')], 'beef ri')).toEqual([
      'Beef Ribs',
      'Beef Ribs Large',
      'Beef Ribs Small',
    ]);
  });

  test("the reader's language breaks ties", () => {
    const a = { names: { en: 'Carrot', uz: 'Sabzi' }, code: null };
    const b = { names: { en: 'Sabzi mix', ru: 'Морковь' }, code: null };
    expect(rankNameLike([b, a], normalizeQuery('sabzi'), get, 'uz')[0]).toBe(a);
  });

  test('typo-only matches are dropped when something matched literally', () => {
    const items = [p('Carrot', { uz: 'Sabzi' }), p('Takeaway Box', { uz: 'Sabzi qutisi' }), p('Salat bowl', { uz: 'Salat idishi' })];
    // "salat" literal hit exists → the "sabzi"-ish typo neighbour stays out.
    expect(rank(items, 'salat')).toEqual(['Salat bowl']);
    // Nothing literal for "sabsi" → typo matches are the answer.
    expect(rank(items, 'sabsi')).toEqual(['Carrot', 'Takeaway Box']);
  });

  test('typos must keep the first letter (keeps unrelated words out)', () => {
    expect(rank([p('Cherry Tomato'), p('Black olives', { ru: 'Чёрные оливки' })], 'черный')).toEqual(['Black olives']);
    expect(matchesNameLike(p('Turkish Tea'), ['turan'])).toBe(false);
  });

  test('swapped neighbours count as one typo; hyphenated words are words', () => {
    expect(matchesNameLike(p('Zet-Brand Napkins'), ['brnad'])).toBe(true);
    expect(matchesNameLike(p('Ice-Cream Bowl'), ['craem'])).toBe(true);
    expect(matchesNameLike(p('Heavy-Duty Degreaser'), ['havy'])).toBe(true);
  });

  test('no tokens returns the list unchanged', () => {
    const items = [p('B'), p('A')];
    expect(rankNameLike(items, null, get)).toBe(items);
  });
});

describe('rankStrings', () => {
  test('ranks plain-string rows the same way', () => {
    const rows = [{ n: 'Green tea' }, { n: 'Tea' }, { n: 'Teapot' }];
    expect(rankStrings(rows, normalizeQuery('tea'), (r) => [r.n]).map((r) => r.n)).toEqual(['Tea', 'Teapot', 'Green tea']);
  });
});
