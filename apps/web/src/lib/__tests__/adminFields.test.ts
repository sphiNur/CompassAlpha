import { describe, expect, test } from 'bun:test';
import {
  defaultNewRoleRank,
  normaliseSlugInput,
  readRank,
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
