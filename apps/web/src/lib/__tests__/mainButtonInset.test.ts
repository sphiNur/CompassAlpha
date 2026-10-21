import { describe, expect, test } from 'bun:test';
import {
  MAIN_BUTTON_INSET_VAR,
  mainButtonInsetValue,
  publishMainButtonInset,
} from '../mainButtonInset';

describe('mainButtonInsetValue', () => {
  test('rounds a measured height up to whole px', () => {
    expect(mainButtonInsetValue(64.5)).toBe('65px');
    expect(mainButtonInsetValue(65)).toBe('65px');
  });

  test('hidden / unmeasured is 0px', () => {
    expect(mainButtonInsetValue(0)).toBe('0px');
    expect(mainButtonInsetValue(null)).toBe('0px');
    expect(mainButtonInsetValue(undefined)).toBe('0px');
    expect(mainButtonInsetValue(Number.NaN)).toBe('0px');
    expect(mainButtonInsetValue(-3)).toBe('0px');
  });
});

describe('publishMainButtonInset', () => {
  test('writes the CSS variable on the given root', () => {
    const set: Record<string, string> = {};
    const root = { style: { setProperty: (k: string, v: string) => void (set[k] = v) } };
    publishMainButtonInset(65, root);
    expect(set[MAIN_BUTTON_INSET_VAR]).toBe('65px');
    publishMainButtonInset(0, root);
    expect(set[MAIN_BUTTON_INSET_VAR]).toBe('0px');
  });

  test('no root (SSR / tests) is a no-op', () => {
    expect(() => publishMainButtonInset(65, null)).not.toThrow();
  });
});
