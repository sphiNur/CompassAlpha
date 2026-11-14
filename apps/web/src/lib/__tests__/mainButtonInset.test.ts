import { describe, expect, test } from 'bun:test';
import {
  MAIN_BUTTON_INSET_VAR,
  mainButtonInsetOf,
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

describe('mainButtonInsetOf (2026-11-14: the button on the nav row)', () => {
  test('on the row it adds nothing above the nav', () => {
    expect(mainButtonInsetOf({ navTop: 700, contentTop: 700, dockBottom: 760 })).toBe(0);
  });

  test('a hint over the row is what reaches above', () => {
    // The hint: 30px and the 8px gap over the row.
    expect(mainButtonInsetOf({ navTop: 700, contentTop: 662, dockBottom: 760 })).toBe(38);
  });

  test('without the nav, from the top of the button (or its hint) to the dock foot', () => {
    expect(mainButtonInsetOf({ navTop: null, contentTop: 704, dockBottom: 772 })).toBe(68);
    expect(mainButtonInsetOf({ navTop: null, contentTop: 666, dockBottom: 772 })).toBe(106);
  });
});
