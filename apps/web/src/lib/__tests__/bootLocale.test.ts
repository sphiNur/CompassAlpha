import { describe, expect, test } from 'bun:test';
import { memoryStorage, throwingStorage } from '../../__tests__/helpers/storage';
import { AUTH_STORAGE_KEY } from '../../stores/authStore';
import { bootLocale } from '../bootLocale';

/** The saved sign-in under its own key; the fake used to answer any key. */
const store = (value: string | null) =>
  memoryStorage(value === null ? {} : { [AUTH_STORAGE_KEY]: value });

describe('bootLocale (DX-PFE-1)', () => {
  test("the saved session's language wins over Telegram's", () => {
    const saved = JSON.stringify({ state: { session: { user: { locale: 'zh' } } } });
    expect(bootLocale(store(saved), 'en-US')).toBe('zh');
  });
  test('a first visit uses the platform language', () => {
    expect(bootLocale(store(null), 'ru-RU')).toBe('ru');
  });
  test('a broken entry or blocked storage falls back to the platform language', () => {
    expect(bootLocale(store('{not json'), 'uz')).toBe('uz');
    expect(bootLocale(throwingStorage(), 'ru')).toBe('ru');
    expect(bootLocale(null, 'en')).toBe('en');
  });
});
