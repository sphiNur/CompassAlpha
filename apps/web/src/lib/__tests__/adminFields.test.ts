import { describe, expect, test } from 'bun:test';
import {
  codeFromName,
  defaultNewRoleRank,
  normaliseSlugInput,
  readRank,
  roleRankRange,
  slugIsValid,
  tgIdProblem,
} from '../adminFields';

describe('readRank (DX-ADM-4)', () => {
  test('whole numbers from 1 to max pass as typed', () => {
    expect(readRank('45', 79)).toEqual({ ok: true, rank: 45 });
    expect(readRank(' 1 ', 79)).toEqual({ ok: true, rank: 1 });
    expect(readRank('79', 79)).toEqual({ ok: true, rank: 79 });
  });
  test('empty, decimals and out-of-range values are refused, not clamped', () => {
    for (const t of ['', '0', '80', '12.7', '12,7', '-3', 'abc', '1e2']) {
      expect(readRank(t, 79)).toEqual({ ok: false, max: 79 });
    }
  });
});

describe('readRank with a lower bound (ADM1-02)', () => {
  test('values below min are refused like those above max', () => {
    expect(readRank('80', 99, 80)).toEqual({ ok: true, rank: 80 });
    expect(readRank('79', 99, 80)).toEqual({ ok: false, max: 99 });
  });
});

describe('roleRankRange (ADM1-02)', () => {
  test('a role nobody holds may take any level below the actor', () => {
    expect(roleRankRange(70, false, 100, 80)).toEqual({ min: 1, max: 99, locked: false });
    expect(roleRankRange(85, false, 100, 80)).toEqual({ min: 1, max: 99, locked: false });
  });
  test('a held role stays on its side of the admin tier', () => {
    expect(roleRankRange(70, true, 100, 80)).toEqual({ min: 1, max: 79, locked: true });
    expect(roleRankRange(85, true, 100, 80)).toEqual({ min: 80, max: 99, locked: true });
  });
  test('nothing is narrowed when the actor could not cross the tier anyway', () => {
    expect(roleRankRange(30, true, 80, 80)).toEqual({ min: 1, max: 79, locked: false });
    expect(roleRankRange(30, true, 60, 80)).toEqual({ min: 1, max: 59, locked: false });
  });
});

describe('defaultNewRoleRank (DX-ADM-4)', () => {
  test('below the admin tier, also for the super admin', () => {
    expect(defaultNewRoleRank(100, 80)).toBe(70);
    expect(defaultNewRoleRank(80, 80)).toBe(70);
    expect(defaultNewRoleRank(60, 80)).toBe(50);
    expect(defaultNewRoleRank(5, 80)).toBe(1);
  });
});

describe('tgIdProblem (DX-ADM-5)', () => {
  test('a phone number is not an id', () => {
    expect(tgIdProblem('+998 90 123')).toBe('notDigits');
    expect(tgIdProblem('@someone')).toBe('notDigits');
  });
  test('digits need 4–15 of them', () => {
    expect(tgIdProblem('123')).toBe('length');
    expect(tgIdProblem('1234')).toBeNull();
    expect(tgIdProblem('1234567890123456')).toBe('length');
    expect(tgIdProblem('')).toBeNull();
  });
});

describe('role identifier (DX-ADM-4)', () => {
  test('spaces and underscores become hyphens; other letters are reported', () => {
    expect(normaliseSlugInput('Night Shift')).toBe('night-shift');
    expect(normaliseSlugInput('night_shift')).toBe('night-shift');
    expect(slugIsValid(normaliseSlugInput('Night Shift'))).toBe(true);
    expect(slugIsValid(normaliseSlugInput('ночь'))).toBe(false);
  });
});

describe('codeFromName (D2)', () => {
  const none = new Set<string>();
  test('a Latin name becomes a hyphenated code', () => {
    expect(codeFromName(['Night Shift'], none, 'role')).toBe('night-shift');
    expect(codeFromName(['  Sut mahsulotlari! '], none, 'category')).toBe('sut-mahsulotlari');
    expect(codeFromName(['Oʻsimlik yogʻi'], none, 'category')).toBe('osimlik-yogi');
  });
  test('Cyrillic is written in Latin; a name without either falls back', () => {
    expect(codeFromName(['Молочные продукты'], none, 'category')).toBe('molochnye-produkty');
    expect(codeFromName(['蔬菜'], none, 'category')).toBe('category');
    expect(codeFromName(['', null, '蔬菜', 'Vegetables'], none, 'category')).toBe('vegetables');
  });
  test('a code already in use gets the next free number', () => {
    expect(codeFromName(['Dairy'], new Set(['dairy']), 'category')).toBe('dairy-2');
    expect(codeFromName(['Dairy'], new Set(['dairy', 'dairy-2']), 'category')).toBe('dairy-3');
    expect(codeFromName(['蔬菜'], new Set(['category']), 'category')).toBe('category-2');
  });
  test('the result always passes the server rule', () => {
    for (const n of ['Night Shift', 'Молоко 3.2%', '蔬菜', 'Café', '--x--']) {
      expect(slugIsValid(codeFromName([n], none, 'role'))).toBe(true);
    }
  });
});
