import { describe, expect, test } from 'bun:test';
import { SHEET_MAX_HEIGHT, TOP_CHROME } from '../components/Sheet';
import { toastOffsetForSheet } from '../components/Toast';

/** Review UI-26: sheets and toasts keep below Telegram's Close / ⋯ row. */
describe('top chrome', () => {
  test("is Telegram's button row where the host measured it, else the safe area", () => {
    expect(TOP_CHROME).toBe('var(--app-chrome-reserve, var(--app-safe-top))');
  });

  test('a short viewport (keyboard up) keeps the sheet top 8 px below it', () => {
    expect(SHEET_MAX_HEIGHT).toBe(
      `min(calc(90dvh - var(--app-safe-top)), calc(var(--app-viewport-h) - ${TOP_CHROME} - 8px))`,
    );
  });

  test('a toast that would reach into the button row goes above the footer instead', () => {
    // Sheet top at 120 px, Telegram's row and the safe area 80 px: 40 px
    // above the sheet do not hold a 48 px stack. Read as 0, they did.
    const sheet = { viewportH: 700, sheetTop: 120, footerTop: 630, stackH: 48 };
    expect(toastOffsetForSheet({ ...sheet, safeTop: 80 })).toBe(700 - 630 + 8);
    expect(toastOffsetForSheet({ ...sheet, safeTop: 0 })).toBe(700 - 120 + 8);
  });
});
