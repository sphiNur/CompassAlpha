import { describe, expect, test } from 'bun:test';
import { bootLocale, waitAtMost } from '../bootLocale';

const store = (value: string | null) => ({ getItem: () => value });

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
    expect(bootLocale(null, 'en')).toBe('en');
  });
});

describe('waitAtMost', () => {
  test('resolves when the load finishes', async () => {
    let done = false;
    await waitAtMost(Promise.resolve(1), 10_000).then(() => (done = true));
    expect(done).toBe(true);
  });
  test('resolves after the limit when the load hangs, and on failure', async () => {
    await waitAtMost(new Promise(() => {}), 5);
    await waitAtMost(Promise.reject(new Error('offline')), 10_000);
    expect(true).toBe(true);
  });
});
