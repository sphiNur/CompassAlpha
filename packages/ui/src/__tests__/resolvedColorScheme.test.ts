import { describe, expect, test } from 'bun:test';
import { resolvedColorScheme } from '../theme';

// Review MWC-01: the scheme tokens.css's color-scheme and the meta tag name.
describe('resolvedColorScheme', () => {
  test('native follows Telegram or the phone', () => {
    expect(resolvedColorScheme('native', 'dark')).toBe('dark');
    expect(resolvedColorScheme('native', 'light')).toBe('light');
  });
  test('apple is light only, dark always dark', () => {
    expect(resolvedColorScheme('apple', 'dark')).toBe('light');
    expect(resolvedColorScheme('dark', 'light')).toBe('dark');
  });
});
