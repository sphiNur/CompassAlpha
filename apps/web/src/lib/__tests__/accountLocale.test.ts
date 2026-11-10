/**
 * COREWEB2-10 (2026-11-09): the language the app draws in once the session
 * is there. The server kept Telegram's raw code (`zh-hans`) as the
 * account's language, and the app read it as a catalog name and drew in
 * English.
 */
import { describe, expect, test } from 'bun:test';
import { accountLocale, bootLocale } from '../bootLocale';

describe('accountLocale', () => {
  test("the account's language, as one of the four", () => {
    expect(accountLocale('zh', 'en-US')).toBe('zh');
    expect(accountLocale('zh-hans', 'en-US')).toBe('zh');
    expect(accountLocale('ru-RU', 'en')).toBe('ru');
    expect(accountLocale('de', 'ru')).toBe('en');
  });

  test("without one, the platform's", () => {
    expect(accountLocale(null, 'uz-UZ')).toBe('uz');
    expect(accountLocale('', 'zh-hant')).toBe('zh');
  });

  test('the first screen reads a saved session the same way', () => {
    const saved = JSON.stringify({ state: { session: { user: { locale: 'zh-hans' } } } });
    expect(bootLocale({ getItem: () => saved }, 'en-US')).toBe('zh');
  });
});
