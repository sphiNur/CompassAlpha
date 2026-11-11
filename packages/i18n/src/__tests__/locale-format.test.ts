/**
 * Review TEST4-07 (2026-11): detectLocale picks a new user's language
 * from Telegram's language_code, and format() decides what a missing
 * variable or an unknown key looks like on screen. Neither had a test.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { detectLocale, format, loadCatalog, lookup } from '../index';
import type { CatalogKey } from '../index';

beforeAll(async () => {
  await Promise.all([loadCatalog('en'), loadCatalog('ru')]);
});

describe('detectLocale', () => {
  test('reads the language part of a tag, in any case', () => {
    expect(detectLocale('ru-RU')).toBe('ru');
    expect(detectLocale('uz-Cyrl')).toBe('uz');
    expect(detectLocale('uz')).toBe('uz');
    expect(detectLocale('zh-Hans-CN')).toBe('zh');
    expect(detectLocale('ZH-hant')).toBe('zh');
    expect(detectLocale('EN-us')).toBe('en');
  });

  test('anything else is English', () => {
    for (const tag of [undefined, null, '', 'de', 'kk', 'tr-TR']) {
      expect(detectLocale(tag)).toBe('en');
    }
  });
});

describe('format', () => {
  // Assertions do not quote the copy, so a wording change cannot break them.
  const key = 'attendance.sheet.manualBy' as const; // "{name}" and "{reason}"

  test('fills the variables it is given', () => {
    const out = format(key, 'en', { name: 'Aziza', reason: 'forgot phone' });
    expect(out).toContain('Aziza');
    expect(out).toContain('forgot phone');
    expect(out).not.toContain('{');
  });

  test('a missing variable renders empty, never as "{name}" or "undefined"', () => {
    // As on a screen; a test run throws instead (next test).
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const out = format(key, 'en', { reason: 'forgot phone' });
      expect(out).toContain('forgot phone');
      expect(out).not.toContain('{');
      expect(out).not.toContain('undefined');
    } finally {
      if (before === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before;
    }
  });

  test('in a test run a missing variable throws, naming the key and the variable', () => {
    // Review I18N1-24: "Enter  or more" passed every test unnoticed.
    expect(() => format(key, 'en', { reason: 'forgot phone' })).toThrow(`${key} needs {name}`);
  });

  test('zero is a value, not a missing variable', () => {
    expect(format('attendance.flag.earlyBy', 'en', { m: 0 })).toMatch(/(^|\D)0(\D|$)/);
  });

  test('an unknown key shows the key itself', () => {
    expect(format('no.such.key' as CatalogKey, 'ru')).toBe('no.such.key');
    expect(lookup('no.such.key' as CatalogKey, 'ru')).toBeUndefined();
  });

  test('a loaded language answers in that language', () => {
    const ru = lookup('common.cancel', 'ru');
    const en = lookup('common.cancel', 'en');
    expect(ru).toBeDefined();
    expect(en).toBeDefined();
    expect(ru).not.toBe(en);
  });
});
