import { describe, expect, test } from 'bun:test';
import { shouldFollowSheet, toastOffsetForSheet } from '../components/Toast';

describe('toastOffsetForSheet (U11)', () => {
  test('a short sheet: the toasts sit just above it', () => {
    // 844 px viewport, a confirm sheet whose top is at 500 px.
    expect(
      toastOffsetForSheet({ viewportH: 844, sheetTop: 500, footerTop: 760, safeTop: 0, stackH: 48 }),
    ).toBe(844 - 500 + 8);
  });

  test('a tall sheet: no room above, so above its footer, never on its title', () => {
    expect(
      toastOffsetForSheet({ viewportH: 844, sheetTop: 84, footerTop: 770, safeTop: 60, stackH: 48 }),
    ).toBe(844 - 770 + 8);
  });

  test('a tall sheet without a footer: at the bottom of the sheet', () => {
    expect(
      toastOffsetForSheet({ viewportH: 844, sheetTop: 40, footerTop: null, safeTop: 0, stackH: 48 }),
    ).toBe(8);
  });
});

describe('shouldFollowSheet (DX-PFE-6)', () => {
  test('no per-frame follow without an open sheet, even with a sticky toast', () => {
    expect(shouldFollowSheet(true, false)).toBe(false);
    expect(shouldFollowSheet(false, true)).toBe(false);
    expect(shouldFollowSheet(true, true)).toBe(true);
  });
});
