/**
 * Unit tests for cross-language search matcher (M1.10).
 *
 * Pins the cross-language guarantees so a "let's just lowercase
 * and substring on the en field" simplification can't sneak past
 * the suite.
 */
import { describe, expect, test } from 'bun:test';
import {
  normalizeQuery,
  matchesNameLike,
  matchesAnyString,
} from '../searchMatch';

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
    expect(matchesNameLike(beef, ["mol"])).toBe(true);
  });

  test('hits when query matches the code', () => {
    expect(matchesNameLike(beef, ['beef-1kg'])).toBe(true);
    expect(matchesNameLike(beef, ['1kg'])).toBe(true);
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
    expect(
      matchesAnyString(['Alice Liddell', '@wonderland'], ['alice', 'wonder']),
    ).toBe(true);
    // "alice" hits; "tea" doesn't.
    expect(
      matchesAnyString(['Alice Liddell', '@wonderland'], ['alice', 'tea']),
    ).toBe(false);
  });

  test('empty tokens always matches', () => {
    expect(matchesAnyString(['anything'], [])).toBe(true);
  });
});
