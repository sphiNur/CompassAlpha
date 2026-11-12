import { describe, expect, test } from 'bun:test';
import { savedTheme } from '../theme';

/** Review UI-27: blocked storage does not take the app down. */
describe('savedTheme', () => {
  test('the theme saved on the device', () => {
    expect(savedTheme(() => ({ getItem: () => 'dark' }), 'native')).toBe('dark');
    expect(savedTheme(() => ({ getItem: () => 'apple' }), 'native')).toBe('apple');
  });

  test('nothing saved, or something else saved: the default', () => {
    expect(savedTheme(() => ({ getItem: () => null }), 'native')).toBe('native');
    expect(savedTheme(() => ({ getItem: () => 'neon' }), 'native')).toBe('native');
    expect(savedTheme(() => null, 'dark')).toBe('dark');
  });

  test('storage that throws (blocked, disabled) gives the default instead of an error', () => {
    const blocked = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    expect(savedTheme(blocked, 'native')).toBe('native');
    expect(savedTheme(() => ({ getItem: blocked }), 'native')).toBe('native');
  });
});
